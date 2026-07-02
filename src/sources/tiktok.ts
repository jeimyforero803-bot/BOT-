/**
 * TikTok scraper — extracción quirúrgica de comentarios con waitForComments
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeTikTok(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];
  const kw = keyword.toLowerCase().replace(/\s+/g, '');
  const hashtag = kw.replace(/[^a-z0-9\u00C0-\u024F]/gi, '');
  const useAuth = hasAuth('tiktok');
  const ctx = await getContext(useAuth ? 'tiktok' : undefined);

  // Selectores de comentarios de TikTok (múltiples fallbacks por versión 2024-2025)
  const COMMENT_SELECTORS = [
    '[data-e2e="comment-level-1"]',
    '[data-e2e="comment-level-1-item"]',
    '[class*="DivCommentItemWrapper"]',
    '[class*="CommentItemContainer"]',
    '[class*="DivCommentItem"]:not([class*="Action"]):not([class*="Icon"])',
    '[class*="comment-item"]',
    '[class*="comment-list"] > div > div',
    '.css-7whb78-DivCommentItemWrapper',
  ];

  try {
    const page = await ctx.newPage();
    console.log(`[TikTok] Buscando "${keyword}"${useAuth ? ' (con sesión)' : ''}...`);

    // Buscar videos por keyword — sort_type=1 = más recientes primero
    await page.goto(
      `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&sort_type=1`,
      { waitUntil: 'domcontentloaded', timeout: 35000 }
    );

    await delay(5000);

    // Intentar hacer clic en el filtro "Latest" / "Más reciente" si aparece en la UI
    try {
      const sortBtns = await page.$$('[class*="DivSort"] *, [class*="SortItem"], [class*="filter-item"], [class*="FilterItem"]');
      for (const btn of sortBtns) {
        const txt = (await btn.textContent() || '').toLowerCase();
        if (txt.includes('latest') || txt.includes('reciente') || txt.includes('recent') || txt.includes('nuevo')) {
          await btn.click();
          await delay(2000);
          console.log('[TikTok] Filtro "Latest" activado');
          break;
        }
      }
    } catch { /* ok */ }

    await humanScroll(page, 3);
    await delay(3000);

    // Función reutilizable para extraer video links + fecha visible en el card
    const extractVideoLinks = async () => page.evaluate(() => {
      const seen = new Set<string>();
      const items: { url: string; author: string; text: string; cardDate: string }[] = [];
      document.querySelectorAll('a[href*="/video/"]').forEach(el => {
        const href = (el as HTMLAnchorElement).href || '';
        if (!href || seen.has(href) || !href.includes('/@') || !href.includes('/video/')) return;
        seen.add(href);
        const container = el.closest('[class]')?.parentElement?.closest('[class]') || el.parentElement;
        const author = href.split('/@')[1]?.split('/')[0] || 'TikToker';
        let text = '';
        let cardDate = '';
        container?.querySelectorAll('span, p, div').forEach(t => {
          const txt = t.textContent?.trim() || '';
          if (txt.length > 10 && txt.length < 300 && !txt.includes('@') && !text) text = txt;
          // Capturar fecha visible en el card: "2d", "3w", "2025-03-15", "Jun 15", etc.
          if (!cardDate && (
            txt.match(/^\d+[dwmyhs]$/) ||
            txt.match(/\d{4}-\d{2}-\d{2}/) ||
            txt.match(/hace\s+\d+/i) ||
            txt.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/)
          )) { cardDate = txt; }
        });
        items.push({ url: href, author: '@' + author, text, cardDate });
      });
      return items.slice(0, 10);
    });

    let videoLinks = await extractVideoLinks();

    // Si no encontró por keyword, buscar por hashtag
    if (videoLinks.length === 0 && hashtag) {
      console.log(`[TikTok] Probando hashtag #${hashtag}...`);
      await page.goto(`https://www.tiktok.com/tag/${hashtag}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(5000);
      await humanScroll(page, 3);
      await delay(2000);
      videoLinks = await extractVideoLinks();
    }

    console.log(`[TikTok] ${videoLinks.length} videos encontrados`);

    for (const vid of videoLinks) {
      // Pre-filtro por fecha del card de búsqueda (evita abrir videos evidentemente viejos)
      if (vid.cardDate) {
        const cardIso = parseRelativeDate(vid.cardDate);
        if (!isRecent(cardIso, days)) {
          console.log(`[TikTok] Card antiguo (${vid.cardDate}), saltando: ${vid.url.slice(-30)}`);
          continue;
        }
      }

      mentions.push({
        platform: 'tiktok',
        author: vid.author,
        text: vid.text || `Video de ${vid.author} sobre "${keyword}"`,
        url: vid.url,
        date: new Date().toISOString(),
        tipo: 'video',
      } as any);

      // Abrir video con tiempo generoso
      try {
        const vPage = await ctx.newPage();
        await vPage.goto(vid.url, { waitUntil: 'domcontentloaded', timeout: 40000 });

        // Espera carga completa del JS de TikTok
        await delay(4000);

        // Intentar click en botón/icono de comentarios para abrir el panel
        try {
          const commentBtnSelectors = [
            '[data-e2e="comment-icon"]',
            '[data-e2e="browse-comment-icon"]',
            'button[aria-label*="comentario"], button[aria-label*="comment"]',
            '[class*="DivCommentIconContainer"]',
            '[class*="comment-icon"]',
            'svg[class*="comment"] + span',
          ];
          for (const sel of commentBtnSelectors) {
            const btn = await vPage.$(sel);
            if (btn) {
              await btn.scrollIntoViewIfNeeded();
              await delay(500);
              await btn.click();
              await delay(4000); // tiempo para que el panel cargue
              console.log(`[TikTok] Click en botón comentarios (${sel})`);
              break;
            }
          }
        } catch { /* ok, comentarios ya abiertos */ }

        await humanScroll(vPage, 3);
        await delay(3000);

        // Datos del video (actualizar mención)
        const videoData = await vPage.evaluate(() => {
          const selectors = [
            '[data-e2e="browse-video-desc"]',
            '[class*="DivVideoInfoContainer"] p',
            'h1[class]',
            '[class*="video-desc"]',
          ];
          let desc = '';
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el?.textContent?.trim()) { desc = el.textContent.trim(); break; }
          }
          const author = document.querySelector('[data-e2e="browse-username"], [class*="UniqueId"]')?.textContent?.trim() || '';
          const likes = document.querySelector('[data-e2e="browse-like-count"], [class*="like-count"]')?.textContent?.trim() || '0';

          // ── Fecha de subida: 3 métodos en orden de confiabilidad ──────────────
          let date = '';

          // 1. JSON-LD — el más confiable (dato estructurado de la página)
          try {
            for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
              const d = JSON.parse(s.textContent || '{}');
              const found = d.uploadDate || d.datePublished || d.dateCreated ||
                (Array.isArray(d['@graph']) && d['@graph'].map((x: any) => x.uploadDate || x.datePublished).find(Boolean));
              if (found) { date = found; break; }
            }
          } catch {}

          // 2. __NEXT_DATA__ de NextJS — contiene createTime como Unix timestamp
          if (!date) {
            try {
              const nd = document.getElementById('__NEXT_DATA__');
              if (nd) {
                const data = JSON.parse(nd.textContent || '{}');
                const ct = data?.props?.pageProps?.itemInfo?.itemStruct?.createTime ||
                           data?.props?.pageProps?.videoData?.createTime;
                if (ct) date = new Date(parseInt(ct) * 1000).toISOString();
              }
            } catch {}
          }

          // 3. DOM — buscar spans con texto de fecha (respaldo CSS)
          if (!date) {
            const allSpans = Array.from(document.querySelectorAll('span, [class*="time"], [class*="date"]'));
            for (const el of allSpans) {
              const t = el.textContent?.trim() || '';
              if (t.match(/\d{4}-\d{2}-\d{2}/) || t.match(/^\d+[dwmyh]$/) || t.match(/hace\s+\d+/i)) {
                date = t; break;
              }
            }
          }

          return { desc, author, likes, date };
        });

        // Filtro de fecha: usar todos los métodos disponibles
        let uploadDate = videoData.date ? parseRelativeDate(videoData.date) : '';

        // Último recurso: estimar fecha a partir del video ID (TikTok usa snowflake IDs)
        if (!uploadDate) {
          try {
            const videoId = vid.url.match(/\/video\/(\d+)/)?.[1];
            if (videoId) {
              // Los primeros 32 bits del ID codifican segundos Unix
              const ts = Number(BigInt(videoId) >> BigInt(32)) * 1000;
              if (ts > 1500000000000 && ts < Date.now() + 86400000) {
                uploadDate = new Date(ts).toISOString();
                console.log(`[TikTok] Fecha por ID: ${uploadDate.slice(0, 10)} (${vid.author})`);
              }
            }
          } catch {}
        }

        if (uploadDate && !isRecent(uploadDate, days)) {
          console.log(`[TikTok] Saltando video antiguo (${uploadDate.slice(0, 10)}) de ${vid.author}`);
          mentions.pop(); // quitar la mención ya añadida
          await vPage.close();
          continue;
        }

        if (videoData.desc || videoData.author) {
          const lastMention = mentions[mentions.length - 1] as any;
          if (lastMention) {
            if (videoData.desc) lastMention.text = videoData.desc.slice(0, 400);
            if (videoData.author) lastMention.author = '@' + videoData.author;
            lastMention.likes = parseInt(videoData.likes.replace(/[^0-9]/g, '') || '0') || 0;
            if (uploadDate) lastMention.date = uploadDate; // actualizar con fecha real
          }
        }

        // Screenshot del video
        try {
          const videoEl = await vPage.$('[data-e2e="browse-video"], video, [class*="DivVideoWrapper"]');
          if (videoEl) {
            const shot = await takeScreenshot(videoEl, 'tt_video');
            if (shot && mentions.length > 0) (mentions[mentions.length - 1] as any).screenshot = shot;
          }
        } catch { /* ok */ }

        // Espera quirúrgica de comentarios — más tiempo para TikTok
        console.log(`[TikTok] Esperando comentarios de ${vid.author}...`);

        // Scroll adicional para activar lazy loading del panel de comentarios
        for (let s = 0; s < 3; s++) {
          await vPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await delay(1500);
        }

        let commentSelector = '';
        for (const sel of COMMENT_SELECTORS) {
          const found = await waitForComments(vPage, sel, 1, 12000);
          if (found) { commentSelector = sel; break; }
        }

        // Si ningún selector específico funcionó, intentar selectores genéricos
        if (!commentSelector) {
          const genericSelectors = [
            '[class*="Comment"]:not([class*="CommentIcon"]):not([class*="CommentCount"]):not([class*="CommentButton"])',
            '[class*="comment"]:not([class*="icon"]):not([class*="count"]):not([class*="button"])',
            'div[class][data-e2e]',
          ];
          for (const sel of genericSelectors) {
            const found = await waitForComments(vPage, sel, 2, 10000);
            if (found) { commentSelector = sel; break; }
          }
        }

        if (!commentSelector) {
          console.warn(`[TikTok] Sin comentarios en ${vid.url.slice(-40)}`);
          await vPage.close();
          continue;
        }

        // Scroll agresivo dentro del panel de comentarios para cargar más
        try {
          const commentPanel = await vPage.$(
            '[class*="DivCommentListContainer"], [class*="CommentListContainer"], [class*="comment-list"], [class*="comment-panel"]'
          );
          if (commentPanel) {
            for (let s = 0; s < 6; s++) {
              await vPage.evaluate(el => el.scrollBy(0, 600), commentPanel);
              await delay(1200);
            }
          } else {
            // Fallback: scroll en la página completa
            for (let s = 0; s < 5; s++) {
              await vPage.evaluate(() => window.scrollBy(0, 700));
              await delay(1200);
            }
          }
        } catch { /* ok */ }

        // Intentar expandir respuestas en comentarios
        try {
          const viewRepliesBtns = await vPage.$$('[data-e2e*="view-more-reply"], [class*="view-more"], button[class*="reply"]');
          for (const btn of viewRepliesBtns.slice(0, 5)) {
            await btn.click().catch(() => {});
            await delay(800);
          }
        } catch { /* ok */ }

        await delay(2000);

        // Extraer comentarios con fecha
        const rawComments = await vPage.evaluate((sel: string) => {
          const items: { author: string; text: string; likes: string; date: string }[] = [];
          document.querySelectorAll(sel).forEach(el => {
            // Autor
            const authorSelectors = [
              '[data-e2e="comment-username-1"]',
              '[class*="SpanUniqueId"]',
              '[class*="UniqueId"]',
              'a[href*="/@"] span',
              'p[class*="author"]',
            ];
            let author = '';
            for (const aSel of authorSelectors) {
              const aEl = el.querySelector(aSel);
              if (aEl?.textContent?.trim()) { author = aEl.textContent.trim(); break; }
            }

            // Texto del comentario
            const textSelectors = [
              '[data-e2e="comment-text"]',
              'span[class*="SpanText"]',
              'p[class*="content"]',
              '[class*="CommentText"]',
            ];
            let text = '';
            for (const tSel of textSelectors) {
              const tEl = el.querySelector(tSel);
              if (tEl?.textContent?.trim()) { text = tEl.textContent.trim(); break; }
            }
            if (!text) text = el.textContent?.trim() || '';

            // Likes y fecha
            const likes = el.querySelector('[data-e2e="comment-like-count"]')?.textContent?.trim() || '0';
            const date = el.querySelector('[class*="time"], time')?.textContent?.trim() || '';

            if (text.length > 3) items.push({ author: author || 'TikToker', text, likes, date });
          });
          return items.slice(0, 30);
        }, commentSelector);

        const commentEls = await vPage.$$(commentSelector);

        for (let j = 0; j < rawComments.length; j++) {
          const c = rawComments[j];
          const isoDate = parseRelativeDate(c.date);
          if (!isRecent(isoDate, 30)) continue;

          let cShot: string | undefined;
          if (j < 5 && commentEls[j]) cShot = await takeScreenshot(commentEls[j], 'tt_comment');

          comments.push({
            platform: 'tiktok',
            author: c.author,
            text: c.text.slice(0, 600),
            url: vid.url,
            url_fuente: vid.url,
            date: isoDate,
            likes: parseInt(c.likes.replace(/[^0-9]/g, '') || '0') || 0,
            screenshot: cShot,
          } as any);

          const tags = c.text.match(/@[\w\u00C0-\u024F]+/g) || [];
          for (const tag of tags) {
            if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
              etiquetados.push({ platform: 'tiktok', quien: c.author, texto: c.text.slice(0, 280), url: vid.url, date: isoDate, tipo: 'mencion' });
            }
          }
          const hashes = c.text.match(/#[\w\u00C0-\u024F]+/g) || [];
          for (const ht of hashes) {
            if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
              etiquetados.push({ platform: 'tiktok', quien: c.author, texto: c.text.slice(0, 280), url: vid.url, date: isoDate, tipo: 'hashtag' });
            }
          }
        }

        // Fallback: si el selector encontró elementos pero la extracción dio 0,
        // intentar extraer texto directamente del panel de comentarios
        if (rawComments.length === 0) {
          const fallback = await vPage.evaluate(() => {
            const panelSels = [
              '[data-e2e="comment-list"]', '[class*="CommentListContainer"]',
              '[class*="DivCommentListContainer"]', '[class*="comment-list"]',
            ];
            let panel: Element | null = null;
            for (const sel of panelSels) { panel = document.querySelector(sel); if (panel) break; }
            if (!panel) return [];
            const items: { author: string; text: string; likes: string; date: string }[] = [];
            const seen = new Set<string>();
            panel.querySelectorAll('div, p, span').forEach(el => {
              if ((el as HTMLElement).children.length > 4) return;
              const txt = el.textContent?.trim() || '';
              if (txt.length > 10 && txt.length < 400 && !seen.has(txt.slice(0, 25))) {
                seen.add(txt.slice(0, 25));
                items.push({ author: 'TikToker', text: txt, likes: '0', date: '' });
              }
            });
            return items.slice(0, 30);
          });
          if (fallback.length > 0) {
            console.log(`[TikTok] Fallback: ${fallback.length} textos del panel`);
            rawComments.push(...fallback);
          }
        }

        console.log(`[TikTok] ${vid.author} → ${rawComments.length} comentarios extraídos`);
        await vPage.close();
      } catch (e: any) {
        console.warn('[TikTok] Error en video:', e.message?.slice(0, 80));
      }

      await humanDelay(3000, 5000);
    }

    // Búsqueda adicional por #hashtags en extraTerms
    const extraHashtags = extraTerms
      .filter(t => t.startsWith('#'))
      .map(t => t.replace('#', '').replace(/[^a-z0-9\u00C0-\u024F]/gi, ''))
      .filter(h => h && h.toLowerCase() !== hashtag.toLowerCase());

    for (const extraHash of extraHashtags.slice(0, 2)) {
      try {
        const hPage = await ctx.newPage();
        console.log(`[TikTok] Buscando hashtag extra #${extraHash}...`);
        await hPage.goto(`https://www.tiktok.com/tag/${extraHash}?sort_type=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(4000);
        const extraVideos = await hPage.evaluate(() => {
          const links: string[] = [];
          const seen = new Set<string>();
          document.querySelectorAll('a[href*="/video/"]').forEach(el => {
            const href = (el as HTMLAnchorElement).href || '';
            if (href.includes('/video/') && !seen.has(href)) { seen.add(href); links.push(href); }
          });
          return links.slice(0, 5);
        });
        for (const vUrl of extraVideos) {
          try {
            const vPage = await ctx.newPage();
            await vPage.goto(vUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await delay(3000);
            const vData = await vPage.evaluate(() => {
              const authorEl = document.querySelector('a[data-e2e="browse-username"], [class*="AuthorTitle"], h3[data-e2e]');
              const textEl = document.querySelector('[data-e2e="browse-video-desc"], [class*="VideoCaption"], h1[data-e2e]');
              const timeEl = document.querySelector('time');
              return {
                author: authorEl?.textContent?.trim() || '',
                text: textEl?.textContent?.trim() || '',
                date: timeEl?.getAttribute('datetime') || new Date().toISOString(),
              };
            });
            if (vData.text && isRecent(vData.date, days)) {
              mentions.push({ platform: 'tiktok', author: vData.author || `#${extraHash}`, text: vData.text.slice(0, 400), url: vUrl, date: vData.date, tipo: 'video' } as any);
            }
            await vPage.close();
          } catch { /* ok */ }
          await delay(2000);
        }
        console.log(`[TikTok] #${extraHash}: ${extraVideos.length} videos extra`);
        await hPage.close();
      } catch (e: any) {
        console.warn(`[TikTok] Error en #${extraHash}:`, e.message?.slice(0, 50));
      }
    }

    await page.close();
  } catch (e: any) {
    console.error('[TikTok] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
