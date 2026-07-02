/**
 * News scraper — Google News RSS (primario) + sitios colombianos (secundario)
 * Fuentes: El Tiempo, El Espectador, Semana, Portafolio, La República, RCN, Caracol, Infobae
 */
import { getContext, getBrowser, humanDelay, humanScroll, takeScreenshot, scrollToLoadComments, waitForComments } from '../browser.js';
import type { Mention, Comment } from '../types.js';

// ─── Normalizar texto (quita tildes) ─────────────────────────────────────────
const norm = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ─── Google News RSS ──────────────────────────────────────────────────────────
async function fetchGoogleNewsRSS(keyword: string, days = 30): Promise<Mention[]> {
  const results: Mention[] = [];
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=es-419&gl=CO&ceid=CO:es`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.warn('[News/GNews] HTTP', res.status); return results; }

    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const title   = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/s.exec(item)?.[1] || /<title>(.*?)<\/title>/s.exec(item)?.[1] || '').trim();
      // Google News RSS: URL real viene en <guid> o en <link> después del tag de canal
      const link    = (/<guid[^>]*>(.*?)<\/guid>/.exec(item)?.[1] || /<link>(.*?)<\/link>/.exec(item)?.[1] || '').trim();
      const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(item)?.[1] || '').trim();
      const source  = (/<source[^>]*>(.*?)<\/source>/.exec(item)?.[1] || 'Medios').trim();
      const desc    = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(item)?.[1] || /<description>([\s\S]*?)<\/description>/.exec(item)?.[1] || '').replace(/<[^>]+>/g, '').trim();

      if (!title) continue;

      // Filtrar por fecha — si no tiene fecha la incluimos (confiamos en Google)
      const articleDate = pubDate ? new Date(pubDate).getTime() : 0;
      if (articleDate > 0 && articleDate < cutoff) continue;

      // NO hacemos re-check de relevancia: Google ya filtró por keyword al buscar
      const text = desc ? `${title}\n\n${desc.slice(0, 300)}` : title;
      const finalUrl = link || `https://news.google.com/search?q=${encodeURIComponent(keyword)}`;
      results.push({
        platform: 'noticias',
        author: source,
        text,
        url: finalUrl,
        date: articleDate > 0 ? new Date(articleDate).toISOString() : new Date().toISOString(),
        tipo: 'articulo',
      } as any);
    }

    console.log(`[News/GNews] "${keyword}" → ${results.length} artículos (${days}d)`);
  } catch (e: any) {
    console.warn('[News/GNews] Error:', e.message?.slice(0, 80));
  }
  return results;
}

// ─── Sitios colombianos (selectores actualizados 2025) ───────────────────────
const NEWS_SITES = [
  {
    name: 'El Tiempo',
    search: (kw: string) => `https://www.eltiempo.com/buscar/${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="eltiempo.com/"], h2 a, h3 a, article a, .c-article__link',
    titleSelector: 'h1, .c-article__title',
    commentSelector: '.vf-comment__body, [class*="vf-comment"] p, .viafoura [class*="comment-body"]',
    authorSelector: '.vf-comment-head__author, [class*="comment-author"]',
    commentTrigger: '.vf-icon-button, button[aria-label*="comentar"], [class*="comments-button"]',
  },
  {
    name: 'El Espectador',
    search: (kw: string) => `https://www.elespectador.com/search/?query=${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="elespectador.com/"], article a, h2 a, h3 a, [class*="Card"] a, [class*="card"] a, [class*="article"] a',
    titleSelector: 'h1, [class*="ArticleTitle"], [class*="article-title"]',
    commentSelector: '.comment-body, [class*="CommentBody"], .comment-text, [class*="comment-content"], [class*="CommentContent"]',
    authorSelector: '.comment-author, [class*="CommentAuthor"], [class*="comment-author"]',
    commentTrigger: 'button[class*="comment"], [aria-label*="comentarios"], [class*="CommentsButton"]',
  },
  {
    name: 'Semana',
    search: (kw: string) => `https://www.semana.com/buscador/?q=${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="semana.com/"], article a, h2 a, h3 a, [class*="article"] a, [class*="news"] a, [class*="card"] a',
    titleSelector: 'h1, [class*="article-title"], [class*="ArticleTitle"]',
    commentSelector: '[class*="comment"] p, .comment-content, [class*="CommentText"], [class*="comment-body"]',
    authorSelector: '[class*="comment-author"], [class*="CommentAuthor"]',
    commentTrigger: 'button[class*="comment"], [class*="comments"], [aria-label*="comentario"]',
  },
  {
    name: 'Portafolio',
    search: (kw: string) => `https://www.portafolio.co/buscar?q=${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="portafolio.co/"], article a, h2 a, h3 a, [class*="article-card"] a, [class*="news"] a',
    titleSelector: 'h1, [class*="article-title"]',
    commentSelector: '.vf-comment__body, [class*="comment-body"], .comment-text, [class*="vf-comment"] p',
    authorSelector: '.vf-comment-head__author, .comment-author',
    commentTrigger: '[class*="comments-button"], button[class*="comment"], [class*="vf-"]',
  },
  {
    name: 'La República',
    search: (kw: string) => `https://www.larepublica.co/buscar?query=${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="larepublica.co/"], article a, h2 a, h3 a, [class*="news-card"] a, [class*="article"] a',
    titleSelector: 'h1, [class*="article-title"], [class*="titulo"]',
    commentSelector: '.comment-content, [class*="comment-body"], [class*="CommentBody"]',
    authorSelector: '[class*="comment-author"]',
    commentTrigger: 'button[class*="comment"]',
  },
  {
    name: 'Infobae Colombia',
    search: (kw: string) => `https://www.infobae.com/buscar/?q=${encodeURIComponent(kw)}`,
    articleSelector: 'a[href*="infobae.com/"], a[href*="/colombia/"], a[href*="/america/"], .article-card a, h2 a, h3 a',
    titleSelector: 'h1, [class*="article-title"]',
    commentSelector: '.vf-comment__body, [class*="vf-comment"] p, .comment-body',
    authorSelector: '.vf-comment-head__author, .comment-author',
    commentTrigger: '[class*="comments-trigger"], button[class*="vf"]',
  },
];

const isClosed = (e: any) => typeof e?.message === 'string' &&
  (e.message.includes('has been closed') || e.message.includes('Target closed') || e.message.includes('browser has been disconnected'));

export async function scrapeNews(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];

  // ── 1. Google News RSS — fuente primaria, sin browser, muy confiable ──────
  // Construir query combinada con todos los términos relevantes (OR entre ellos)
  const allTermsStripped = [
    keyword,
    ...extraTerms
      .map(t => t.replace(/[@#]/g, '').trim())
      .filter(t => t.length >= 3 && t.toLowerCase() !== keyword.toLowerCase()),
  ];
  // Deduplica términos ignorando mayúsculas
  const uniqueTerms = [...new Map(allTermsStripped.map(t => [t.toLowerCase(), t])).values()];

  // 1a. Query combinada OR (ej: "corferias OR coferiasbogota OR gran salon de corferias")
  if (uniqueTerms.length > 1) {
    const combinedQuery = uniqueTerms.map(t => t.includes(' ') ? `"${t}"` : t).join(' OR ');
    const combined = await fetchGoogleNewsRSS(combinedQuery, days);
    for (const m of combined) {
      if (!mentions.some(x => x.url === m.url)) mentions.push(m);
    }
  }

  // 1b. Búsqueda individual por cada término (captura lo que la query OR puede perder)
  for (const term of uniqueTerms.slice(0, 4)) {
    const extra = await fetchGoogleNewsRSS(term, days);
    for (const m of extra) {
      if (!mentions.some(x => x.url === m.url)) mentions.push(m);
    }
  }

  console.log(`[News/GNews] Total artículos Google News: ${mentions.length}`);

  // ── 2. Sitios individuales con Playwright ─────────────────────────────────
  let ctx = await getContext();

  try {
    for (const site of NEWS_SITES) {
      try {
        const browser = await getBrowser();
        if (!browser.isConnected()) { ctx = await getContext(); }
      } catch { ctx = await getContext(); }

      let page: any;
      try { page = await ctx.newPage(); }
      catch (e: any) {
        if (isClosed(e)) { ctx = await getContext(); page = await ctx.newPage(); }
        else throw e;
      }

      try {
        console.log(`[News] Buscando en ${site.name}...`);
        await page.goto(site.search(keyword), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        // Sitios con JS pesado (El Espectador, Semana) necesitan más tiempo para renderizar resultados
        const isHeavyJS = ['El Espectador', 'Semana'].includes(site.name);
        if (isHeavyJS) {
          await humanDelay(4000, 6000);
          // Scroll para disparar lazy loading de resultados
          for (let i = 0; i < 4; i++) {
            await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
            await humanDelay(800, 1200);
          }
          await humanDelay(2000, 3000);
        } else {
          await humanDelay(1500, 3000);
        }

        // Extraer links de artículos
        const origin = new URL(site.search(keyword)).origin;
        let articleLinks: string[] = await page.evaluate(({ selector, baseOrigin }: { selector: string; baseOrigin: string }) => {
          const links: string[] = [];
          const seen = new Set<string>();
          document.querySelectorAll(selector).forEach(el => {
            const href = (el as HTMLAnchorElement).href || '';
            if (!href) return;
            // Aceptar links del mismo dominio o links absolutos al sitio
            const BAD_PATHS = [
              '/search', '/buscador', '/tag/', '/autor/', '/categoria/', '/seccion/',
              '/contenido-comercial/', '/zona-usuario/', '/boletines', '/servicios/',
              '/multimedia/', '/podcast/', '/suscripcion', '/registro', '/login',
              '/newsletter', '/edictos', '/aviso', '/obituarios', '/clasificados',
              '/publicidad/', '/patrocinado/', '/studio/', '/especiales/comercial',
            ];
            const ok = (href.startsWith(baseOrigin) || href.includes(new URL(baseOrigin).hostname)) &&
              BAD_PATHS.every(p => !href.includes(p)) &&
              href.split('/').length > 4;
            if (ok && !seen.has(href)) { seen.add(href); links.push(href); }
          });
          return links.slice(0, 8);
        }, { selector: site.articleSelector, baseOrigin: origin }).catch(() => [] as string[]);

        // Fallback para JS pesado: buscar TODOS los links del dominio si no se encontraron
        if (articleLinks.length === 0 && isHeavyJS) {
          articleLinks = await page.evaluate((baseOrigin: string) => {
            const links: string[] = [];
            const seen = new Set<string>();
            const hostname = new URL(baseOrigin).hostname;
            const BAD = ['/search','/buscador','/tag/','/autor/','/categoria/','/seccion/','/contenido-comercial/','/zona-usuario/','/boletines','/servicios/','/multimedia/','/podcast/','/suscripcion','/registro','/login','/newsletter','/edictos','/aviso','/obituarios','/clasificados','/publicidad/','/patrocinado/'];
            document.querySelectorAll('a[href]').forEach(el => {
              const href = (el as HTMLAnchorElement).href || '';
              if (!href || !href.includes(hostname)) return;
              if (BAD.some(p => href.includes(p)) || href.split('/').length <= 4) return;
              if (!seen.has(href)) { seen.add(href); links.push(href); }
            });
            return links.slice(0, 8);
          }, origin).catch(() => [] as string[]);
          if (articleLinks.length > 0) console.log(`[News] ${site.name}: fallback links encontrados: ${articleLinks.length}`);
        }

        console.log(`[News] ${site.name}: ${articleLinks.length} artículos`);

        for (const articleUrl of articleLinks) {
          // Saltar si ya lo tenemos desde Google News
          if (mentions.some(m => m.url === articleUrl)) continue;

          let aPage: any;
          try { aPage = await ctx.newPage(); }
          catch (e: any) {
            if (isClosed(e)) { console.warn('[News] Contexto cerrado, saltando'); break; }
            throw e;
          }

          try {
            await aPage.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await humanDelay(1500, 3000);

            // Título
            const title: string = await aPage.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              return el?.textContent?.trim() || document.title?.trim() || '';
            }, site.titleSelector).catch(() => '');

            // Fecha
            const pubDate: string = await aPage.evaluate(() => {
              const selectors = ['time[datetime]', '[itemprop="datePublished"]', '[class*="date"]', '[class*="fecha"]', 'time'];
              for (const s of selectors) {
                const el = document.querySelector(s);
                if (el) return el.getAttribute('datetime') || el.textContent?.trim() || '';
              }
              return '';
            }).catch(() => '');

            // Filtrar por fecha
            if (pubDate) {
              const articleDate = new Date(pubDate).getTime();
              const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
              if (articleDate > 0 && articleDate < cutoff) {
                console.log(`[News] Saltando artículo antiguo: "${title?.slice(0, 40)}"`);
                await aPage.close();
                continue;
              }
            }

            // Intro del artículo
            const articleIntro: string = await aPage.evaluate(() => {
              const sels = ['[class*="article-body"] p', '[class*="content"] p', '.c-article__body p', 'article p', 'p'];
              for (const s of sels) {
                const els = Array.from(document.querySelectorAll(s));
                for (const p of els) {
                  const t = p.textContent?.trim() || '';
                  if (t.length > 60) return t.slice(0, 300);
                }
              }
              return '';
            }).catch(() => '');

            // Relevancia — más permisiva: URL, título, intro o nombre del sitio
            const allTerms = [keyword, ...extraTerms];
            const kwParts = allTerms.flatMap(t => norm(t.replace(/[@#]/g, '')).split(/\s+/).filter(p => p.length >= 3));
            const unique = [...new Set(kwParts)];
            const titleN = norm(title);
            const bodyN  = norm(articleIntro);
            const urlN   = norm(articleUrl);
            // Si el título está vacío pero la URL ya fue filtrada por el buscador del sitio, considerarla relevante
            const isRelevant = !title
              ? unique.some(p => urlN.includes(p))
              : unique.some(p => titleN.includes(p) || bodyN.includes(p) || urlN.includes(p));

            if (!isRelevant) {
              console.log(`[News] Artículo no relevante: "${title?.slice(0, 60)}"`);
              await aPage.close();
              continue;
            }

            // Screenshot
            let artScreenshot: string | undefined;
            try {
              const titleEl = await aPage.$(site.titleSelector);
              if (titleEl) artScreenshot = await takeScreenshot(titleEl, `news_${site.name.replace(/\s/g, '_')}`);
            } catch { /* ok */ }

            const mentionText = articleIntro
              ? `${title}\n\n${articleIntro.slice(0, 250)}`
              : (title || articleUrl);

            mentions.push({
              platform: 'noticias',
              author: site.name,
              text: mentionText,
              url: articleUrl,
              date: pubDate || new Date().toISOString(),
              tipo: 'articulo',
              screenshot: artScreenshot,
            } as any);

            // ── Comentarios ──
            await scrollToLoadComments(aPage, 5);
            await humanDelay(3000, 5000);

            try {
              const triggerEl = await aPage.$(site.commentTrigger);
              if (triggerEl) {
                await triggerEl.scrollIntoViewIfNeeded();
                await humanDelay(800, 1500);
                await triggerEl.click();
                await humanDelay(4000, 6000);
              }
            } catch { /* no hay botón */ }

            await humanScroll(aPage, 3);
            await humanDelay(3000, 5000);
            await waitForComments(aPage, site.commentSelector, 1, 10000);

            const rawComments: { author: string; text: string }[] = await aPage.evaluate(({ cSel, aSel }: { cSel: string; aSel: string }) => {
              const items: { author: string; text: string }[] = [];
              const seen = new Set<string>();
              document.querySelectorAll(cSel).forEach(el => {
                const text = el.textContent?.trim() || '';
                if (text.length < 15 || seen.has(text.slice(0, 30))) return;
                seen.add(text.slice(0, 30));
                const parent = el.closest('[class*="comment"], [class*="Comment"]');
                const author = parent?.querySelector(aSel)?.textContent?.trim() || 'Lector';
                items.push({ author, text });
              });
              return items.slice(0, 12);
            }, { cSel: site.commentSelector, aSel: site.authorSelector }).catch(() => [] as { author: string; text: string }[]);

            for (const c of rawComments) {
              comments.push({
                platform: 'noticias',
                author: c.author,
                text: c.text.slice(0, 600),
                url: articleUrl,
                url_fuente: articleUrl,
                date: new Date().toISOString(),
              } as any);
            }

            console.log(`[News] ${site.name} → "${title?.slice(0, 40)}" | ${rawComments.length} comentarios`);
            await aPage.close();
          } catch (e: any) {
            console.warn(`[News] Error artículo ${articleUrl.slice(0, 60)}:`, e.message?.slice(0, 60));
            try { await aPage.close(); } catch { /* ok */ }
          }

          await humanDelay(1200, 2500);
        }
      } catch (e: any) {
        console.warn(`[News] Error en ${site.name}:`, e.message?.slice(0, 80));
      } finally {
        try { await page.close(); } catch { /* ok */ }
      }

      await humanDelay(800, 2000);
    }
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  console.log(`[News] TOTAL: ${mentions.length} artículos · ${comments.length} comentarios`);
  return { mentions, comments };
}
