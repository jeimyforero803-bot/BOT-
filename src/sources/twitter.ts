/**
 * Twitter/X scraper — sesión guardada + scroll profundo para máximos tweets
 */
import {
  getContext, hasAuth, humanDelay,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, getBatchReferenceNow, delay, buildPreciseQuery,
} from '../browser.js';
import type { Mention, Comment, Etiquetado, ProfilePost, ProfileInfo } from '../types.js';

type RawTweet = {
  author: string; handle: string; text: string; url: string;
  likes: string; retweets: string; replies: string;
  isReply: boolean; date: string; screenshot?: string;
};

// Captura pantallazos justo después de cada pasada de búsqueda, mientras esa
// página sigue cargada — con bloques mensuales, `page` termina en el último
// bloque buscado, así que capturar al final (como se hacía antes) desalinea
// los índices con el DOM real de cada bloque.
//
// Solo vale la pena el pantallazo en los de MAYOR impacto (más likes) — el
// resto ya queda cubierto con su link, no hace falta capturarlos todos y eso
// ahorra tiempo de scan. Se prioriza por likes en vez de tomar los primeros
// N en orden de aparición, y se matchea el elemento del DOM por la URL del
// tweet (no por posición) porque el orden de inserción no necesariamente
// coincide con el orden actual en pantalla tras varias pasadas de scroll.
async function captureFirstScreenshots(page: any, tweetsMap: Map<string, RawTweet>, limit: number): Promise<void> {
  if (limit <= 0) return;
  const candidates = Array.from(tweetsMap.values())
    .filter(t => !t.screenshot)
    .sort((a, b) => parseEngagementCount(b.likes) - parseEngagementCount(a.likes))
    .slice(0, limit);
  if (candidates.length === 0) return;

  const tweetEls = await page.$$('[data-testid="tweet"]');
  const elIndexByUrl = new Map<string, number>();
  for (let i = 0; i < tweetEls.length; i++) {
    const url: string = await tweetEls[i].evaluate((node: Element) =>
      (node.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.href || ''
    ).catch(() => '');
    if (url && !elIndexByUrl.has(url)) elIndexByUrl.set(url, i);
  }

  for (const t of candidates) {
    const idx = elIndexByUrl.get(t.url);
    if (idx === undefined) continue;
    const shot = await takeScreenshot(tweetEls[idx], 'tw_tweet');
    if (shot) t.screenshot = shot;
  }
}

// Muestreo con paso fijo a través de toda la línea de tiempo (ordenada por
// fecha) — evita que un recorte simple ([0, limit)) termine mostrando solo el
// bloque más antiguo (o el más nuevo) cuando hay más resultados que el tope.
function sampleAcrossRange<T extends { date: string }>(items: T[], limit: number): T[] {
  const sorted = [...items].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (sorted.length <= limit) return sorted;
  const step = sorted.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(sorted[Math.floor(i * step)]);
  return out;
}

function addDaysISO(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Divide [start, end] en bloques mensuales — cada bloque tiene su PROPIO tope
// de 300 tweets/60 pasadas de scroll (ver searchAndScrollTweets). Sin esto, un
// rango largo (ej. 7 meses) con volumen alto de tweets recientes agotaba el
// tope entero scrolleando solo el mes más reciente y nunca llegaba a los meses
// de atrás — el usuario pedía "desde enero hasta hoy" y solo recibía el último mes.
function buildMonthChunks(startStr: string, endStr: string, maxChunks = 12): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let cursor = startStr;
  const endD = new Date(endStr + 'T00:00:00').getTime();
  while (new Date(cursor + 'T00:00:00').getTime() <= endD && chunks.length < maxChunks) {
    const cursorD = new Date(cursor + 'T00:00:00');
    const monthEndD = new Date(cursorD.getFullYear(), cursorD.getMonth() + 1, 0);
    const chunkEnd = monthEndD.getTime() < endD ? monthEndD.toISOString().slice(0, 10) : endStr;
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = addDaysISO(chunkEnd, 1);
  }
  return chunks;
}

/**
 * Busca "query" en X y scrollea hasta que el tweet más viejo visto cruce
 * `targetStartMs` (fecha de inicio pedida) — igual que alguien scrolleando
 * manualmente hasta encontrar esa fecha, en vez de un número fijo de pasadas.
 *
 * IMPORTANTE: usa `page.evaluate(() => window.scrollBy(...))` para scrollear,
 * NO `page.mouse.wheel()` — en Chromium headless, mouse.wheel() dejaba de
 * mover la página después de la primera pasada (scrollY se quedaba fijo para
 * siempre), lo que hacía que el scraper concluyera "sin más tweets" tras
 * encontrar solo un puñado, cuando en realidad había muchísimo más contenido
 * disponible (confirmado comparando contra una sesión real scrolleada a mano).
 */
async function searchAndScrollTweets(page: any, query: string, targetStartMs: number): Promise<Map<string, RawTweet>> {
  const twSearchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  let loaded = false;
  for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
    try {
      if (attempt > 0) { console.log('[Twitter] Reintentando carga...'); await delay(4000); }
      await page.goto(twSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      loaded = true;
    } catch { /* reintentar */ }
  }
  if (!loaded) throw new Error('Twitter no respondió tras 2 intentos');

  const found = await waitForComments(page, '[data-testid="tweet"]', 2, 45000);
  if (!found) {
    await page.goto(
      `https://twitter.com/search?q=${encodeURIComponent(query)}&src=typed_query`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await waitForComments(page, '[data-testid="tweet"]', 1, 45000);
  }

  await humanDelay(2000, 3500);

  const allTweets = new Map<string, RawTweet>();

  const extractTweets = async () => {
    const batch: RawTweet[] = await page.evaluate(() => {
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

  await extractTweets();
  console.log(`[Twitter] Ronda 1: ${allTweets.size} tweets`);

  const oldestSeenMs = (): number => {
    let min = Infinity;
    for (const t of allTweets.values()) {
      const ms = new Date(t.date).getTime();
      if (!isNaN(ms) && ms < min) min = ms;
    }
    return min;
  };

  let noNewStreak = 0;
  const MAX_PASSES = 60;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = allTweets.size;

    await page.evaluate(() => window.scrollBy(0, 1400));
    await delay(2200);

    await extractTweets();
    const after = allTweets.size;

    console.log(`[Twitter] Pasada ${pass + 2}: ${after} tweets (+${after - before})`);

    if (after >= 300) { console.log('[Twitter] Tope de 300 tweets, deteniendo scroll.'); break; }

    const oldest = oldestSeenMs();
    if (oldest <= targetStartMs) {
      console.log(`[Twitter] Fecha de inicio alcanzada (tweet más viejo visto: ${new Date(oldest).toISOString().slice(0, 10)}), deteniendo scroll.`);
      break;
    }

    if (after === before) {
      noNewStreak++;
      if (noNewStreak > 4) { console.log('[Twitter] Sin más tweets nuevos, deteniendo scroll.'); break; }
    } else {
      noNewStreak = 0;
    }

    await humanDelay(500, 1000);
  }

  return allTweets;
}

/**
 * Abre los hilos de los tweets con más engagement y extrae sus replies —
 * separado de la búsqueda/scroll principal para poder probar/depurar cada
 * etapa de forma aislada.
 */
async function openThreadsForReplies(
  ctx: any,
  topTweets: RawTweet[],
  keyword: string,
  relevanceTerms: string[],
  referenceNow: number,
): Promise<{ comments: Comment[]; etiquetados: Etiquetado[] }> {
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];

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

          const isOP = !!mainHandle && handle.toLowerCase() === mainHandle.toLowerCase();
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
      const { items: threadItems } = threadData;

      for (let j = 0; j < threadItems.length; j++) {
        const r = threadItems[j];
        if (!isRecent(r.date, 14, referenceNow)) continue;
        // Los replies externos (no del hilo del propio autor) solo se guardan si
        // de verdad mencionan la marca — si no, es una conversación ajena que
        // solo coincidió de estar en el mismo hilo.
        const replyTextLower = r.text.toLowerCase();
        const isRelevantReply = relevanceTerms.length > 1
          ? relevanceTerms.every(w => replyTextLower.includes(w))
          : relevanceTerms.some(w => replyTextLower.includes(w));
        if (!r.isOP && !isRelevantReply) continue;
        let rShot: string | undefined;
        if (j < 5 && replyEls[j + 1]) rShot = await takeScreenshot(replyEls[j + 1], 'tw_reply');

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

        const atTags2 = r.text.match(/@[\w]+/g) || [];
        for (const tag of atTags2) {
          if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'twitter', quien: r.handle || r.author, texto: r.text.slice(0, 280), url: tweet.url, date: r.date, tipo: 'mencion' });
          }
        }
        const hashes2 = r.text.match(/#[\wÀ-ɏ]+/g) || [];
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

  return { comments, etiquetados };
}

/** Enriquece las menciones con el conteo de seguidores del autor (top 10 handles únicos). */
async function enrichFollowerCounts(ctx: any, mentions: Mention[]): Promise<void> {
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

  if (uniqueHandles.length === 0) return;

  console.log(`[Twitter] Enriqueciendo ${uniqueHandles.length} perfiles con seguidores...`);
  const followerMap = new Map<string, { count: number; avatar?: string }>();
  for (const handle of uniqueHandles) {
    try {
      const pPage = await ctx.newPage();
      await pPage.goto(`https://twitter.com/${handle.replace('@', '')}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await pPage.waitForSelector('a[href*="/followers"]', { timeout: 8000 }).catch(() => {});
      const data = await pPage.evaluate(() => {
        let fRaw: string | null = null;
        for (const link of Array.from(document.querySelectorAll('a[href*="/followers"], a[href*="/verified_followers"]'))) {
          for (const span of Array.from(link.querySelectorAll('span'))) {
            const t = span.textContent?.trim() || '';
            if (t && /^[\d.,]+[KkMm]?$/.test(t)) { fRaw = t; break; }
          }
          if (fRaw) break;
        }
        if (!fRaw) {
          for (const link of Array.from(document.querySelectorAll('a[href*="/followers"]'))) {
            const aria = (link as HTMLElement).getAttribute('aria-label') || '';
            const m = aria.match(/([\d.,]+[KkMm]?)\s*(follower|seguidor)/i);
            if (m) { fRaw = m[1]; break; }
          }
        }
        if (!fRaw) {
          const allText = Array.from(document.querySelectorAll('[data-testid="UserProfileHeader_Items"] span, [data-testid="primaryColumn"] span'));
          for (let i = 0; i < allText.length - 1; i++) {
            const t = allText[i].textContent?.trim() || '';
            const next = allText[i + 1]?.textContent?.trim().toLowerCase() || '';
            if (/^[\d.,]+[KkMm]?$/.test(t) && (next.includes('follower') || next.includes('seguidor'))) { fRaw = t; break; }
          }
        }
        // Foto de perfil — solo vale la pena capturarla acá (ya estamos en la
        // página del perfil por el follower count); no se hace por cada mención.
        const avatarEl = document.querySelector('a[href*="/photo"] img, [data-testid="UserAvatar-Container"] img') as HTMLImageElement | null;
        return { fRaw, avatar: avatarEl?.src || undefined };
      });
      if (data.fRaw) {
        const n = parseFC(data.fRaw);
        if (n > 0) followerMap.set(handle.toLowerCase(), { count: n, avatar: data.avatar });
      }
      await pPage.close();
      await delay(1200);
    } catch { /* skip */ }
  }
  for (const m of mentions) {
    const h = (m.author.split(' ').find(p => p.startsWith('@')) || '').toLowerCase();
    const entry = followerMap.get(h);
    const fc = entry?.count ?? 0;
    if (fc > 0) {
      (m as any).follower_count = fc;
      (m as any).is_influencer = fc >= 5000;
      // Miniatura de perfil solo para influencers relevantes — no para cualquier autor.
      if (fc >= 5000 && entry?.avatar) (m as any).avatar = entry.avatar;
    }
  }
  console.log(`[Twitter] Seguidores enriquecidos para ${followerMap.size} autores`);
}

// OJO: la firma debe respetar (kw, extra, days, exclusions, sinceDate, untilDate)
// tal cual el tipo Scraper en server.ts — antes esta función solo declaraba 5
// parámetros y llamaba "untilDate" a lo que en realidad llegaba en la posición
// de sinceDate (la fecha "desde"), así que el filtro until: de Twitter se
// aplicaba con la fecha de inicio en vez de la de fin.
export async function scrapeTwitter(keyword: string, extraTerms: string[] = [], days = 45, _exclusions?: string[], sinceDate?: string, untilDate?: string): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  let mentions: Mention[] = [];
  let comments: Comment[] = [];
  let etiquetados: Etiquetado[] = [];
  const useAuth = hasAuth('twitter');
  const ctx = await getContext(useAuth ? 'twitter' : undefined);

  try {
    const page = await ctx.newPage();

    if (useAuth) {
      console.log('[Twitter] Usando sesión guardada...');

      // Si hay un @handle real (cuenta oficial verificada), buscar EXCLUSIVAMENTE
      // eso — es mucho más preciso que la palabra suelta. "ETB" solo trae ruido
      // de cuentas ajenas que comparten la sigla (ETB vasca, "Elite Trainer Box"
      // de Pokémon); "@ETB" sólo aparece cuando alguien etiqueta A ESA cuenta.
      const handle = extraTerms.find(t => t.startsWith('@'));
      const baseQuery = handle || buildPreciseQuery(keyword, extraTerms);

      // Rangos largos (>35 días) con volumen alto de tweets recientes agotaban
      // el tope de 300/60 pasadas scrolleando solo el mes más reciente y nunca
      // llegaban a "sinceDate" — se divide en bloques mensuales, cada uno con
      // su propio tope, para garantizar cobertura de TODO el rango pedido.
      const effectiveUntil = untilDate || new Date().toISOString().slice(0, 10);
      const allTweets = new Map<string, RawTweet>();
      if (sinceDate && days > 35) {
        const chunks = buildMonthChunks(sinceDate, effectiveUntil);
        const shotsPerChunk = Math.max(1, Math.floor(10 / chunks.length));
        console.log(`[Twitter] Rango de ${days} días (${sinceDate} → ${effectiveUntil}) — dividiendo en ${chunks.length} bloque(s) mensual(es) para cubrir todo el rango`);
        for (const chunk of chunks) {
          const chunkQuery = `${baseQuery} since:${chunk.start} until:${addDaysISO(chunk.end, 1)}`;
          console.log(`[Twitter] Bloque ${chunk.start} → ${chunk.end}: ${chunkQuery}`);
          try {
            const chunkTweets = await searchAndScrollTweets(page, chunkQuery, new Date(chunk.start + 'T00:00:00').getTime());
            await captureFirstScreenshots(page, chunkTweets, shotsPerChunk);
            for (const [url, t] of chunkTweets) allTweets.set(url, t);
          } catch (e: any) {
            console.warn(`[Twitter] Error en bloque ${chunk.start}→${chunk.end}:`, e.message?.slice(0, 80));
          }
          await humanDelay(1500, 2500);
        }
      } else {
        // Si el rango pedido termina en el pasado (no "hoy"), usamos until: para
        // que X arranque la búsqueda directo ahí — si no, el scroll parte desde
        // hoy y gasta el tope de tweets en contenido reciente que de todos modos
        // se iba a descartar por estar fuera del rango pedido.
        const isPastEnd = untilDate && (Date.now() - new Date(untilDate).getTime()) > 2 * 86400000;
        const preciseQuery = isPastEnd ? `${baseQuery} until:${untilDate}` : baseQuery;
        console.log(`[Twitter] Búsqueda precisa: ${preciseQuery}`);

        const targetStartMs = Date.now() - days * 86400000;
        const singlePass = await searchAndScrollTweets(page, preciseQuery, targetStartMs);
        await captureFirstScreenshots(page, singlePass, 10);
        for (const [url, t] of singlePass) allTweets.set(url, t);
      }

      // Con rangos largos se prioriza cubrir TODO el período pedido en vez de
      // solo los primeros 300 en orden de inserción (que serían los del bloque
      // más antiguo) — se muestrea proporcionalmente por bloque de tiempo si
      // hay más de 300 tweets acumulados entre todos los meses.
      const allTweetsList = Array.from(allTweets.values());
      const tweets = allTweetsList.length <= 300 ? allTweetsList : sampleAcrossRange(allTweetsList, 300);
      console.log(`[Twitter] Total: ${tweets.length} tweets únicos`);

      // Ancla "ahora" a la fecha real más reciente vista en el scrape, no al
      // reloj de esta máquina: X entrega fechas absolutas reales y si el reloj
      // local está desincronizado, comparar contra Date.now() descarta todo
      // como "viejo" y la búsqueda vuelve 0 resultados aunque sí haya tweets recientes.
      const referenceNow = getBatchReferenceNow(tweets.map(t => t.date));

      for (let i = 0; i < tweets.length; i++) {
        const t = tweets[i];
        if (!isRecent(t.date, days, referenceNow)) continue;

        // El pantallazo ya se capturó justo después de cada búsqueda (ver
        // captureFirstScreenshots) — hacerlo acá con el DOM actual desalineaba
        // los índices en cuanto hubo más de una pasada/bloque de búsqueda.
        const screenshot = t.screenshot;

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

        const atTags = t.text.match(/@[\w]+/g) || [];
        for (const tag of atTags) {
          if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'twitter', quien: t.handle || t.author, texto: t.text.slice(0, 280), url: t.url, date: t.date, tipo: 'mencion' });
          }
        }
        const hashes = t.text.match(/#[\wÀ-ɏ]+/g) || [];
        for (const ht of hashes) {
          if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5)))) {
            etiquetados.push({ platform: 'twitter', quien: t.handle || t.author, texto: t.text.slice(0, 280), url: t.url, date: t.date, tipo: 'hashtag' });
          }
        }
      }

      console.log(`[Twitter] ${mentions.length} menciones + ${comments.length} replies en búsqueda`);

      // Búsqueda adicional por otros @handles en extraTerms — si ya usamos un
      // handle como búsqueda principal (arriba), no repetirlo aquí.
      const extraHandles = extraTerms.filter(t => t.startsWith('@') && t !== handle);
      for (const handle2 of extraHandles.slice(0, 3)) {
        try {
          const hPage = await ctx.newPage();
          const handleQ = `${handle2} ${keyword}`;
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
              if (!isRecent(t.date, days, referenceNow)) continue;
              if (!allTweets.has(t.url)) {
                allTweets.set(t.url, { ...t, isReply: false, likes: '0', retweets: '0', replies: '0' });
                mentions.push({ platform: 'twitter', author: `${t.author} ${t.handle}`.trim(), text: t.text.slice(0, 600), url: t.url, date: t.date, tipo: 'tweet' } as any);
              }
            }
            console.log(`[Twitter] Handle ${handle2}: ${hTweets.length} tweets extra`);
          }
          await hPage.close();
        } catch (e: any) {
          console.warn(`[Twitter] Error buscando ${handle2}:`, e.message?.slice(0, 50));
        }
      }

      // Abrir hilos completos — top 20 tweets por engagement (replies + likes/10)
      const scoreEngagement = (t: RawTweet) =>
        parseInt(t.replies || '0') * 3 + parseInt((t.likes || '0').replace(/[^0-9]/g, '') || '0') / 10;

      // Palabras de la marca — un hilo popular puede derivar a temas totalmente
      // ajenos (política, chismes, etc.) en sus replies externos; sin este filtro
      // esas respuestas se colaban como si fueran "menciones" de la marca.
      const relevanceTerms = [...new Set(
        [keyword, ...extraTerms].flatMap(t => t.replace(/[@#]/g, '').toLowerCase().split(/\s+/)).filter(w => w.length >= 2)
      )];

      // Reducido de 20 a 5 — abrir hilos es lo más lento del scraper (~30s c/u)
      // y lo que de verdad importa es traer los tweets/menciones del rango de
      // fecha pedido, no la conversación completa de cada uno.
      const topTweets = Array.from(allTweets.values())
        .filter(t => isRecent(t.date, days, referenceNow))
        .sort((a, b) => scoreEngagement(b) - scoreEngagement(a))
        .slice(0, 5);

      const threadResult = await openThreadsForReplies(ctx, topTweets, keyword, relevanceTerms, referenceNow);
      comments = comments.concat(threadResult.comments);
      etiquetados = etiquetados.concat(threadResult.etiquetados);

      console.log(`[Twitter] TOTAL: ${mentions.length} menciones + ${comments.length} replies`);

      await enrichFollowerCounts(ctx, mentions);

    } else {
      // Sin sesión — Nitter
      console.log('[Twitter] Sin sesión, usando Nitter...');
      await page.goto(
        `https://nitter.net/search?q=${encodeURIComponent(keyword)}&f=tweets`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );
      await waitForComments(page, '.timeline-item', 1, 15000);

      for (let p = 0; p < 4; p++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await delay(2000);
      }

      const nitterTweets = await page.evaluate(() => {
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

      for (const t of nitterTweets) {
        mentions.push({ platform: 'twitter', author: t.author, text: t.text.slice(0, 600), url: t.url, date: parseRelativeDate(t.date), tipo: 'tweet' });
      }
      console.log(`[Twitter/Nitter] ${nitterTweets.length} tweets`);
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

function parseEngagementCount(raw: string): number {
  const t = (raw || '0').trim().replace(/,/g, '');
  if (/K$/i.test(t)) return Math.round(parseFloat(t) * 1_000);
  if (/M$/i.test(t)) return Math.round(parseFloat(t) * 1_000_000);
  return parseInt(t.replace(/[^0-9]/g, '') || '0') || 0;
}

/**
 * Visita el timeline PROPIO de un handle (no una búsqueda) y extrae sus
 * últimos tweets con likes/retweets/replies reales — todo visible inline en
 * el timeline, sin necesidad de abrir cada tweet (a diferencia de Instagram/
 * YouTube). Requiere sesión guardada (mismo requisito que scrapeTwitter).
 */
export async function scrapeTwitterProfile(handle: string, maxPosts = 12): Promise<{
  profile: ProfileInfo | null; posts: ProfilePost[];
}> {
  const clean = handle.replace(/^@/, '').trim();
  const useAuth = hasAuth('twitter');
  if (!useAuth) {
    console.warn('[Twitter Profile] Sin sesión guardada. Corre: npm run setup → Twitter');
    return { profile: null, posts: [] };
  }

  const ctx = await getContext('twitter');
  const posts: ProfilePost[] = [];
  let profile: ProfileInfo | null = null;

  try {
    const page = await ctx.newPage();
    await page.goto(`https://twitter.com/${clean}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const found = await waitForComments(page, '[data-testid="tweet"]', 1, 30000);
    if (!found) {
      console.warn(`[Twitter Profile] Sin tweets visibles para @${clean} (perfil privado/inexistente/protegido)`);
      await page.close();
      return { profile: null, posts: [] };
    }

    await humanDelay(1500, 2500);

    const profileData = await page.evaluate(() => {
      const nameEl = document.querySelector('[data-testid="UserName"] span');
      const avatarEl = document.querySelector('a[href*="/photo"] img, [data-testid="UserAvatar-Container"] img') as HTMLImageElement | null;
      const bioEl = document.querySelector('[data-testid="UserDescription"]');
      let followers = '';
      for (const link of Array.from(document.querySelectorAll('a[href*="/verified_followers"], a[href*="/followers"]'))) {
        const t = link.textContent?.trim() || '';
        const m = t.match(/^([\d.,]+[KkMm]?)/);
        if (m) { followers = m[1]; break; }
      }
      return {
        displayName: nameEl?.textContent?.trim() || '',
        avatar: avatarEl?.src || '',
        bio: bioEl?.textContent?.trim() || '',
        followers,
      };
    });

    profile = {
      platform: 'twitter',
      handle: `@${clean}`,
      displayName: profileData.displayName || clean,
      avatar: profileData.avatar || undefined,
      bio: profileData.bio || undefined,
      followers: profileData.followers ? parseEngagementCount(profileData.followers) : undefined,
      profileUrl: `https://twitter.com/${clean}`,
    };

    const collected = new Map<string, RawTweet>();
    const extract = async () => {
      const batch: RawTweet[] = await page.evaluate(() => {
        const items: any[] = [];
        document.querySelectorAll('[data-testid="tweet"]').forEach(el => {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const text = textEl?.textContent?.trim() || '';
          const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
          if (!linkEl) return;
          const url = linkEl.href;
          const isPinned = !!el.textContent?.includes('Fijado') || !!el.textContent?.includes('Pinned');
          const isRetweet = !!el.querySelector('[data-testid="socialContext"]');
          const likesEl = el.querySelector('[data-testid="like"] span[data-testid="app-text-transition-container"]');
          const repliesEl = el.querySelector('[data-testid="reply"] span[data-testid="app-text-transition-container"]');
          const retweetEl = el.querySelector('[data-testid="retweet"] span[data-testid="app-text-transition-container"]');
          const timeEl = el.querySelector('time');
          const date = timeEl?.getAttribute('datetime') || '';
          items.push({
            author: '', handle: '', text, url,
            likes: likesEl?.textContent?.trim() || '0',
            retweets: retweetEl?.textContent?.trim() || '0',
            replies: repliesEl?.textContent?.trim() || '0',
            isReply: isRetweet && !isPinned,
            date,
          });
        });
        return items;
      });
      for (const t of batch) if (t.date && !collected.has(t.url)) collected.set(t.url, t);
    };

    await extract();
    for (let pass = 0; pass < 8 && collected.size < maxPosts; pass++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await delay(1800);
      const before = collected.size;
      await extract();
      if (collected.size === before) break;
    }

    const postEls = await page.$$('[data-testid="tweet"]');
    const items = Array.from(collected.values()).slice(0, maxPosts);
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      let thumb: string | undefined;
      if (postEls[i]) thumb = await takeScreenshot(postEls[i], 'tw_profile_post');
      posts.push({
        platform: 'twitter',
        url: t.url,
        thumbnail: thumb,
        caption: t.text.slice(0, 500),
        date: t.date,
        likes: parseEngagementCount(t.likes),
        comments: parseEngagementCount(t.replies),
        shares: parseEngagementCount(t.retweets),
      });
    }

    console.log(`[Twitter Profile] @${clean} → ${posts.length} posts extraídos`);
    await page.close();
  } catch (e: any) {
    console.error('[Twitter Profile] Error:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  return { profile, posts };
}
