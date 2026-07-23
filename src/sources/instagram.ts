/**
 * Instagram scraper — extracción quirúrgica de comentarios por span[dir="auto"]
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay, buildPreciseQuery,
} from '../browser.js';

// Ancla móvil de "ahora" a la fecha real más reciente vista en el scrape (no
// al reloj de esta máquina) — Instagram procesa posts uno a uno (no en lote),
// así que este valor se actualiza a medida que se descubren fechas reales.
function bumpReference(current: number, isoDate: string): number {
  const t = new Date(isoDate).getTime();
  return !isNaN(t) && t > current ? t : current;
}
import type { Mention, Comment, Etiquetado, ProfilePost, ProfileInfo } from '../types.js';

function parseEngagementCount(raw: string): number {
  const t = (raw || '0').trim().replace(/,/g, '').replace(/\./g, '');
  if (/K$/i.test(t)) return Math.round(parseFloat(t) * 1_000);
  if (/M$/i.test(t)) return Math.round(parseFloat(t) * 1_000_000);
  return parseInt(t.replace(/[^0-9]/g, '') || '0') || 0;
}

/**
 * Visita el perfil propio de un handle y abre sus últimos N posts del grid
 * para sacar likes/comentarios/caption reales — el grid en sí no expone esos
 * números (solo aparecen al hacer hover, que no se puede leer del DOM
 * estático), así que hay que abrir cada post, igual que hace scrapeInstagram
 * con los posts que encuentra por hashtag/keyword.
 */
export async function scrapeInstagramProfile(handle: string, maxPosts = 12): Promise<{
  profile: ProfileInfo | null; posts: ProfilePost[];
}> {
  const clean = handle.replace(/^@/, '').trim();
  if (!hasAuth('instagram')) {
    console.warn('[Instagram Profile] Sin sesión guardada. Corre: npm run setup → Instagram');
    return { profile: null, posts: [] };
  }

  const ctx = await getContext('instagram');
  const posts: ProfilePost[] = [];
  let profile: ProfileInfo | null = null;

  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.instagram.com/${clean}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const hasHeader = await page.waitForSelector('header', { timeout: 20000 }).catch(() => null);
    if (!hasHeader) {
      console.warn(`[Instagram Profile] Perfil @${clean} no encontró header (¿no existe/privado?)`);
      await page.close();
      return { profile: null, posts: [] };
    }
    await humanDelay(2000, 3500);

    const profileData = await page.evaluate(() => {
      const name = document.querySelector('h2, h1')?.textContent?.trim() || '';
      const bio = document.querySelector('div[class*="_aa_c"], section span[class]')?.textContent?.trim() || '';
      const avatar = (document.querySelector('header img') as HTMLImageElement | null)?.src || '';
      let followers = '';
      document.querySelectorAll('header li, header ul li, header span, header div').forEach(el => {
        if (followers) return;
        const t = el.textContent?.trim() || '';
        if (t.length < 30 && /segu|follow/i.test(t) && /^[\d.,]+[KkMm]?/.test(t)) { const m = t.match(/^([\d.,]+[KkMm]?)/); if (m) followers = m[1]; }
      });
      // Fallback: og:description del perfil — server-rendered, no depende del layout
      // en vivo. Formato clásico: "1,234 Followers, 56 Following, 78 Posts - ..."
      if (!followers) {
        const og = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const m = og.match(/([\d.,]+[KkMm]?)\s*(followers|seguidores)/i);
        if (m) followers = m[1];
      }
      return { name, bio, avatar, followers };
    });

    profile = {
      platform: 'instagram',
      handle: `@${clean}`,
      displayName: profileData.name || clean,
      avatar: profileData.avatar || undefined,
      bio: profileData.bio || undefined,
      followers: profileData.followers ? parseEngagementCount(profileData.followers) : undefined,
      profileUrl: `https://www.instagram.com/${clean}/`,
    };

    await humanScroll(page, 3);
    await delay(1500);

    const postLinks: string[] = await page.evaluate((max: number) => {
      const links: string[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(el => {
        const href = (el as HTMLAnchorElement).href || '';
        if (href && !seen.has(href)) { seen.add(href); links.push(href); }
      });
      return links.slice(0, max);
    }, maxPosts);

    console.log(`[Instagram Profile] @${clean} → ${postLinks.length} posts en el grid`);

    for (const postUrl of postLinks) {
      const pPage = await ctx.newPage();
      try {
        await pPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await waitForComments(pPage, 'article', 1, 20000);
        await delay(3000);

        // Meta tags og:* — presentes en el HTML inicial (server-rendered), no
        // dependen de hidratación de React ni de que el layout termine de pintar.
        // Sirven de fallback robusto cuando el scraping del DOM en vivo falla
        // por cambios de Instagram (locale, A/B de layout, contadores ocultos).
        const meta = await pPage.evaluate(() => ({
          ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
          ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
        }));

        // Miniatura: captura visual del post. Espera a que la imagen/video real
        // pinte (no solo el skeleton) antes de disparar el screenshot, con un
        // reintento — evita el placeholder vacío por timing.
        let thumb: string | undefined;
        const articleEl = await pPage.$('article');
        if (articleEl) {
          await pPage.waitForSelector('article img[src], article video', { state: 'visible', timeout: 8000 }).catch(() => {});
          thumb = await takeScreenshot(articleEl, 'ig_profile_post');
          if (!thumb) {
            await delay(1500);
            thumb = await takeScreenshot(articleEl, 'ig_profile_post');
          }
        }
        if (!thumb) thumb = meta.ogImage || undefined;

        // IMPORTANTE: todas las queries van escopadas a articleEl (el post), NO a
        // document — hacerlo document-wide capturaba texto de la navegación fija
        // de la página (ej. el link "Inicio" del sidebar) en vez del contenido
        // real del post, y el selector de likes podía matchear cualquier <section>
        // de la página en vez de la del post.
        const postData = articleEl
          ? await articleEl.evaluate((article: Element) => {
              let caption = '';
              article.querySelectorAll('h1, span[dir="auto"], div[dir="auto"]').forEach(el => {
                const txt = el.textContent?.trim() || '';
                if (txt.length > 5 && !caption) caption = txt;
              });
              const likesEl = article.querySelector('section span[class], [class*="like_count"]');
              const likes = likesEl?.textContent?.trim() || '0';
              const timeEl = article.querySelector('time');
              const date = timeEl?.getAttribute('datetime') || '';
              // Videos/reels muestran "views" en vez de likes en algunos layouts
              let views = '';
              let commentsCount = '';
              article.querySelectorAll('span, a').forEach(s => {
                const t = s.textContent?.trim() || '';
                if (!views && /^[\d.,]+[KkMm]?\s*(reproducci|view)/i.test(t)) { const m = t.match(/^([\d.,]+[KkMm]?)/); if (m) views = m[1]; }
                if (!commentsCount && /(ver los|view all|comentario|comment)/i.test(t) && /[\d.,]+[KkMm]?/.test(t)) {
                  const m = t.match(/([\d.,]+[KkMm]?)\s*(comentario|comment)/i);
                  if (m) commentsCount = m[1];
                }
              });
              return { caption, likes, date, views, commentsCount };
            })
          : { caption: '', likes: '0', date: '', views: '', commentsCount: '' };

        // Fallback de likes/comentarios desde og:description si el DOM no dio nada
        // (formato clásico IG: "1,234 Likes, 56 Comments - user on Instagram: ...")
        let likesRaw = postData.likes;
        let commentsRaw = postData.commentsCount;
        if ((!likesRaw || likesRaw === '0') && meta.ogDescription) {
          const m = meta.ogDescription.match(/([\d.,]+[KkMm]?)\s*(likes|me gusta)/i);
          if (m) likesRaw = m[1];
        }
        if (!commentsRaw && meta.ogDescription) {
          const m = meta.ogDescription.match(/([\d.,]+[KkMm]?)\s*(comments|comentarios)/i);
          if (m) commentsRaw = m[1];
        }
        // Fallback de caption desde og:description — formato clásico IG:
        // '1,234 Likes, 56 Comments - user on Instagram: "texto del caption"'
        let captionOut = postData.caption;
        if (!captionOut && meta.ogDescription) {
          const m = meta.ogDescription.match(/:\s*[“"](.+)[”"]\s*$/);
          if (m) captionOut = m[1];
        }

        posts.push({
          platform: 'instagram',
          url: postUrl,
          thumbnail: thumb,
          caption: (captionOut || '').slice(0, 500),
          date: postData.date || new Date().toISOString(),
          likes: parseEngagementCount(likesRaw),
          comments: commentsRaw ? parseEngagementCount(commentsRaw) : 0,
          views: postData.views ? parseEngagementCount(postData.views) : undefined,
        });
      } catch (e: any) {
        console.warn('[Instagram Profile] Error en post:', e.message?.slice(0, 80));
      }
      await pPage.close();
      await humanDelay(1800, 3000);
    }

    console.log(`[Instagram Profile] @${clean} → ${posts.length} posts extraídos`);
    await page.close();
  } catch (e: any) {
    console.error('[Instagram Profile] Error:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  return { profile, posts };
}

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

    let referenceNow = Date.now();

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

        referenceNow = bumpReference(referenceNow, postData.date);

        // Filtrar posts antiguos (> 30 días)
        if (!isRecent(postData.date, days, referenceNow)) {
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
        let expandClickedAny = false;
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
                expandClickedAny = true;
                break;
              }
            }
            if (!clicked) break;
          } catch { break; }
        }

        // Si no había botón de "cargar más" y ya se ven pocos comentarios, es un
        // hilo corto (1-2 comentarios visibles a simple vista) — el scroll agresivo
        // y las esperas largas de abajo no van a revelar nada nuevo, solo hacían que
        // el agente se quedara medio minuto extra en posts que ya estaban completos.
        const quickCommentCount = await pPage.evaluate(() =>
          document.querySelectorAll('article ul li, section ul li, [role="list"] li').length
        ).catch(() => 0);
        const likelyShortThread = !expandClickedAny && quickCommentCount <= 4;

        if (!likelyShortThread) {
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
        } else {
          await humanScroll(pPage, 1);
          await delay(800);
        }

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
          referenceNow = bumpReference(referenceNow, isoDate);
          if (!isRecent(isoDate, days, referenceNow)) continue;

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
              referenceNow = bumpReference(referenceNow, postData.date);
              if (isRecent(postData.date, 30, referenceNow)) {
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
