/**
 * News scraper — buscador de Google (pestaña Noticias), navegador real.
 * Antes usábamos el RSS de Google News, pero su <link> es casi siempre una URL
 * de redirect (news.google.com/rss/articles/CBMi...) que a veces no resuelve al
 * artículo real ("link roto"). Scrapeando el buscador directamente obtenemos la
 * URL final tal cual la entrega Google, además de poder ordenar por más reciente.
 */
import { getContext, delay, buildPreciseQuery, parseRelativeDate, isRecent, getBatchReferenceNow } from '../browser.js';
import type { Mention, Comment } from '../types.js';

/** Convierte "YYYY-MM-DD" al formato M/D/YYYY que espera el parámetro cdr: de Google */
function toGoogleDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

async function fetchGoogleSearchNews(keyword: string, days: number, ctx: any, sinceDate?: string, untilDate?: string): Promise<Mention[]> {
  const results: Mention[] = [];
  let page: any;
  try {
    page = await ctx.newPage();
    // Si nos dieron un rango exacto (fechas pasadas, no "hoy"), usamos cdr:1
    // con cd_min/cd_max — mucho más preciso que qdr:y para un mes específico
    // ya viejo (ej. "mayo 2026"). Si no, tbs=qdr:X acota relativo a hoy.
    const isPastRange = sinceDate && untilDate && (Date.now() - new Date(untilDate).getTime()) > 2 * 86400000;
    const tbs = isPastRange
      ? `cdr:1,cd_min:${toGoogleDate(sinceDate!)},cd_max:${toGoogleDate(untilDate!)},sbd:1`
      : `${days <= 1 ? 'qdr:d' : days <= 7 ? 'qdr:w' : days <= 31 ? 'qdr:m' : 'qdr:y'},sbd:1`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&tbm=nws&tbs=${tbs}&hl=es-419&gl=CO&num=20`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#search, #rso, #main', { timeout: 15000 }).catch(() => {});
    await delay(1500);

    const pageTitle: string = await page.title().catch(() => '');
    if (/unusual traffic|tráfico inusual|sistema detectó/i.test(pageTitle)) {
      console.warn('[News/Google] Google mostró verificación anti-bot, sin resultados esta vez');
      await page.close();
      return results;
    }

    const items: { title: string; url: string; time: string }[] = await page.evaluate(() => {
      const out: { title: string; url: string; time: string }[] = [];
      const seen = new Set<string>();
      // "hace X" / "X hours ago" / fecha absoluta ("4 jul 2026" / "Jul 4, 2026") —
      // regex sueltas (no funciones) para evitar el helper __name que tsx/esbuild
      // inyecta para funciones nombradas y que no existe dentro de page.evaluate.
      const TIME_REL = /hace\s+\d+\s+\w+|\b\d+\s*(hora|hour|día|day|semana|week|mes|month|minuto|minute)s?\b(\s+ago)?|\byesterday\b|\bayer\b/i;
      const TIME_ABS_ES = /\b\d{1,2}\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\.?\s+\d{4}\b/i;
      const TIME_ABS_EN = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i;

      // Google cambia sus clases hasheadas entre requests/experimentos — no son
      // fiables (comprobado: la misma búsqueda trae markup distinto entre cargas).
      // En vez de partir del link y adivinar hasta dónde subir, partimos del texto
      // de fecha ("hace X horas/días") — corto, distintivo y siempre presente —
      // y desde ahí buscamos el heading y el link más cercanos hacia arriba.
      // IMPORTANTE: acotado a #search/#rso (el contenedor real de resultados) —
      // sin esto, si Google no tiene noticias y muestra otra cosa en la misma
      // página (carruseles de video, "quizás quiso decir"), se recogía texto
      // con fecha de CUALQUIER lado, sin relación con la búsqueda.
      const root = document.querySelector('#rso') || document.querySelector('#search') || document.body;
      const dateEls: Element[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let cur = walker.nextNode() as Element | null;
      while (cur) {
        const ownText = (cur.textContent || '').trim();
        if (ownText.length > 0 && ownText.length < 40 && cur.children.length === 0 &&
            (TIME_REL.test(ownText) || TIME_ABS_ES.test(ownText) || TIME_ABS_EN.test(ownText))) {
          dateEls.push(cur);
        }
        cur = walker.nextNode() as Element | null;
      }

      for (const dateEl of dateEls) {
        const time = (dateEl.textContent || '').trim();
        let node: Element | null = dateEl;
        let heading: Element | null = null;
        let anchor: HTMLAnchorElement | null = null;
        for (let i = 0; i < 7 && node && (!heading || !anchor); i++) {
          node = node.parentElement;
          if (!node) break;
          if (!heading) heading = node.querySelector('[role="heading"], h3');
          if (!anchor) anchor = node.querySelector('a[href^="http"]');
        }
        const title = heading?.textContent?.trim() || '';
        const href = anchor?.href || '';
        // length >= 20 filtra etiquetas de categoría cortas ("Noticias Mundo") que
        // a veces quedan como el [role="heading"] más cercano en vez del titular real
        if (!title || title.length < 20 || !href || href.includes('google.com') || seen.has(href)) continue;
        seen.add(href);
        out.push({ title, url: href, time });
      }

      return out.slice(0, 20);
    });

    // Relevancia — descarta resultados que no mencionan ninguno de los términos
    // buscados. Sin esto, si Google no encontró noticias reales y la página
    // terminó mostrando otra cosa (sonidos de TikTok, videos, etc.), esos
    // resultados irrelevantes se colaban igual como si fueran "noticias".
    // length >= 2 (no >= 3) — códigos de marca cortos ("D1", "M2") se perdían
    // con el umbral anterior, dejando solo la palabra genérica ("tiendas") como
    // criterio de relevancia y colando resultados que no eran del D1 buscado.
    const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
    const kwTerms = keyword.replace(/"/g, '').toLowerCase()
      .normalize('NFD').replace(DIACRITICS, '')
      .split(/\s+/).filter(w => w.length >= 2);

    // Ancla "ahora" a la fecha real más reciente vista en el scrape (no al
    // reloj de esta máquina) — Google Noticias también entrega fechas ABSOLUTAS
    // ("4 jul 2026"), no solo relativas ("hace 2 días"). Ver getBatchReferenceNow().
    const referenceNow = getBatchReferenceNow(
      items.filter(it => it.time).map(it => parseRelativeDate(it.time))
    );

    let undated = 0;
    for (const item of items) {
      const titleNorm = item.title.toLowerCase().normalize('NFD').replace(DIACRITICS, '');
      const urlNorm = item.url.toLowerCase();
      // Con marca de varias palabras exigimos que aparezcan TODAS — una sola
      // palabra genérica no basta para calificar como relevante.
      const isRelevant = kwTerms.length === 0 || (kwTerms.length > 1
        ? kwTerms.every(w => titleNorm.includes(w) || urlNorm.includes(w))
        : kwTerms.some(w => titleNorm.includes(w) || urlNorm.includes(w)));
      if (!isRelevant) continue;

      if (!item.time) undated++;
      let date = item.time ? parseRelativeDate(item.time) : new Date().toISOString();

      // Si buscamos con rango exacto (cdr:), Google YA garantizó que este
      // artículo cae dentro de [sinceDate, untilDate] — pero el texto relativo
      // que muestra ("hace 1 mes") es aproximado/redondeado, y al convertirlo
      // a fecha absoluta a veces cae unos días fuera del rango real. En vez de
      // descartarlo (perdiendo un artículo que Google mismo confirmó válido),
      // lo recortamos al borde más cercano del rango pedido.
      if (isPastRange) {
        const dms = new Date(date).getTime();
        const sinceMs = new Date(sinceDate!).getTime();
        const untilMs = new Date(untilDate! + 'T23:59:59').getTime();
        if (dms < sinceMs) date = new Date(sinceMs).toISOString();
        else if (dms > untilMs) date = new Date(untilMs).toISOString();
      } else if (!isRecent(date, days, referenceNow)) continue;
      results.push({
        platform: 'noticias',
        author: 'Google Noticias',
        text: item.title,
        url: item.url,
        date,
        tipo: 'articulo',
      } as any);
    }

    console.log(`[News/Google] "${keyword}" → ${results.length} artículos${undated > 0 ? ` (${undated} sin fecha detectada, usando "ahora")` : ''}`);
    await page.close();
  } catch (e: any) {
    console.warn('[News/Google] Error:', e.message?.slice(0, 100));
    try { await page?.close(); } catch { /* ok */ }
  }
  return results;
}

export async function scrapeNews(keyword: string, extraTerms: string[] = [], days = 30, _exclusions?: string[], sinceDate?: string, untilDate?: string): Promise<{
  mentions: Mention[]; comments: Comment[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = []; // Google no expone comentarios — vacío por compatibilidad de tipo

  const ctx = await getContext();
  try {
    // 1. Frase exacta de la marca — la búsqueda más específica primero
    const preciseQuery = buildPreciseQuery(keyword, extraTerms);
    const precise = await fetchGoogleSearchNews(preciseQuery, days, ctx, sinceDate, untilDate);
    for (const m of precise) if (!mentions.some(x => x.url === m.url)) mentions.push(m);

    // 2. Si la frase exacta trajo poco, complementar buscando SOLO el keyword
    //    base — NO cada término extra por separado. Los extras (ej. "Colombia"
    //    agregado para desambiguar una sigla) no son búsquedas válidas por sí
    //    solas: "Colombia" sola trae cualquier noticia del país, sin relación
    //    con la marca. El filtro de contexto en server.ts limpia el resto.
    if (mentions.length < 5 && keyword.toLowerCase() !== preciseQuery.replace(/"/g, '').toLowerCase()) {
      const extra = await fetchGoogleSearchNews(keyword, days, ctx, sinceDate, untilDate);
      for (const m of extra) if (!mentions.some(x => x.url === m.url)) mentions.push(m);
    }
  } finally {
    await ctx.close();
  }

  console.log(`[News] TOTAL: ${mentions.length} artículos (Google Search)`);
  mentions.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  return { mentions, comments };
}
