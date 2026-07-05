/**
 * Threads (by Meta) — scraper con sesión guardada
 * Usa selectores estables (role, href, dir) — no depende de clases obfuscadas
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay, buildPreciseQuery,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

const parseFC = (raw: string): number => {
  const t = (raw || '').replace(/[^0-9.,KkMm]/g, '').trim();
  if (/[Mm]$/.test(t)) return Math.round(parseFloat(t) * 1_000_000);
  if (/[Kk]$/.test(t)) return Math.round(parseFloat(t) * 1_000);
  return parseInt(t.replace(/[.,]/g, '')) || 0;
};

/** Extrae todos los posts visibles en la página actual (Threads 2025) */
async function extractPosts(page: any): Promise<{
  author: string; authorUrl: string; text: string; url: string; date: string;
}[]> {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Threads 2025: cada post es un div[data-pressable-container]
    // Fallback: article, div[role="article"]
    let containers = Array.from(document.querySelectorAll('[data-pressable-container]'));
    if (containers.length === 0) containers = Array.from(document.querySelectorAll('article, div[role="article"]'));

    for (const el of containers) {
      // Autor: enlace con /@username o /username (threads.com usa rutas sin @)
      const authorLink = (el.querySelector('a[href*="/@"], a[href*="threads.net/@"], a[href*="threads.com/@"]') ||
        el.querySelector('a[href*="/post/"]')) as HTMLAnchorElement | null;
      // Fallback: cualquier <a> que parezca perfil
      const profileLinks = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const profileLink = profileLinks.find(a => {
        const h = a.getAttribute('href') || '';
        return h.match(/^\/@[^/]+$/) || h.match(/^\/[a-zA-Z0-9_.]+$/) && !h.includes('/post/');
      }) || authorLink;
      const author = profileLink?.textContent?.trim() ||
        profileLink?.href?.split('/@')[1]?.split('/')[0] ||
        profileLink?.href?.split('/').filter(Boolean).pop() || '';
      if (!author || author.length > 80 || author.length < 2) continue;
      const rawProfileHref = profileLink?.getAttribute('href') || '';
      const authorUrl = rawProfileHref
        ? (rawProfileHref.startsWith('http') ? rawProfileHref : `https://www.threads.com${rawProfileHref}`)
        : '';

      // Texto: dir="auto" más largo que no sea el autor
      let text = '';
      el.querySelectorAll('span[dir="auto"], div[dir="auto"], p[dir="auto"]').forEach((s: any) => {
        const t = s.textContent?.trim() || '';
        if (t.length > text.length && t !== author && t.length > 5) text = t;
      });
      if (!text || text.length < 5) continue;

      // URL del post
      const postLink = el.querySelector('a[href*="/post/"]') as HTMLAnchorElement | null;
      const rawHref = postLink?.getAttribute('href') || '';
      const url = rawHref
        ? (rawHref.startsWith('http') ? rawHref : `https://www.threads.com${rawHref}`)
        : '';

      // Fecha: <time> o texto con patrón fecha
      const timeEl = el.querySelector('time');
      const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

      const key = text.slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ author, authorUrl, text, url, date });
      }
    }
    return results.slice(0, 60);
  });
}

/** Extrae replies de una página de post individual */
async function extractReplies(page: any, mainText: string): Promise<{
  author: string; text: string; date: string;
}[]> {
  return page.evaluate((mainSnippet: string) => {
    const results: { author: string; text: string; date: string }[] = [];
    const seen = new Set<string>();
    let containers = Array.from(document.querySelectorAll('[data-pressable-container]'));
    if (containers.length === 0) containers = Array.from(document.querySelectorAll('article, div[role="article"]'));
    let skippedMain = false;

    for (const el of containers) {
      const elText = el.textContent?.trim() || '';
      if (!skippedMain && mainSnippet && elText.includes(mainSnippet.slice(0, 20))) {
        skippedMain = true;
        continue;
      }
      skippedMain = true;

      const authorLink = el.querySelector('a[href*="/@"]') as HTMLAnchorElement | null;
      const author = authorLink?.textContent?.trim() || authorLink?.href?.split('/@')[1]?.split('/')[0] || 'Usuario';

      let text = '';
      el.querySelectorAll('span[dir="auto"], div[dir="auto"], p[dir="auto"]').forEach(s => {
        const t = s.textContent?.trim() || '';
        if (t.length > text.length && t !== author) text = t;
      });
      if (!text || text.length < 5) continue;

      const timeEl = el.querySelector('time');
      const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

      const key = text.slice(0, 35);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ author, text, date });
      }
    }
    return results.slice(0, 50);
  }, mainText);
}

export async function scrapeThreads(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];

  if (!hasAuth('threads')) {
    console.warn('[Threads] Sin sesión guardada. Corre: npm run setup → threads');
    return { mentions, comments, etiquetados };
  }

  const ctx = await getContext('threads');
  const preciseQuery = buildPreciseQuery(keyword, extraTerms);

  try {
    const page = await ctx.newPage();
    console.log(`[Threads] Buscando "${preciseQuery}"...`);

    // threads.com (nuevo dominio). filter=recent = pestaña "Recientes"
    // URL confirmada: threads.com/search?q=keyword&serp_type=default&filter=recent
    const searchUrls = [
      `https://www.threads.com/search?q=${encodeURIComponent(preciseQuery)}&serp_type=default&filter=recent`,
      `https://www.threads.com/search?q=${encodeURIComponent(preciseQuery)}&serp_type=default`,
      `https://www.threads.com/search?q=${encodeURIComponent(preciseQuery)}`,
    ];

    let loaded = false;
    for (const url of searchUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 70000 });
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        await delay(4000);

        // Si aún no cargó "Recientes", intentar clic en el tab por texto
        const currentUrl = page.url();
        if (!currentUrl.includes('filter=recent')) {
          try {
            // Los tabs "Destacado" / "Recientes" / "Perfiles" son spans/divs con texto
            const allEls = await page.$$('span, div, a, button');
            for (const el of allEls) {
              const txt = (await el.textContent().catch(() => '')).trim();
              if (txt === 'Recientes' || txt === 'Recent') {
                await el.click();
                console.log('[Threads] Clic en tab "Recientes"');
                await delay(3000);
                break;
              }
            }
          } catch { /* ok */ }
        }

        const count: number = await page.evaluate(() =>
          document.querySelectorAll('[data-pressable-container], article, div[role="article"]').length
        );

        if (count > 0) {
          console.log(`[Threads] ${count} posts iniciales (URL: ${page.url().split('?')[1] || 'base'})`);
          loaded = true;
          break;
        }
        console.warn(`[Threads] 0 posts — probando siguiente URL`);
        await delay(2000);
      } catch { /* reintentar */ }
    }

    if (!loaded) {
      console.warn('[Threads] No cargó resultados de búsqueda');
      await page.close();
      return { mentions, comments, etiquetados };
    }

    // serp_type=recent ya aplicado via URL — no hay tab "Recientes" en threads.com 2025
    // El botón "Filtro" permite filtrar por fecha (Después del / Antes del) y perfil

    // Clic inicial para dar foco a la página antes de scrollear
    await page.mouse.click(600, 400).catch(() => {});
    await delay(500);

    // Extracción incremental — Threads virtualiza el DOM igual que LinkedIn.
    // Los primeros posts (más recientes) desaparecen del DOM al scrollear.
    // Capturar en cada pasada antes de que se virtualicen.
    const accumulated = new Map<string, { author: string; authorUrl: string; text: string; url: string; date: string }>();
    const screenshotMap = new Map<string, string>();

    // Captura miniaturas de los contenedores visibles en el viewport actual
    const captureVisibleScreenshots = async () => {
      try {
        const visibleEls = await page.$$('[data-pressable-container]');
        for (const el of visibleEls.slice(0, 6)) {
          try {
            const key = await el.evaluate((e: Element) => {
              let text = '';
              e.querySelectorAll('span[dir="auto"], div[dir="auto"], p[dir="auto"]').forEach((s: any) => {
                const t = s.textContent?.trim() || '';
                if (t.length > text.length && t.length > 5) text = t;
              });
              return text.slice(0, 50);
            });
            if (key && !screenshotMap.has(key)) {
              const shot = await takeScreenshot(el, 'th_post');
              if (shot) screenshotMap.set(key, shot);
            }
          } catch {}
        }
      } catch {}
    };

    // Primera extracción antes de cualquier scroll — captura los posts iniciales (más recientes)
    const initialBatch = await extractPosts(page);
    for (const p of initialBatch) {
      const key = p.text.slice(0, 50);
      if (!accumulated.has(key)) accumulated.set(key, p);
    }
    await captureVisibleScreenshots();
    console.log(`[Threads] ${accumulated.size} posts iniciales (antes de scroll)`);

    for (let s = 0; s < 60; s++) {
      await page.mouse.wheel(0, 750);
      await delay(900);
      // Extraer en cada pasada — captura todo lo visible antes de que se virtualice
      const batch = await extractPosts(page);
      for (const p of batch) {
        const key = p.text.slice(0, 50);
        if (!accumulated.has(key)) accumulated.set(key, p);
      }
      // Capturar miniaturas cada 3 pasadas antes de que el DOM virtualice los posts
      if (s % 3 === 0) await captureVisibleScreenshots();
    }

    let posts = [...accumulated.values()];
    console.log(`[Threads] ${posts.length} posts encontrados (acumulados durante scroll)`);

    if (posts.length < 3) {
      for (let s = 0; s < 10; s++) {
        await page.mouse.wheel(0, 1000);
        await delay(1500);
        const batch = await extractPosts(page);
        for (const p of batch) {
          const key = p.text.slice(0, 50);
          if (!accumulated.has(key)) accumulated.set(key, p);
        }
      }
      posts = [...accumulated.values()];
      console.log(`[Threads] Tras scroll extra: ${posts.length} posts`);
    }

    if (posts.length === 0) {
      console.warn('[Threads] 0 posts tras todos los intentos');
      await page.close();
      return { mentions, comments, etiquetados };
    }

    // Captura final de lo que quede visible en DOM
    await captureVisibleScreenshots();

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const isoDate = parseRelativeDate(post.date);
      if (!isRecent(isoDate, days >= 1 ? Math.max(days, 30) : days)) continue;

      const shot = screenshotMap.get(post.text.slice(0, 50));

      const item: any = {
        platform: 'threads',
        author: post.author,
        text: post.text.slice(0, 600),
        url: post.url || `https://www.threads.com/search?q=${encodeURIComponent(preciseQuery)}`,
        date: isoDate,
        tipo: 'post',
        screenshot: shot,
      };

      // Seguidores — solo primeros 3 para no tardar mucho
      if (post.authorUrl && (post.authorUrl.includes('threads.com') || post.authorUrl.includes('threads.net')) && i < 3) {
        try {
          const profPage = await ctx.newPage();
          await profPage.goto(post.authorUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await delay(2000);
          const followersRaw = await profPage.evaluate(() => {
            const all = Array.from(document.querySelectorAll('span, p, div'));
            for (const el of all) {
              const t = el.textContent?.trim() || '';
              const m = t.match(/^([\d.,]+[KkMm]?)\s*(follower|seguidor)/i);
              if (m) return m[1];
              if (/(follower|seguidor)/i.test(t) && t.length < 30) {
                const num = t.match(/([\d.,]+[KkMm]?)/i);
                if (num) return num[1];
              }
            }
            return null;
          });
          if (followersRaw) {
            const fc = parseFC(followersRaw);
            if (fc > 0) { item.follower_count = fc; item.is_influencer = fc >= 5000; }
          }
          await profPage.close();
          await delay(600);
        } catch { /* skip */ }
      }

      mentions.push(item);

      // Tags y hashtags
      const tags = post.text.match(/@[\w\u00C0-\u024F.]+/g) || [];
      for (const tag of tags) {
        if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5))))
          etiquetados.push({ platform: 'threads', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'mencion' });
      }
      const hashes = post.text.match(/#[\w\u00C0-\u024F]+/g) || [];
      for (const ht of hashes) {
        if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5))))
          etiquetados.push({ platform: 'threads', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'hashtag' });
      }

      // NO abrir posts individuales — Threads casi no tiene replies, priorizar volumen de posts

      await humanDelay(800, 1500);
    }

    await page.close();
  } catch (e: any) {
    console.error('[Threads] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  // Ordenar por fecha más reciente primero
  mentions.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  console.log(`[Threads] TOTAL: ${mentions.length}m ${comments.length}c ${etiquetados.length}e`);
  return { mentions, comments, etiquetados };
}
