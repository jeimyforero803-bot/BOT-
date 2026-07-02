/**
 * Facebook scraper — extracción quirúrgica con waitForComments
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, scrollToLoadComments,
  parseRelativeDate, isRecent, delay,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeFacebook(keyword: string, _extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];

  if (!hasAuth('facebook')) {
    console.warn('[Facebook] Sin sesión guardada. Corre: npm run setup → Facebook');
    return { mentions, comments, etiquetados };
  }

  const ctx = await getContext('facebook');

  // Selectores de posts del feed de Facebook
  const POST_SELS = [
    '[data-pagelet*="FeedUnit"] [role="article"]',
    '[role="feed"] > div > div [role="article"]',
    '[role="main"] [role="article"]',
    '[role="article"]',
  ];

  try {
    const page = await ctx.newPage();
    console.log(`[Facebook] Buscando "${keyword}"...`);

    // Posts recientes
    const recentFilter = encodeURIComponent(JSON.stringify({ recent_posts: { name: 'recent_posts', args: '' } }));
    await page.goto(
      `https://www.facebook.com/search/posts/?q=${encodeURIComponent(keyword)}&filters=${recentFilter}`,
      { waitUntil: 'domcontentloaded', timeout: 50000 }
    );

    // Esperar y cerrar posible modal de login/cookies
    await delay(3000);
    try {
      const closeBtn = await page.$('[aria-label="Cerrar"], [aria-label="Close"], [data-testid="cookie-policy-dialog"] button');
      if (closeBtn) { await closeBtn.click(); await delay(1000); }
    } catch { /* ok */ }

    // Espera quirúrgica con múltiples selectores
    let postSel = '';
    for (const sel of POST_SELS) {
      const f = await waitForComments(page, sel, 1, 15000);
      if (f) { postSel = sel; break; }
    }

    if (!postSel) {
      // Fallback: búsqueda sin filtro recientes
      console.warn('[Facebook] Reintentando sin filtro...');
      await page.goto(
        `https://www.facebook.com/search/posts/?q=${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await delay(4000);
      for (const sel of POST_SELS) {
        const f = await waitForComments(page, sel, 1, 12000);
        if (f) { postSel = sel; break; }
      }
    }

    if (!postSel) {
      console.warn('[Facebook] 0 posts encontrados');
      await page.close();
      return { mentions, comments, etiquetados };
    }

    await humanDelay(3000, 5000);
    await humanScroll(page, 5);
    await delay(3000);

    // Extraer posts
    const posts = await page.evaluate((sel: string) => {
      const items: { author: string; text: string; url: string; likes: string; date: string }[] = [];
      const seen = new Set<string>();

      document.querySelectorAll(sel).forEach(el => {
        // Autor
        const authorCandidates = el.querySelectorAll('h2 a, h3 a, h4 a, strong a, [data-hovercard] a');
        let author = '';
        authorCandidates.forEach(a => {
          const t = a.textContent?.trim() || '';
          if (t && !author) author = t;
        });

        // Texto — divs con dir="auto" que tengan contenido sustancial
        let text = '';
        el.querySelectorAll('[dir="auto"]').forEach(div => {
          const t = div.textContent?.trim() || '';
          if (t.length > 20 && !t.startsWith(author) && !text) text = t;
        });
        if (!text || text.length < 15) return;

        // URL — link de timestamp
        const links = el.querySelectorAll('a[href]');
        let url = '';
        links.forEach(a => {
          const href = (a as HTMLAnchorElement).href || '';
          if (!url && (href.includes('story_fbid') || href.includes('/posts/') || href.includes('?fbid='))) url = href;
        });

        // Reacciones
        const reactEl = el.querySelector('[aria-label*="reacci"], [aria-label*="reaction"], span[class*="react"]');
        const likes = reactEl?.getAttribute('aria-label') || reactEl?.textContent?.trim() || '0';

        // Fecha
        const abbr = el.querySelector('abbr[data-utime]');
        const time = el.querySelector('time');
        const date = abbr?.getAttribute('data-utime') || time?.getAttribute('datetime') || time?.textContent?.trim() || '';

        const key = text.slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ author: author || 'Usuario FB', text, url: url || '', likes, date });
        }
      });

      return items.slice(0, 8);
    }, postSel);

    console.log(`[Facebook] ${posts.length} posts encontrados`);
    const articleEls = await page.$$(postSel);

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const isoDate = parseRelativeDate(post.date);
      if (!isRecent(isoDate, days)) continue;

      let shot: string | undefined;
      if (i < 5 && articleEls[i]) shot = await takeScreenshot(articleEls[i], 'fb_post');

      mentions.push({
        platform: 'facebook',
        author: post.author,
        text: post.text.slice(0, 500),
        url: post.url || `https://facebook.com/search/posts/?q=${encodeURIComponent(keyword)}`,
        date: isoDate,
        likes: parseInt((post.likes || '').replace(/[^0-9]/g, '') || '0') || 0,
        tipo: 'post',
        screenshot: shot,
      } as any);

      // Tags y hashtags
      const tags = post.text.match(/@[\w\u00C0-\u024F]+/g) || [];
      for (const tag of tags) {
        if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
          etiquetados.push({ platform: 'facebook', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'mencion' });
        }
      }
      const hashes = post.text.match(/#[\w\u00C0-\u024F]+/g) || [];
      for (const ht of hashes) {
        if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
          etiquetados.push({ platform: 'facebook', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'hashtag' });
        }
      }

      // Abrir post y extraer comentarios
      if (post.url) {
        try {
          const pPage = await ctx.newPage();
          await pPage.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 50000 });
          await delay(5000);

          // Cerrar popups que bloqueen el contenido
          try {
            const overlayBtns = await pPage.$$('[aria-label="Cerrar"], [aria-label="Close"], [data-testid="cookie-policy-dialog"] button');
            for (const btn of overlayBtns) { await btn.click().catch(() => {}); await delay(500); }
          } catch { /* ok */ }

          // Expandir comentarios — múltiples clicks en "Ver más comentarios"
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const allBtns = await pPage.$$('[role="button"]');
              let clicked = false;
              for (const btn of allBtns) {
                const txt = (await btn.textContent() || '').toLowerCase();
                if (txt.includes('comentario') || txt.includes('ver más') || txt.includes('comment') || txt.includes('respuesta') || txt.includes('view')) {
                  await btn.scrollIntoViewIfNeeded().catch(() => {});
                  await delay(300);
                  await btn.click().catch(() => {});
                  await delay(2500);
                  clicked = true;
                  break;
                }
              }
              if (!clicked) break;
            } catch { break; }
          }

          // Scroll agresivo hasta la sección de comentarios
          await scrollToLoadComments(pPage, 5);
          await delay(5000);

          // Selectores de comentarios — múltiples fallbacks para FB moderno
          const COMMENT_SELS = [
            '[aria-label*="Comentario de"]',
            '[aria-label*="Comment by"]',
            '[data-testid*="UFI2Comment"]',
            '[role="article"] form ~ div [dir="auto"]',
            'div[class*="UFIComment"]',
            '[role="article"] [dir="auto"][class]',
          ];

          let cSel = '';
          for (const s of COMMENT_SELS) {
            const f = await waitForComments(pPage, s, 1, 10000);
            if (f) { cSel = s; break; }
          }

          const rawComments = cSel
            ? await pPage.evaluate((sel: string) => {
                const items: { author: string; text: string; likes: string; date: string }[] = [];
                const seen = new Set<string>();
                document.querySelectorAll(sel).forEach(el => {
                  const authorEl = el.querySelector('a[role="link"] span, h3 a, strong');
                  const author = authorEl?.textContent?.trim() || '';

                  let text = '';
                  el.querySelectorAll('[dir="auto"]').forEach(div => {
                    const t = div.textContent?.trim() || '';
                    if (t.length > 5 && t !== author && !text) text = t;
                  });
                  if (!text) text = el.textContent?.replace(author, '').trim().slice(0, 500) || '';

                  const likes = el.querySelector('[aria-label*="reacci"]')?.textContent?.trim() || '0';
                  const abbr = el.querySelector('abbr[data-utime]');
                  const time = el.querySelector('time');
                  const date = abbr?.getAttribute('data-utime') || time?.getAttribute('datetime') || time?.textContent?.trim() || '';

                  if (text.length > 5 && !seen.has(text.slice(0, 30))) {
                    seen.add(text.slice(0, 30));
                    items.push({ author: author || 'Usuario FB', text, likes, date });
                  }
                });
                return items.slice(0, 30);
              }, cSel)
            // Fallback moderno: extraer de [role="article"] — FB 2024/2025
            : await pPage.evaluate((postText: string) => {
                const items: { author: string; text: string; likes: string; date: string }[] = [];
                const seen = new Set<string>();
                const articles = document.querySelectorAll('[role="article"]');
                let skippedFirst = false;
                articles.forEach(article => {
                  // El primer article suele ser el post mismo — saltar si contiene texto del post
                  const aText = article.textContent?.trim() || '';
                  if (!skippedFirst && postText.length > 10 && aText.includes(postText.slice(0, 30))) {
                    skippedFirst = true;
                    return;
                  }
                  skippedFirst = true;
                  const authorEl = article.querySelector('a[href] span, h3, strong');
                  const author = authorEl?.textContent?.trim() || '';
                  let text = '';
                  article.querySelectorAll('[dir="auto"]').forEach(div => {
                    const t = div.textContent?.trim() || '';
                    if (t.length > 8 && t !== author && !text) text = t;
                  });
                  if (!text || text.length < 8) return;
                  const time = article.querySelector('time, abbr[data-utime]');
                  const date = time?.getAttribute('datetime') || time?.getAttribute('data-utime') || '';
                  if (!seen.has(text.slice(0, 30))) {
                    seen.add(text.slice(0, 30));
                    items.push({ author: author || 'Usuario FB', text, likes: '0', date });
                  }
                });
                return items.slice(0, 30);
              }, post.text.slice(0, 60));

          const cEls = cSel ? await pPage.$$(cSel) : [];

          for (let j = 0; j < rawComments.length; j++) {
            const c = rawComments[j];
            const cDate = parseRelativeDate(c.date);
            if (!isRecent(cDate, days)) continue;

            let cShot: string | undefined;
            if (j < 5 && cEls[j]) cShot = await takeScreenshot(cEls[j], 'fb_comment');

            comments.push({
              platform: 'facebook', author: c.author, text: c.text.slice(0, 600),
              url: post.url, url_fuente: post.url, date: cDate,
              likes: parseInt((c.likes || '').replace(/[^0-9]/g, '') || '0') || 0,
              screenshot: cShot,
            } as any);
          }

          console.log(`[Facebook] "${post.text.slice(0, 40)}" → ${rawComments.length} comentarios`);
          await pPage.close();
        } catch (e: any) {
          console.warn('[Facebook] Error en post:', e.message?.slice(0, 60));
        }
      }

      await humanDelay(3000, 5500);
    }

    await page.close();
  } catch (e: any) {
    console.error('[Facebook] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
