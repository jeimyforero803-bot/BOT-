/**
 * Twitter/X scraper — sesión guardada + scroll profundo para máximos tweets
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, delay, buildPreciseQuery,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

export async function scrapeTwitter(keyword: string, extraTerms: string[] = [], days = 45): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];
  const useAuth = hasAuth('twitter');
  const ctx = await getContext(useAuth ? 'twitter' : undefined);

  try {
    const page = await ctx.newPage();

    if (useAuth) {
      console.log('[Twitter] Usando sesión guardada...');

      // Frase exacta en vez de "keyword" suelto — evita traer cualquier tweet
      // que solo contenga una palabra del nombre de marca (falsos positivos).
      const preciseQuery = buildPreciseQuery(keyword, extraTerms);
      console.log(`[Twitter] Búsqueda precisa: ${preciseQuery}`);

      // Goto con retry automático — si falla espera 4s y reintenta
      const twSearchUrl = `https://twitter.com/search?q=${encodeURIComponent(preciseQuery)}&src=typed_query&f=live`;
      let twLoaded = false;
      for (let attempt = 0; attempt < 2 && !twLoaded; attempt++) {
        try {
          if (attempt > 0) { console.log('[Twitter] Reintentando carga...'); await delay(4000); }
          await page.goto(twSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          twLoaded = true;
        } catch { /* reintentar */ }
      }
      if (!twLoaded) throw new Error('Twitter no respondió tras 2 intentos');

      const found = await waitForComments(page, '[data-testid="tweet"]', 2, 45000);
      if (!found) {
        await page.goto(
          `https://twitter.com/search?q=${encodeURIComponent(preciseQuery)}&src=typed_query`,
          { waitUntil: 'domcontentloaded', timeout: 60000 }
        );
        await waitForComments(page, '[data-testid="tweet"]', 1, 45000);
      }

      await humanDelay(2000, 3500);

      // Colección incremental — recolectar tweets en cada pasada de scroll
      const allTweets = new Map<string, any>(); // url → tweet data

      const extractTweets = async () => {
        const batch = await page.evaluate(() => {
          const items: {
            author: string; handle: string; text: string; url: string;
            likes: string; retweets: string; replies: string;
            isReply: boolean; date: string;
          }[] = [];

          document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
            const userNameEl = el.querySelector('[data-testid="User-Name"]');
            const authorText = userNameEl?.textContent || '';
            const atIdx = authorText.indexOf('@');
            const name = atIdx > 0 ? authorText.slice(0, atIdx).trim() : authorText.trim();
            const handle = atIdx >= 0 ? '@' + authorText.slice(atIdx + 1).split(/\s|·/)[0].trim() : '';

            const textEl = el.querySelector('[data-testid="tweetText"]');
            const text = textEl?.textContent?.trim() || '';
            if (!text) return;

            const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
            if (!linkEl) return;
            const rawHref = linkEl.href || '';
            const url = rawHref.startsWith('http') ? rawHref : `https://twitter.com${new URL(rawHref).pathname}`;

            const likesEl = el.querySelector('[data-testid="like"] span[data-testid="app-text-transition-container"]');
            const repliesEl = el.querySelector('[data-testid="reply"] span[data-testid="app-text-transition-container"]');
            const retweetEl = el.querySelector('[data-testid="retweet"] span[data-testid="app-text-transition-container"]');
            const timeEl = el.querySelector('time');
            const date = timeEl?.getAttribute('datetime') || new Date().toISOString();

            const isReply = !!(
              el.querySelector('[data-testid="socialContext"]') ||
              el.textContent?.includes('Respondiendo a') ||
              el.textContent?.includes('Replying to')
            );

            items.push({
              author: name, handle, text, url,
              likes: likesEl?.textContent?.trim() || '0',
              retweets: retweetEl?.textContent?.trim() || '0',
              replies: repliesEl?.textContent?.trim() || '0',
              isReply, date,
            });
          });

          return items;
        });

        for (const t of batch) {
          if (!allTweets.has(t.url)) allTweets.set(t.url, t);
        }
      };

      // Clic inicial para dar foco antes de scrollear
      await page.mouse.click(600, 400).catch(() => {});
      await delay(500);

      // Primera extracción — captura tweets visibles al cargar
      await extractTweets();
      console.log(`[Twitter] Ronda 1: ${allTweets.size} tweets`);

      // 18 pasadas de scroll — extrae en cada pasada para no perder nada por virtualización
      for (let pass = 0; pass < 18; pass++) {
        const before = allTweets.size;

        await page.mouse.wheel(0, 800);
        await delay(1800);
        await page.mouse.wheel(0, 600);
        await delay(1500);

        await delay(2000);

        await extractTweets();
        const after = allTweets.size;

        console.log(`[Twitter] Ronda ${pass + 2}: ${after} tweets (+${after - before})`);

        if (after >= 150) break;
        if (after === before && pass > 3) {
          console.log('[Twitter] Sin más tweets nuevos, deteniendo scroll.');
          break;
        }

        await humanDelay(800, 1800);
      }

      // Segunda pasada: buscar tweets recientes con since:
      const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const recentUrl = `https://twitter.com/search?q=${encodeURIComponent(preciseQuery + ` since:${sinceDate}`)}&src=typed_query&f=live`;
      try {
        await page.goto(recentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const recentFound = await waitForComments(page, '[data-testid="tweet"]', 2, 30000);
        if (recentFound) {
          await page.mouse.click(600, 400).catch(() => {});
          await delay(500);
          await humanDelay(2000, 3000);
          for (let pass = 0; pass < 8; pass++) {
            await page.mouse.wheel(0, 800);
            await delay(1800);
            await page.mouse.wheel(0, 600);
            await delay(1500);
            await delay(1500);
            const before = allTweets.size;
            await extractTweets();
            const after = allTweets.size;
            console.log(`[Twitter] Since-pass ${pass + 1}: ${after} tweets (+${after - before})`);
            if (after === before && pass > 2) break;
            await humanDelay(600, 1400);
          }
        }
      } catch (e: any) {
        console.warn('[Twitter] Segunda pasada (since:) falló:', e.message?.slice(0, 60));
      }

      const tweets = Array.from(allTweets.values()).slice(0, 150);
      console.log(`[Twitter] Total: ${tweets.length} tweets únicos`);

      const tweetEls = await page.$$('[data-testid="tweet"]');

      for (let i = 0; i < tweets.length; i++) {
        const t = tweets[i];
        if (!isRecent(t.date, days)) continue;

        let screenshot: string | undefined;
        if (i < 10 && tweetEls[i]) screenshot = await takeScreenshot(tweetEls[i], 'tw_tweet');

        const item: any = {
          platform: 'twitter',
          author: `${t.author} ${t.handle}`.trim(),
          text: t.text.slice(0, 600),
          url: t.url,
          date: t.date,
          likes: parseInt((t.likes || '0').replace(/[^0-9.,K]/g, '').replace(',', '') || '0') || 0,
          screenshot,
        };

        if (t.isReply) {
          comments.push({ ...item, url_fuente: t.url });
        } else {
          mentions.push({ ...item, tipo: 'tweet' });
        }

        // @menciones
        const atTags = t.text.match(/@[\w]+/g) || [];
        for (const tag of atTags) {
          if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'twitter', quien: t.handle || t.author, texto: t.text.slice(0, 280), url: t.url, date: t.date, tipo: 'mencion' });
          }
        }
        // #hashtags
        const hashes = t.text.match(/#[\w\u00C0-\u024F]+/g) || [];
        for (const ht of hashes) {
          if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'twitter', quien: t.handle || t.author, texto: t.text.slice(0, 280), url: t.url, date: t.date, tipo: 'hashtag' });
          }
        }
      }

      console.log(`[Twitter] ${mentions.length} menciones + ${comments.length} replies en búsqueda`);

      // Búsqueda adicional por @handles en extraTerms
      const extraHandles = extraTerms.filter(t => t.startsWith('@'));
      for (const handle of extraHandles.slice(0, 3)) {
        try {
          const hPage = await ctx.newPage();
          const handleQ = `${handle} ${keyword}`;
          await hPage.goto(
            `https://twitter.com/search?q=${encodeURIComponent(handleQ)}&src=typed_query&f=live`,
            { waitUntil: 'domcontentloaded', timeout: 30000 }
          );
          const hFound = await waitForComments(hPage, '[data-testid="tweet"]', 1, 20000);
          if (hFound) {
            await humanDelay(2000, 3000);
            const hTweets = await hPage.evaluate(() => {
              const items: { author: string; handle: string; text: string; url: string; date: string }[] = [];
              const seen = new Set<string>();
              document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
                const userEl = el.querySelector('[data-testid="User-Name"]');
                const authorText = userEl?.textContent || '';
                const atIdx = authorText.indexOf('@');
                const author = atIdx > 0 ? authorText.slice(0, atIdx).trim() : authorText.trim();
                const hndl = atIdx >= 0 ? '@' + authorText.slice(atIdx + 1).split(/\s|·/)[0].trim() : '';
                const text = el.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
                if (!text) return;
                const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
                const url = linkEl?.href || '';
                const date = el.querySelector('time')?.getAttribute('datetime') || new Date().toISOString();
                if (!seen.has(text.slice(0, 30))) { seen.add(text.slice(0, 30)); items.push({ author, handle: hndl, text, url, date }); }
              });
              return items.slice(0, 20);
            });
            for (const t of hTweets) {
              if (!isRecent(t.date, days)) continue;
              if (!allTweets.has(t.url)) {
                allTweets.set(t.url, { ...t, isReply: false, likes: '0', retweets: '0', replies: '0' });
                mentions.push({ platform: 'twitter', author: `${t.author} ${t.handle}`.trim(), text: t.text.slice(0, 600), url: t.url, date: t.date, tipo: 'tweet' } as any);
              }
            }
            console.log(`[Twitter] Handle ${handle}: ${hTweets.length} tweets extra`);
          }
          await hPage.close();
        } catch (e: any) {
          console.warn(`[Twitter] Error buscando ${handle}:`, e.message?.slice(0, 50));
        }
      }

      // Abrir hilos completos — top 12 tweets por engagement (replies + likes/10)
      const scoreEngagement = (t: any) =>
        parseInt(t.replies || '0') * 3 + parseInt((t.likes || '0').replace(/[^0-9]/g, '') || '0') / 10;

      const topTweets = Array.from(allTweets.values())
        .filter(t => isRecent(t.date, days))
        .sort((a, b) => scoreEngagement(b) - scoreEngagement(a))
        .slice(0, 20);

      console.log(`[Twitter] Abriendo ${topTweets.length} hilos para extraer conversación completa...`);
      for (const tweet of topTweets) {
        try {
          const tPage = await ctx.newPage();
          await tPage.goto(tweet.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const repliesFound = await waitForComments(tPage, '[data-testid="tweet"]', 2, 20000);
          if (!repliesFound) { await tPage.close(); continue; }

          // Scroll profundo para cargar toda la conversación
          for (let s = 0; s < 10; s++) {
            await tPage.evaluate(() => window.scrollBy({ top: 900, behavior: 'smooth' }));
            await delay(1800);
          }
          await delay(2000);

          const threadData = await tPage.evaluate((tweetText: string) => {
            const allEls = Array.from(document.querySelectorAll('[data-testid="tweet"]'));
            const items: {
              author: string; handle: string; text: string; date: string; url: string;
              isOP: boolean; isThreadChain: boolean;
            }[] = [];
            const seen = new Set<string>();

            // El primer tweet es el tweet principal
            const mainAuthorEl = allEls[0]?.querySelector('[data-testid="User-Name"]');
            const mainAuthorText = mainAuthorEl?.textContent || '';
            const mainAtIdx = mainAuthorText.indexOf('@');
            const mainHandle = mainAtIdx >= 0
              ? '@' + mainAuthorText.slice(mainAtIdx + 1).split(/\s|·/)[0].trim()
              : '';

            allEls.slice(1).forEach(el => {
              const userNameEl = el.querySelector('[data-testid="User-Name"]');
              const authorText = userNameEl?.textContent || '';
              const atIdx = authorText.indexOf('@');
              const author = atIdx > 0 ? authorText.slice(0, atIdx).trim() : authorText.trim();
              const handle = atIdx >= 0 ? '@' + authorText.slice(atIdx + 1).split(/\s|·/)[0].trim() : '';
              const text = el.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
              if (!text || text.length < 3) return;
              const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
              const url = linkEl?.href || '';
              const date = el.querySelector('time')?.getAttribute('datetime') || new Date().toISOString();

              // Detectar si es parte del hilo del OP (self-reply chain)
              const isOP = !!mainHandle && handle.toLowerCase() === mainHandle.toLowerCase();
              // Detectar si hay línea vertical de hilo (conecta tweets en cadena)
              const hasThreadLine = !!el.closest('[data-testid="cellInnerDiv"]')
                ?.previousElementSibling?.querySelector('[data-testid="tweet"]');

              if (!seen.has(text.slice(0, 30))) {
                seen.add(text.slice(0, 30));
                items.push({ author, handle, text, date, url, isOP, isThreadChain: isOP || hasThreadLine });
              }
            });
            return { items: items.slice(0, 40), mainHandle };
          }, tweet.text);

          const replyEls = await tPage.$$('[data-testid="tweet"]');
          const { items: threadItems, mainHandle } = threadData;

          for (let j = 0; j < threadItems.length; j++) {
            const r = threadItems[j];
            if (!isRecent(r.date, 14)) continue;
            let rShot: string | undefined;
            if (j < 5 && replyEls[j + 1]) rShot = await takeScreenshot(replyEls[j + 1], 'tw_reply');

            // Prefijo de contexto: hilo del autor vs reply externo
            const contextPrefix = r.isOP
              ? `[🧵 Hilo de ${r.handle}] `
              : `[↩ Reply a ${tweet.author}] `;

            comments.push({
              platform: 'twitter',
              author: `${r.author} ${r.handle}`.trim(),
              text: (contextPrefix + r.text).slice(0, 700),
              url: r.url || tweet.url,
              url_fuente: tweet.url,
              date: r.date,
              screenshot: rShot,
            } as any);

            // @menciones y #hashtags en replies
            const atTags2 = r.text.match(/@[\w]+/g) || [];
            for (const tag of atTags2) {
              if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
                etiquetados.push({ platform: 'twitter', quien: r.handle || r.author, texto: r.text.slice(0, 280), url: tweet.url, date: r.date, tipo: 'mencion' });
              }
            }
            const hashes2 = r.text.match(/#[\w\u00C0-\u024F]+/g) || [];
            for (const ht of hashes2) {
              if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
                etiquetados.push({ platform: 'twitter', quien: r.handle || r.author, texto: r.text.slice(0, 280), url: tweet.url, date: r.date, tipo: 'hashtag' });
              }
            }
          }

          const opReplies = threadItems.filter(r => r.isOP).length;
          const extReplies = threadItems.length - opReplies;
          console.log(`[Twitter] Hilo "${tweet.url.slice(-20)}" → ${opReplies} hilo-OP + ${extReplies} replies externos`);
          await tPage.close();
          await humanDelay(2000, 3500);
        } catch (e: any) {
          console.warn('[Twitter] Error en hilo:', e.message?.slice(0, 60));
        }
      }

      console.log(`[Twitter] TOTAL: ${mentions.length} menciones + ${comments.length} replies`);

      // ── Follower count enrichment (top 10 handles) ──
      const parseFC = (raw: string): number => {
        const t = raw.trim().replace(/,/g, '').replace(/\./g, '');
        if (/M$/i.test(t)) return Math.round(parseFloat(t) * 1_000_000);
        if (/K$/i.test(t)) return Math.round(parseFloat(t) * 1_000);
        return parseInt(t) || 0;
      };
      const uniqueHandles = [...new Set(mentions.map(m => {
        const parts = m.author.split(' ');
        return parts.find(p => p.startsWith('@')) || '';
      }).filter(h => h.length > 1))].slice(0, 10);

      if (uniqueHandles.length > 0) {
        console.log(`[Twitter] Enriqueciendo ${uniqueHandles.length} perfiles con seguidores...`);
        const followerMap = new Map<string, number>();
        for (const handle of uniqueHandles) {
          try {
            const pPage = await ctx.newPage();
            await pPage.goto(`https://twitter.com/${handle.replace('@', '')}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await pPage.waitForSelector('a[href*="/followers"]', { timeout: 8000 }).catch(() => {});
            const fRaw = await pPage.evaluate(() => {
              // Método 1: link de seguidores con span numérico
              for (const link of Array.from(document.querySelectorAll('a[href*="/followers"], a[href*="/verified_followers"]'))) {
                for (const span of Array.from(link.querySelectorAll('span'))) {
                  const t = span.textContent?.trim() || '';
                  if (t && /^[\d.,]+[KkMm]?$/.test(t)) return t;
                }
              }
              // Método 2: buscar en aria-label del link de followers
              for (const link of Array.from(document.querySelectorAll('a[href*="/followers"]'))) {
                const aria = (link as HTMLElement).getAttribute('aria-label') || '';
                const m = aria.match(/([\d.,]+[KkMm]?)\s*(follower|seguidor)/i);
                if (m) return m[1];
              }
              // Método 3: buscar spans con texto "Followers" cercano a un número
              const allText = Array.from(document.querySelectorAll('[data-testid="UserProfileHeader_Items"] span, [data-testid="primaryColumn"] span'));
              for (let i = 0; i < allText.length - 1; i++) {
                const t = allText[i].textContent?.trim() || '';
                const next = allText[i + 1]?.textContent?.trim().toLowerCase() || '';
                if (/^[\d.,]+[KkMm]?$/.test(t) && (next.includes('follower') || next.includes('seguidor'))) return t;
              }
              return null;
            });
            if (fRaw) { const n = parseFC(fRaw); if (n > 0) followerMap.set(handle.toLowerCase(), n); }
            await pPage.close();
            await delay(1200);
          } catch { /* skip */ }
        }
        for (const m of mentions) {
          const h = (m.author.split(' ').find(p => p.startsWith('@')) || '').toLowerCase();
          const fc = followerMap.get(h) ?? 0;
          if (fc > 0) { (m as any).follower_count = fc; (m as any).is_influencer = fc >= 5000; }
        }
        console.log(`[Twitter] Seguidores enriquecidos para ${followerMap.size} autores`);
      }

    } else {
      // Sin sesión — Nitter
      console.log('[Twitter] Sin sesión, usando Nitter...');
      await page.goto(
        `https://nitter.net/search?q=${encodeURIComponent(keyword)}&f=tweets`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );
      await waitForComments(page, '.timeline-item', 1, 15000);

      // Scroll Nitter para más resultados
      for (let p = 0; p < 4; p++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await delay(2000);
      }

      const tweets = await page.evaluate(() => {
        const items: { author: string; text: string; url: string; date: string }[] = [];
        document.querySelectorAll('.timeline-item:not(.show-more)').forEach(el => {
          const name = el.querySelector('.fullname')?.textContent?.trim() || '';
          const handle = el.querySelector('.username')?.textContent?.trim() || '';
          const text = el.querySelector('.tweet-content')?.textContent?.trim() || '';
          const link = el.querySelector('.tweet-link') as HTMLAnchorElement;
          const date = el.querySelector('.tweet-date a')?.getAttribute('title') || new Date().toISOString();
          if (text && link) items.push({ author: `${name} ${handle}`.trim(), text, url: 'https://twitter.com' + (link.getAttribute('href') || ''), date });
        });
        const seen = new Set<string>();
        return items.filter(t => { if (seen.has(t.url)) return false; seen.add(t.url); return true; }).slice(0, 50);
      });

      for (const t of tweets) {
        mentions.push({ platform: 'twitter', author: t.author, text: t.text.slice(0, 600), url: t.url, date: parseRelativeDate(t.date), tipo: 'tweet' });
      }
      console.log(`[Twitter/Nitter] ${tweets.length} tweets`);
    }

    await page.close();
  } catch (e: any) {
    console.error('[Twitter] Error:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  return { mentions, comments, etiquetados };
}
