/**
 * News scraper — buscador de Google (pestaña Noticias), navegador real.
 * Antes usábamos el RSS de Google News, pero su <link> es casi siempre una URL
 * de redirect (news.google.com/rss/articles/CBMi...) que a veces no resuelve al
 * artículo real ("link roto"). Scrapeando el buscador directamente obtenemos la
 * URL final tal cual la entrega Google, además de poder ordenar por más reciente.
 */
import { getContext, delay, buildPreciseQuery, parseRelativeDate, isRecent } from '../browser.js';
import type { Mention, Comment } from '../types.js';

async function fetchGoogleSearchNews(keyword: string, days: number, ctx: any): Promise<Mention[]> {
  const results: Mention[] = [];
  let page: any;
  try {
    page = await ctx.newPage();
    // tbs=qdr:X acota el rango que Google considera; sbd:1 ordena por fecha (más reciente primero)
    const qdr = days <= 1 ? 'qdr:d' : days <= 7 ? 'qdr:w' : days <= 31 ? 'qdr:m' : 'qdr:y';
    const url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&tbm=nws&tbs=${qdr},sbd:1&hl=es-419&gl=CO&num=20`;

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
      const dateEls: Element[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
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

    let undated = 0;
    for (const item of items) {
      if (!item.time) undated++;
      const date = item.time ? parseRelativeDate(item.time) : new Date().toISOString();
      if (!isRecent(date, days)) continue;
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

export async function scrapeNews(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = []; // Google no expone comentarios — vacío por compatibilidad de tipo

  const ctx = await getContext();
  try {
    // 1. Frase exacta de la marca — la búsqueda más específica primero
    const preciseQuery = buildPreciseQuery(keyword, extraTerms);
    const precise = await fetchGoogleSearchNews(preciseQuery, days, ctx);
    for (const m of precise) if (!mentions.some(x => x.url === m.url)) mentions.push(m);

    // 2. Si la frase exacta trajo poco, complementar con términos individuales
    if (mentions.length < 5) {
      const extraTermsPlain = extraTerms
        .map(t => t.replace(/[@#]/g, '').trim())
        .filter(t => t.length >= 3 && t.toLowerCase() !== keyword.toLowerCase());
      const uniqueTerms = [...new Map([keyword, ...extraTermsPlain].map(t => [t.toLowerCase(), t])).values()];
      for (const term of uniqueTerms.slice(0, 3)) {
        if (term.toLowerCase() === preciseQuery.replace(/"/g, '').toLowerCase()) continue;
        const extra = await fetchGoogleSearchNews(term, days, ctx);
        for (const m of extra) if (!mentions.some(x => x.url === m.url)) mentions.push(m);
      }
    }
  } finally {
    await ctx.close();
  }

  console.log(`[News] TOTAL: ${mentions.length} artículos (Google Search)`);
  mentions.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  return { mentions, comments };
}
