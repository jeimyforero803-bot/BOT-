/**
 * Reddit scraper — búsqueda en español e inglés, r/colombia, old.reddit.com
 */
import {
  getContext, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeReddit(keyword: string, _extraTerms: string[] = [], days = 45): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];
  const ctx = await getContext();

  // Múltiples búsquedas: global + subreddits hispanohablantes
  const searches = [
    `https://old.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=new&t=year`,
    `https://old.reddit.com/r/colombia+Colombia+latinoamerica+es+Colombia+argentina+mexico/search/?q=${encodeURIComponent(keyword)}&sort=new&t=year&restrict_sr=on`,
  ];

  const allPostUrls = new Set<string>();
  const allPosts: { title: string; author: string; url: string; sub: string; score: string; date: string }[] = [];

  try {
    for (const searchUrl of searches) {
      const page = await ctx.newPage();
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Esperar resultados
        const found = await waitForComments(page, '.search-result-link, .thing.link', 1, 20000);
        if (!found) { await page.close(); continue; }

        await humanDelay(1500, 3000);

        // Scroll para más resultados
        await humanScroll(page, 3);
        await delay(1500);

        const posts = await page.evaluate(() => {
          const items: { title: string; author: string; url: string; sub: string; score: string; date: string }[] = [];
          document.querySelectorAll('.search-result').forEach(el => {
            const titleEl = el.querySelector('a.search-title, .may-blank.search-title');
            if (!titleEl) return;
            const href = ((titleEl as HTMLAnchorElement).href || '').replace('www.reddit.com', 'old.reddit.com');
            if (!href.includes('/comments/')) return;

            const meta = el.querySelector('.search-result-meta');
            const author = meta?.querySelector('.author')?.textContent?.trim() || '[deleted]';
            const sub = meta?.querySelector('.search-subreddit-link')?.textContent?.trim() || '';
            const score = el.querySelector('.search-score-count')?.textContent?.replace(/[^0-9]/g, '') || '0';
            const dateEl = el.querySelector('time');
            const date = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '';

            items.push({ title: titleEl.textContent?.trim() || '', author, url: href, sub, score, date });
          });
          return items;
        });

        for (const p of posts) {
          if (!allPostUrls.has(p.url)) { allPostUrls.add(p.url); allPosts.push(p); }
        }

        console.log(`[Reddit] ${posts.length} posts en búsqueda: ${searchUrl.slice(22, 60)}...`);
        await page.close();
      } catch (e: any) {
        console.warn('[Reddit] Error en búsqueda:', e.message?.slice(0, 60));
        await page.close();
      }
    }

    console.log(`[Reddit] Total: ${allPosts.length} posts únicos`);

    // Procesar los primeros 8 posts
    for (const post of allPosts.slice(0, 8)) {
      const isoDate = parseRelativeDate(post.date);
      if (!isRecent(isoDate, days)) {
        console.log(`[Reddit] Saltando post antiguo: "${post.title.slice(0, 40)}"`);
        continue;
      }

      mentions.push({
        platform: 'reddit',
        author: post.author,
        text: `[${post.sub}] ${post.title}`,
        url: post.url,
        date: isoDate,
        likes: parseInt(post.score || '0') || 0,
        tipo: 'post',
      } as any);

      // Abrir post y extraer comentarios
      try {
        const pPage = await ctx.newPage();
        await pPage.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Espera quirúrgica de comentarios
        const found = await waitForComments(pPage, '.comment, .thing.comment', 1, 20000);

        if (!found) {
          console.warn(`[Reddit] Sin comentarios en "${post.title.slice(0, 40)}"`);
          await pPage.close();
          continue;
        }

        await humanDelay(2000, 3500);

        // Intentar expandir todos los comentarios colapsados
        try {
          const expandBtns = await pPage.$$('.expand');
          for (const btn of expandBtns.slice(0, 10)) {
            await btn.click().catch(() => {});
            await delay(300);
          }
        } catch { /* ok */ }

        await humanScroll(pPage, 4);
        await delay(2000);

        // Extraer comentarios de old.reddit.com — HTML estable
        const rawComments = await pPage.evaluate(() => {
          const items: { author: string; text: string; score: string; date: string }[] = [];
          const seen = new Set<string>();

          document.querySelectorAll('.comment').forEach(el => {
            // Solo comentarios no colapsados y no muy anidados
            if (el.classList.contains('collapsed')) return;
            const depthEl = el.closest('[class*="indent"]');
            const depth = depthEl ? parseInt(depthEl.className.match(/indent(\d)/)?.[1] || '0') : 0;
            if (depth > 4) return;

            const author = el.querySelector('.author')?.textContent?.trim() || '';
            if (!author || author === '[deleted]' || author === 'AutoModerator') return;

            const textEl = el.querySelector('.usertext-body .md');
            const text = textEl?.textContent?.trim() || '';
            if (!text || text.length < 5) return;

            const score = el.querySelector('.score.likes')?.textContent?.replace(/[^0-9-]/g, '') || '0';

            // Fecha del comentario
            const timeEl = el.querySelector('time');
            const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

            const key = text.slice(0, 35);
            if (!seen.has(key)) {
              seen.add(key);
              items.push({ author, text, score, date });
            }
          });

          return items.slice(0, 25);
        });

        // Screenshots
        const commentEls = await pPage.$$('.comment');

        for (let j = 0; j < rawComments.length; j++) {
          const c = rawComments[j];
          const cDate = parseRelativeDate(c.date);
          if (!isRecent(cDate, days)) continue;

          let cShot: string | undefined;
          if (j < 5 && commentEls[j]) cShot = await takeScreenshot(commentEls[j], 'reddit_comment');

          comments.push({
            platform: 'reddit',
            author: c.author,
            text: c.text.slice(0, 600),
            url: post.url,
            url_fuente: post.url,
            date: cDate,
            likes: parseInt(c.score || '0') || 0,
            screenshot: cShot,
          } as any);

          // Detectar menciones de keyword
          if (keyword.toLowerCase().split(/\s+/).some(p => c.text.toLowerCase().includes(p))) {
            etiquetados.push({ platform: 'reddit', quien: c.author, texto: c.text.slice(0, 280), url: post.url, date: cDate, tipo: 'mencion' });
          }
        }

        console.log(`[Reddit] "${post.title.slice(0, 40)}" → ${rawComments.length} comentarios`);
        await pPage.close();
      } catch (e: any) {
        console.warn('[Reddit] Error en post:', e.message?.slice(0, 60));
      }

      await humanDelay(1500, 3000);
    }

  } catch (e: any) {
    console.error('[Reddit] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
