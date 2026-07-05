/**
 * Instagram scraper — extracción quirúrgica de comentarios por span[dir="auto"]
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay, buildPreciseQuery,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeInstagram(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];

  if (!hasAuth('instagram')) {
    console.warn('[Instagram] Sin sesión guardada. Corre: npm run setup → Instagram');
    return { mentions, comments, etiquetados };
  }

  const ctx = await getContext('instagram');
  const kw = keyword.toLowerCase().replace(/\s+/g, '');
  const hashtag = kw.replace(/[^a-z0-9\u00C0-\u024F]/gi, '');

  try {
    const page = await ctx.newPage();
    console.log(`[Instagram] Buscando #${hashtag}...`);

    await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    // Esperar que el grid aparezca
    const gridFound = await waitForComments(page, 'a[href*="/p/"]', 3, 25000);
    if (!gridFound) {
      console.warn(`[Instagram] Sin posts para #${hashtag}`);
      await page.close();
      return { mentions, comments, etiquetados };
    }

    await humanDelay(3000, 5000);
    await humanScroll(page, 3);
    await delay(2000);

    const extractPostLinks = () => page.evaluate(() => {
      const links: string[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('a[href*="/p/"]').forEach(el => {
        const href = (el as HTMLAnchorElement).href || '';
        if (href.includes('/p/') && !seen.has(href)) { seen.add(href); links.push(href); }
      });
      return links.slice(0, 12);
    });

    let postLinks = await extractPostLinks();
    console.log(`[Instagram] ${postLinks.length} posts en #${hashtag}`);

    // Si hay pocos posts en el hashtag, buscar también por la frase exacta de la
    // marca (no solo "keyword" suelto, que puede venir recortado a una palabra).
    if (postLinks.length < 4) {
      const preciseQuery = buildPreciseQuery(keyword, extraTerms);
      console.log(`[Instagram] Pocos posts en hashtag, buscando "${preciseQuery}"...`);
      try {
        await page.goto(
          `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(preciseQuery)}`,
          { waitUntil: 'domcontentloaded', timeout: 20000 }
        );
        await delay(3000);
        await humanScroll(page, 3);
        await delay(2000);
        const kwLinks = await extractPostLinks();
        // Agregar los links únicos
        const existing = new Set(postLinks);
        for (const l of kwLinks) { if (!existing.has(l)) postLinks.push(l); }
        console.log(`[Instagram] ${kwLinks.length} posts adicionales por keyword`);
      } catch { /* ok, quedarse con lo que hay */ }
    }

    console.log(`[Instagram] Total: ${postLinks.length} posts a procesar`);

    for (const postUrl of postLinks) {
      const pPage = await ctx.newPage();
      try {
        await pPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Esperar que el artículo cargue completamente
        await waitForComments(pPage, 'article', 1, 20000);
        await delay(4000);

        // Screenshot del post
        let postShot: string | undefined;
        try {
          const articleEl = await pPage.$('article');
          if (articleEl) postShot = await takeScreenshot(articleEl, 'ig_post');
        } catch { /* ok */ }

        // Extraer metadata del post — Instagram 2025/2026
        const postData = await pPage.evaluate(() => {
          // Autor — múltiples selectores en orden de prioridad
          let author = '';
          const authorSelectors = [
            'header h2 a', 'header h2', 'header [role="link"] span',
            'h2 a', 'a[role="link"] span[class]', 'header a span',
            'article header a[href*="/"] span', 'header a[href]',
          ];
          for (const sel of authorSelectors) {
            document.querySelectorAll(sel).forEach(el => {
              const txt = el.textContent?.trim() || '';
              if (txt && txt.length > 0 && txt.length < 60 && !txt.includes('\n') && !author) author = txt;
            });
            if (author) break;
          }

          // Caption — cualquier span/div[dir="auto"] con contenido sustancial
          let caption = '';
          document.querySelectorAll('h1, span[dir="auto"], div[dir="auto"]').forEach(el => {
            const txt = el.textContent?.trim() || '';
            if (txt.length > 15 && txt !== author && !caption) caption = txt;
          });

          // Likes
          const likesEl = document.querySelector('section span[class], [class*="like_count"]');
          const likes = likesEl?.textContent?.trim() || '0';

          // Fecha
          const timeEl = document.querySelector('time');
          const date = timeEl?.getAttribute('datetime') || new Date().toISOString();

          return { author, caption, likes, date };
        });

        // Filtrar posts antiguos (> 30 días)
        if (!isRecent(postData.date, days)) {
          console.log(`[Instagram] Saltando post antiguo: ${postUrl.slice(-20)}`);
          await pPage.close();
          continue;
        }

        // Extraer autor del URL como último recurso
        const urlAuthor = postUrl.match(/instagram\.com\/([^\/]+)\/p\//)?.[1] || '';

        // Siempre añadir el post como mención (con fallbacks si la extracción falla)
        mentions.push({
          platform: 'instagram',
          author: postData.author || urlAuthor || `#${hashtag}`,
          text: (postData.caption || `Post sobre ${keyword}`).slice(0, 400),
          url: postUrl,
          date: postData.date,
          likes: parseInt((postData.likes || '0').replace(/[^0-9]/g, '') || '0') || 0,
          tipo: 'post',
          screenshot: postShot,
        } as any);

        // Hashtags en caption
        const hashes = (postData.caption || '').match(/#[\w\u00C0-\u024F]+/g) || [];
        for (const ht of hashes) {
          if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'instagram', quien: postData.author || urlAuthor, texto: postData.caption.slice(0, 280), url: postUrl, date: postData.date, tipo: 'hashtag' });
          }
        }

        // Expandir comentarios — múltiples clicks en "Ver todos los comentarios"
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const loadMoreBtns = await pPage.$$('button, [role="button"], span[role="button"]');
            let clicked = false;
            for (const btn of loadMoreBtns) {
              const txt = await btn.textContent();
              if (txt && (txt.includes('comentario') || txt.includes('comment') || txt.includes('Ver todos') || txt.includes('Load more') || txt.includes('más'))) {
                await btn.scrollIntoViewIfNeeded();
                await delay(400);
                await btn.click();
                await delay(2500);
                clicked = true;
                break;
              }
            }
            if (!clicked) break;
          } catch { break; }
        }

        // Scroll agresivo dentro del contenedor de comentarios
        try {
          const commentContainer = await pPage.$('ul[class], article ul, section ul, [role="list"], [aria-label*="omentario"]');
          if (commentContainer) {
            for (let s = 0; s < 6; s++) {
              await pPage.evaluate(el => el.scrollBy(0, 500), commentContainer);
              await delay(900);
            }
          }
        } catch { /* ok */ }

        await humanScroll(pPage, 5);
        await delay(4000);

        // Espera quirúrgica — múltiples selectores para IG moderno (2024-2025)
        const igCommentSels = [
          'article ul li',
          '[aria-label*="Comentario"] li, [aria-label*="Comment"] li',
          'div[role="dialog"] ul li',
          'section ul li',
          'ul[class] li',
          'li[role="presentation"]',
          'div[class*="x9f619"] span[dir="auto"]', // fallback IG dinámico
        ];
        let igCommentSel = '';
        for (const sel of igCommentSels) {
          const found = await waitForComments(pPage, sel, 1, 30000);
          if (found) { igCommentSel = sel; break; }
        }
        if (!igCommentSel) igCommentSel = 'article ul li'; // fallback

        // EXTRACCIÓN QUIRÚRGICA:
        // Instagram: <ul> <li> caption </li> <li> comentario </li> ...
        // El primer <li> es la caption, los siguientes son comentarios reales
        const rawComments = await pPage.evaluate((params: { captionText: string; sel: string }) => {
          const { captionText, sel } = params;
          const items: { author: string; text: string; date: string }[] = [];
          const seen = new Set<string>();

          const listItems = document.querySelectorAll(sel);
          listItems.forEach((li, idx) => {
            // Saltar primer li si es caption (contiene el texto de la descripción del post)
            if (idx === 0 && captionText.length > 5) {
              const liText = li.textContent?.trim() || '';
              if (captionText.slice(0, 30) && liText.includes(captionText.slice(0, 20))) return;
            }

            // Autor: primer link dentro del li que tenga texto de usuario
            const authorLinks = li.querySelectorAll('a[href*="/"]');
            let author = '';
            authorLinks.forEach(a => {
              const t = a.textContent?.trim() || '';
              if (t && !t.includes('/') && t.length < 50 && !author) author = t;
            });

            // Texto del comentario: buscar span[dir="auto"]
            const textSpans = li.querySelectorAll('span[dir="auto"], div[dir="auto"]');
            let text = '';
            textSpans.forEach(span => {
              const t = span.textContent?.trim() || '';
              // Excluir el texto del autor y la caption
              if (t && t.length > 3 && !t.includes(author) && !captionText.includes(t.slice(0, 20)) && !text) {
                text = t;
              }
            });

            // Alternativa: tomar todo el texto del li y quitar el autor
            if (!text) {
              const allText = li.textContent?.trim() || '';
              text = author ? allText.replace(author, '').trim() : allText.trim();
            }

            // Fecha
            const timeEl = li.querySelector('time');
            const date = timeEl?.getAttribute('datetime') || new Date().toISOString();

            if (text.length > 3 && !seen.has(text.slice(0, 30))) {
              seen.add(text.slice(0, 30));
              items.push({ author: author || 'Instagrammer', text, date });
            }
          });

          return items.slice(0, 30);
        }, { captionText: postData.caption || '', sel: igCommentSel });

        // Screenshots de comentarios
        const liEls = await pPage.$$(igCommentSel);

        for (let j = 0; j < rawComments.length; j++) {
          const c = rawComments[j];
          const isoDate = parseRelativeDate(c.date);
          if (!isRecent(isoDate, days)) continue;

          let cShot: string | undefined;
          const liIdx = j + 1; // +1 para saltar caption
          if (j < 6 && liEls[liIdx]) cShot = await takeScreenshot(liEls[liIdx], 'ig_comment');

          comments.push({
            platform: 'instagram',
            author: c.author,
            text: c.text.slice(0, 600),
            url: postUrl,
            url_fuente: postUrl,
            date: isoDate,
            screenshot: cShot,
          } as any);

          // @menciones
          const tags = c.text.match(/@[\w\u00C0-\u024F]+/g) || [];
          for (const tag of tags) {
            if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
              etiquetados.push({ platform: 'instagram', quien: c.author, texto: c.text.slice(0, 280), url: postUrl, date: isoDate, tipo: 'mencion' });
            }
          }
        }

        console.log(`[Instagram] Post ${postUrl.slice(-15)} → ${rawComments.length} comentarios`);
        await pPage.close();
      } catch (e: any) {
        console.warn('[Instagram] Error en post:', e.message?.slice(0, 80));
        await pPage.close();
      }

      await humanDelay(2500, 5000);
    }

    // Búsqueda adicional por #hashtags en extraTerms
    const extraHashtags = extraTerms
      .filter(t => t.startsWith('#'))
      .map(t => t.replace('#', '').replace(/[^a-z0-9\u00C0-\u024F]/gi, ''))
      .filter(h => h && h.toLowerCase() !== hashtag.toLowerCase());

    for (const extraHash of extraHashtags.slice(0, 2)) {
      try {
        const ePage = await ctx.newPage();
        await ePage.goto(`https://www.instagram.com/explore/tags/${extraHash}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const found = await waitForComments(ePage, 'a[href*="/p/"]', 2, 20000);
        if (found) {
          await delay(2000);
          const extraLinks = await ePage.evaluate(() => {
            const links: string[] = [];
            const seen = new Set<string>();
            document.querySelectorAll('a[href*="/p/"]').forEach(el => {
              const href = (el as HTMLAnchorElement).href || '';
              if (href.includes('/p/') && !seen.has(href)) { seen.add(href); links.push(href); }
            });
            return links.slice(0, 5);
          });
          console.log(`[Instagram] #${extraHash}: ${extraLinks.length} posts extra`);
          // Agregar links únicos al procesamiento (se procesan en el loop principal ya ejecutado,
          // así que los procesamos aquí directamente de forma ligera)
          for (const postUrl of extraLinks) {
            try {
              const pPage = await ctx.newPage();
              await pPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
              await waitForComments(pPage, 'article', 1, 15000);
              await delay(3000);
              const postData = await pPage.evaluate(() => {
                const headerLinks = document.querySelectorAll('header a[href*="/"], article > div a[href*="/"]');
                let author = '';
                headerLinks.forEach(el => { const txt = el.textContent?.trim() || ''; if (txt && !txt.includes('/') && txt.length < 40 && !author) author = txt; });
                const caption = document.querySelector('h1')?.textContent?.trim() || document.querySelector('article span[dir="auto"]')?.textContent?.trim() || '';
                const timeEl = document.querySelector('time');
                return { author, caption, date: timeEl?.getAttribute('datetime') || new Date().toISOString() };
              });
              if (isRecent(postData.date, 30)) {
                mentions.push({ platform: 'instagram', author: postData.author || `#${extraHash}`, text: (postData.caption || `Post #${extraHash}`).slice(0, 400), url: postUrl, date: postData.date, tipo: 'post' } as any);
              }
              await pPage.close();
            } catch { /* ok */ }
          }
        }
        await ePage.close();
      } catch (e: any) {
        console.warn(`[Instagram] Error en #${extraHash}:`, e.message?.slice(0, 50));
      }
    }

    // Verificar perfil oficial
    try {
      await page.goto(`https://www.instagram.com/${hashtag}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(3000);
      const hasHeader = await page.$('header');
      if (hasHeader) {
        const profileData = await page.evaluate(() => {
          const name = document.querySelector('h2, h1')?.textContent?.trim() || '';
          const bio = document.querySelector('div[class*="_aa_c"], section span[class]')?.textContent?.trim() || '';
          const followers = document.querySelector('ul li:nth-child(2) span span')?.textContent?.trim() || '';
          return { name, bio, followers };
        });
        if (profileData.name || profileData.bio) {
          mentions.push({
            platform: 'instagram',
            author: `@${hashtag}`,
            text: `Perfil oficial${profileData.name ? ' — ' + profileData.name : ''}${profileData.bio ? ': ' + profileData.bio.slice(0, 200) : ''}${profileData.followers ? ' | Seguidores: ' + profileData.followers : ''}`,
            url: `https://www.instagram.com/${hashtag}/`,
            date: new Date().toISOString(),
            tipo: 'perfil',
          } as any);
        }
      }
    } catch { /* perfil no existe */ }

    await page.close();
  } catch (e: any) {
    console.error('[Instagram] Error:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
