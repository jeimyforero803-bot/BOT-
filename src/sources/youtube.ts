/**
 * YouTube scraper — extracción quirúrgica de comentarios con waitForFunction
 * Espera que los comentarios realmente aparezcan en el DOM antes de extraer
 */
import {
  getContext, humanDelay, humanScroll, takeScreenshot,
  scrollToLoadComments, waitForComments, parseRelativeDate, isRecent, delay,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeYouTube(keyword: string, _extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];
  const ctx = await getContext();
  const kw = keyword.toLowerCase().replace(/\s+/g, '');

  try {
    const page = await ctx.newPage();
    console.log('[YouTube] Buscando videos recientes...');

    // Filtro: última semana (sp=EgIIAw%3D%3D) o último mes (sp=EgIIBA%3D%3D)
    // Goto con retry automático — si falla el primer intento espera 4s y reintenta
    const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIIBA%3D%3D`;
    const ytFallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`;
    let ytLoaded = false;
    for (let attempt = 0; attempt < 2 && !ytLoaded; attempt++) {
      try {
        if (attempt > 0) { console.log('[YouTube] Reintentando carga...'); await delay(4000); }
        await page.goto(ytSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        ytLoaded = true;
      } catch { /* reintentar */ }
    }
    if (!ytLoaded) throw new Error('YouTube no respondió tras 2 intentos');

    try {
      await page.waitForSelector('ytd-video-renderer', { timeout: 40000 });
    } catch {
      await page.goto(ytFallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('ytd-video-renderer', { timeout: 40000 }).catch(() => {});
    }

    await humanDelay(2500, 4000);

    const videos = await page.evaluate(() => {
      const items: { id: string; title: string; channel: string; url: string; views: string; published: string }[] = [];
      document.querySelectorAll('ytd-video-renderer').forEach(el => {
        const titleEl = el.querySelector('#video-title');
        const channelEl = el.querySelector('#channel-name a, .ytd-channel-name a');
        const metaSpans = el.querySelectorAll('#metadata-line span');
        const href = (titleEl as HTMLAnchorElement)?.href || '';
        const match = href.match(/v=([^&]+)/);
        if (match && titleEl?.textContent?.trim()) {
          items.push({
            id: match[1],
            title: titleEl.textContent.trim(),
            channel: channelEl?.textContent?.trim() || 'Canal',
            url: href,
            views: metaSpans[0]?.textContent?.trim() || '',
            published: metaSpans[1]?.textContent?.trim() || '',
          });
        }
      });
      return items.slice(0, 8);
    });

    console.log(`[YouTube] ${videos.length} videos encontrados`);
    const videoEls = await page.$$('ytd-video-renderer');

    for (let i = 0; i < videos.length; i++) {
      const vid = videos[i];
      let screenshot: string | undefined;
      if (i < 5 && videoEls[i]) screenshot = await takeScreenshot(videoEls[i], 'yt_video');

      const vidDate = parseRelativeDate(vid.published);
      // YouTube usa mínimo 14 días para no perder videos recientes en scans cortos (7d)
      if (!isRecent(vidDate, days >= 1 ? Math.max(days, 14) : days)) {
        console.log(`[YouTube] Saltando video antiguo: "${vid.title.slice(0, 40)}" (${vid.published})`);
        continue;
      }

      mentions.push({
        platform: 'youtube',
        author: vid.channel,
        text: `${vid.title}${vid.views ? ' — ' + vid.views : ''}${vid.published ? ' — ' + vid.published : ''}`,
        url: vid.url,
        date: vidDate,
        tipo: 'video',
        screenshot,
      } as any);

      // Abrir video y extraer comentarios quirúrgicamente
      try {
        const vPage = await ctx.newPage();
        console.log(`[YouTube] Abriendo "${vid.title.slice(0, 45)}"...`);

        await vPage.goto(vid.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Paso 1: esperar carga inicial del player
        await delay(3500);

        // Paso 2: scroll inicial para cargar la página
        await delay(2000);
        await vPage.evaluate(() => window.scrollBy(0, 400));
        await delay(1500);

        // Paso 2b: scroll directo al elemento ytd-comments — más preciso que ir al fondo
        // YouTube usa IntersectionObserver en ytd-comments; hay que llevarlo al viewport
        for (let bounce = 0; bounce < 8; bounce++) {
          await vPage.evaluate(() => {
            const el = document.querySelector('ytd-comments, #comments');
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
              window.scrollTo(0, document.body.scrollHeight * 0.6);
            }
          });
          await delay(2500);
          const earlyCheck: number = await vPage.evaluate(
            () => document.querySelectorAll('ytd-comment-thread-renderer').length
          );
          if (earlyCheck > 0) { console.log(`[YouTube] Comentarios cargados en bounce ${bounce + 1}`); break; }
          // Alterna: sube un poco y vuelve a bajar para re-trigger IntersectionObserver
          await vPage.evaluate(() => window.scrollBy(0, -300));
          await delay(600);
        }

        // Paso 3: espera quirúrgica — no continuar hasta que haya comentarios reales (90s)
        console.log(`[YouTube] Esperando comentarios en "${vid.title.slice(0, 35)}"...`);
        const found = await waitForComments(vPage, 'ytd-comment-thread-renderer', 1, 90000);

        if (!found) {
          console.warn(`[YouTube] Sin comentarios en "${vid.title.slice(0, 35)}"`);
          await vPage.close();
          continue;
        }

        // Paso 4: scroll adicional para cargar más comentarios
        await humanScroll(vPage, 4);
        await delay(3000);

        // Extraer contador de suscriptores del canal
        const subCountRaw = await vPage.evaluate(() => {
          // Múltiples selectores para distintas versiones del DOM de YouTube
          const selectors = [
            '#owner-sub-count',
            'yt-formatted-string#owner-sub-count',
            '#subscribers-count',
            'ytd-video-owner-renderer #subscriber-count',
            'ytd-channel-name ~ * yt-formatted-string',
            '#channel-info #subscriber-count',
            'ytd-subscribe-button-renderer + * yt-formatted-string',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            const t = el?.textContent?.trim() || '';
            if (t && /[\d.,KkMmBb]/.test(t)) return t;
          }
          // Fallback: buscar texto "subscribers" cerca de un número en el DOM
          const spans = Array.from(document.querySelectorAll('span, yt-formatted-string'));
          for (const span of spans) {
            const t = span.textContent?.trim() || '';
            if (/^[\d.,]+[KkMmBb]?\s*(subscriber|suscriptor)/i.test(t)) {
              const m = t.match(/^([\d.,]+[KkMmBb]?)/i);
              if (m) return m[1];
            }
          }
          return null;
        });
        if (subCountRaw) {
          const parseSubCount = (raw: string): number => {
            const t = raw.replace(/[^0-9.,KkMmBb]/g, '').trim();
            if (/[Bb]$/.test(t)) return Math.round(parseFloat(t) * 1_000_000_000);
            if (/[Mm]$/.test(t)) return Math.round(parseFloat(t) * 1_000_000);
            if (/[Kk]$/.test(t)) return Math.round(parseFloat(t) * 1_000);
            return parseInt(t.replace(/[.,]/g, '')) || 0;
          };
          const subCount = parseSubCount(subCountRaw);
          if (subCount > 0) {
            const vidMention = mentions.find(m => m.url === vid.url);
            if (vidMention) {
              (vidMention as any).follower_count = subCount;
              (vidMention as any).is_influencer = subCount >= 5000;
            }
            console.log(`[YouTube] Canal "${vid.channel}" → ${subCount.toLocaleString()} suscriptores`);
          }
        }

        // Extraer comentarios con fecha y autor exactos
        const rawComments = await vPage.evaluate(() => {
          const items: { author: string; text: string; likes: string; date: string }[] = [];
          document.querySelectorAll('ytd-comment-thread-renderer').forEach(el => {
            const authorEl = el.querySelector('#author-text span, #author-text a');
            const textEl = el.querySelector('#content-text');
            const likesEl = el.querySelector('#vote-count-middle');
            const dateEl = el.querySelector('.published-time-text a, yt-formatted-string.published-time-text');
            const author = authorEl?.textContent?.trim() || 'Usuario';
            const text = textEl?.textContent?.trim() || '';
            const likes = likesEl?.textContent?.trim() || '0';
            const date = dateEl?.textContent?.trim() || dateEl?.getAttribute('href')?.match(/lc=([^&]+)/)?.[1] || '';
            if (text.length > 5) items.push({ author, text, likes, date });
          });
          return items.slice(0, 25);
        });

        const commentEls = await vPage.$$('ytd-comment-thread-renderer');

        for (let j = 0; j < rawComments.length; j++) {
          const c = rawComments[j];
          const isoDate = parseRelativeDate(c.date);

          // Solo comentarios recientes (30 días)
          if (!isRecent(isoDate, days)) continue;

          let cScreenshot: string | undefined;
          if (j < 6 && commentEls[j]) cScreenshot = await takeScreenshot(commentEls[j], 'yt_comment');

          comments.push({
            platform: 'youtube',
            author: c.author,
            text: c.text.slice(0, 600),
            url: vid.url,
            url_fuente: vid.url,
            date: isoDate,
            likes: parseInt(c.likes.replace(/[^0-9]/g, '') || '0') || 0,
            screenshot: cScreenshot,
          } as any);

          // @menciones
          const tags = c.text.match(/@[\w\u00C0-\u024F]+/g) || [];
          for (const tag of tags) {
            if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
              etiquetados.push({ platform: 'youtube', quien: c.author, texto: c.text.slice(0, 280), url: vid.url, date: isoDate, tipo: 'mencion' });
            }
          }
          // #hashtags
          const hashes = c.text.match(/#[\w\u00C0-\u024F]+/g) || [];
          for (const ht of hashes) {
            if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
              etiquetados.push({ platform: 'youtube', quien: c.author, texto: c.text.slice(0, 280), url: vid.url, date: isoDate, tipo: 'hashtag' });
            }
          }
        }

        console.log(`[YouTube] "${vid.title.slice(0, 40)}" → ${rawComments.length} comentarios extraídos`);
        await vPage.close();
      } catch (e: any) {
        console.warn(`[YouTube] Error en video "${vid.title.slice(0, 30)}":`, e.message?.slice(0, 80));
      }

      await humanDelay(2000, 4000);
    }

    await page.close();
  } catch (e: any) {
    console.error('[YouTube] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
