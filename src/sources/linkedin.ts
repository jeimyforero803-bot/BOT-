/**
 * LinkedIn scraper — extracción de posts con sesión guardada
 * Selectores 2025: data-urn, update-components-*, attributed-text-segment-list
 * Requiere: npm run setup → linkedin
 */
import {
  getContext, hasAuth, humanDelay, humanScroll,
  takeScreenshot, waitForComments, parseRelativeDate, isRecent, getBatchReferenceNow, delay, buildPreciseQuery,
} from '../browser.js';
import type { Mention, Comment, Etiquetado } from '../types.js';

const parseFC = (raw: string): number => {
  const t = (raw || '').replace(/[^0-9.,KkMm]/g, '').trim();
  if (/[Mm]$/.test(t)) return Math.round(parseFloat(t) * 1_000_000);
  if (/[Kk]$/.test(t)) return Math.round(parseFloat(t) * 1_000);
  return parseInt(t.replace(/[.,]/g, '')) || 0;
};

/** Selectores ordenados por frecuencia en DOM LinkedIn 2025 */
const POST_SELS = [
  'div[data-view-name="feed-full-update"]',
  '.feed-shared-update-v2',
  '[data-urn*="urn:li:activity"]',
  '[data-id*="urn:li:activity"]',
  '.occludable-update',
];

/** Extrae posts del feed de búsqueda — LinkedIn 2026 (clases obfuscadas, sin data-urn) */
async function extractPosts(page: any): Promise<{
  author: string; authorUrl: string; text: string; url: string; likes: string; date: string; urn: string;
}[]> {
  return page.evaluate(() => {
    const items: any[] = [];
    const seen = new Set<string>();

    // LinkedIn 2026 usa clases CSS completamente obfuscadas sin data-urn ni data-view-name.
    // Enfoque estructural: cada post tiene un botón "Seguir"/"Follow" → subir al contenedor.
    const allBtns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const followBtns = allBtns.filter(b => {
      const t = (b.textContent?.trim() || '').replace(/^\+\s*/, '');
      return t === 'Seguir' || t === 'Follow' || t === 'Following' || t === 'Siguiendo';
    });

    for (const followBtn of followBtns) {
      // Subir en el DOM hasta encontrar el contenedor del post
      // Criterio: tiene texto sustancial (>150 chars) Y al menos 3 botones (reacciones + seguir)
      let container: HTMLElement | null = followBtn.parentElement as HTMLElement;
      for (let i = 0; i < 15; i++) {
        if (!container || container === document.body) break;
        const txt = container.textContent?.trim() || '';
        const btnCount = container.querySelectorAll('button').length;
        if (txt.length > 150 && btnCount >= 3) break;
        container = container.parentElement as HTMLElement;
      }
      if (!container || container === document.body) continue;

      // Autor: primer link a perfil /in/ o /company/ con texto
      const links = Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const authorLink = links.find(a => {
        const h = a.getAttribute('href') || '';
        const t = a.textContent?.trim() || '';
        return (h.includes('/in/') || h.includes('/company/')) && t.length > 1;
      });
      // Limpiar sufijos de conexión: "Marina Yan• 3er+" → "Marina Yan"
      const rawAuthor = authorLink?.textContent?.trim() || '';
      const author = rawAuthor.replace(/[•·]\s*(1[eé]r?|2[oº°]|3[eé]r?)\+?\s*grado?.*$/i, '').replace(/[•·].*$/, '').trim();
      if (!author || author.length < 2 || author.length > 100) continue;
      const authorUrl = authorLink?.href || '';

      // Texto: usar <p> primero (LinkedIn 2026 usa p para cuerpo del post), luego span grande
      let text = '';
      const pEls = Array.from(container.querySelectorAll('p')) as HTMLElement[];
      for (const p of pEls) {
        const t = p.textContent?.trim() || '';
        // Ignorar <p> que sean la descripción del trabajo (frase corta sin mención de Corferias/evento)
        if (t.length > text.length && t !== author && !t.startsWith('Seguir') && !t.startsWith('Follow')) text = t;
      }
      // Fallback: span con texto largo
      if (!text || text.length < 20) {
        container.querySelectorAll('span').forEach((el: any) => {
          const t = el.textContent?.trim() || '';
          if (t.length > text.length && t !== author && t.length > 30 && !t.startsWith('Seguir')) text = t;
        });
      }
      if (!text || text.length < 10) continue;

      // URL del post: /feed/update/ o /posts/ con slug (excluir páginas de perfil como /company/name/posts/)
      const postLink = links.find(a => {
        const h = a.getAttribute('href') || '';
        return h.includes('/feed/update/') || h.includes('activityUrn') ||
          (h.includes('/posts/') && (h.split('/posts/')[1] || '').length > 15);
      });
      let url = postLink?.href || '';

      // Fecha: elemento <time> dentro del contenedor. El timestamp ("2d", "1 sem")
      // casi siempre está envuelto en el link real al post — si el paso de arriba
      // no encontró nada, este suele ser el permalink correcto.
      const timeEl = container.querySelector('time');
      if (!url) {
        const timeLink = timeEl?.closest('a[href]') as HTMLAnchorElement | null;
        if (timeLink?.href) url = timeLink.href;
      }
      // Último recurso: el propio contenedor (o un ancestro cercano) suele traer
      // el ID de la actividad en un atributo data-urn aunque no haya <a> visible —
      // con eso se puede construir el permalink canónico en vez de dejarlo vacío.
      if (!url) {
        let node: HTMLElement | null = container;
        for (let i = 0; i < 5 && node; i++) {
          const urn = node.getAttribute?.('data-urn') || node.getAttribute?.('data-id') || '';
          const m = urn.match(/urn:li:activity:(\d+)/);
          if (m) { url = `https://www.linkedin.com/feed/update/urn:li:activity:${m[1]}/`; break; }
          node = node.parentElement;
        }
      }
      const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

      // Likes: cualquier span/div con número cerca de íconos de reacción
      const likesEl = container.querySelector('[aria-label*="reaccion"], [aria-label*="reaction"], [aria-label*="like"]');
      const likes = likesEl?.textContent?.trim() || '0';

      const key = text.slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ author, authorUrl, text, url, likes, date, urn: '' });
      }
    }

    // Fallback: intentar data-urn si por algún motivo volvieron
    if (items.length === 0) {
      const urnEls = Array.from(document.querySelectorAll('[data-urn*="activity"], [data-view-name="feed-full-update"]'));
      for (const el of urnEls) {
        const authorEl = el.querySelector('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement | null;
        const author = authorEl?.textContent?.trim() || '';
        if (!author) continue;
        let text = '';
        el.querySelectorAll('span[dir="ltr"], div[dir="ltr"]').forEach((s: any) => {
          const t = s.textContent?.trim() || '';
          if (t.length > text.length && t !== author) text = t;
        });
        if (!text) continue;
        const postLink = el.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]') as HTMLAnchorElement | null;
        const timeEl = el.querySelector('time');
        const key = text.slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ author, authorUrl: authorEl?.href || '', text, url: postLink?.href || '', likes: '0', date: timeEl?.getAttribute('datetime') || '', urn: '' });
        }
      }
    }

    return items.slice(0, 25);
  });
}

/** Extrae comentarios de un post abierto */
async function extractComments(page: any): Promise<{
  author: string; text: string; likes: string; date: string;
}[]> {
  return page.evaluate(() => {
    const items: { author: string; text: string; likes: string; date: string }[] = [];
    const seen = new Set<string>();

    const commentSels = [
      'article.comments-comment-item',
      '.comments-comment-item',
      '.comment-item-content',
      '[data-urn*="comment"]',
      '.comments-comment-thread__comment',
    ];
    let containers: Element[] = [];
    for (const sel of commentSels) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > containers.length) containers = found;
    }

    for (const el of containers) {
      const authorEl = el.querySelector([
        '.comments-post-meta__name-text span[aria-hidden="true"]',
        '.comments-post-meta__name-text',
        '.update-components-actor__name span[aria-hidden="true"]',
        'span[aria-hidden="true"]',
      ].join(', '));
      const author = authorEl?.textContent?.trim() || 'Usuario LinkedIn';

      const textEl = el.querySelector([
        '.comments-comment-item__main-content',
        '.update-components-text span[dir="ltr"]',
        'span[dir="ltr"]',
        '[dir="ltr"]',
      ].join(', '));
      const text = textEl?.textContent?.trim() || '';
      if (!text || text.length < 5) continue;

      const likesEl = el.querySelector('[aria-label*="reaction"], .comment-item-content__reaction-count');
      const likes = likesEl?.textContent?.trim() || '0';

      const timeEl = el.querySelector('time');
      const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

      const key = text.slice(0, 30);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ author, text, likes, date });
      }
    }
    return items.slice(0, 60);
  });
}

// Firma alineada a (kw, extra, days, exclusions, sinceDate, untilDate) del tipo
// Scraper en server.ts. LinkedIn no expone un filtro de rango de fechas exacto
// en su búsqueda pública (solo presets relativos: past-24h/past-week/past-month),
// así que sinceDate/untilDate no se usan para construir la query — el recorte
// exacto ya lo aplica runScan centralmente con inExactRange sobre el resultado.
export async function scrapeLinkedIn(keyword: string, extraTerms: string[] = [], days = 30, exclusions: string[] = [], _sinceDate?: string, _untilDate?: string): Promise<{
  mentions: Mention[]; comments: Comment[]; etiquetados: Etiquetado[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = [];
  const etiquetados: Etiquetado[] = [];

  if (!hasAuth('linkedin')) {
    console.warn('[LinkedIn] Sin sesión guardada. Corre: npm run setup → linkedin');
    return { mentions, comments, etiquetados };
  }

  // Determinar filtro de fecha según días solicitados
  const dateFilter = days <= 1 ? 'past-24h' : days <= 7 ? 'past-week' : days <= 30 ? 'past-month' : '';
  // Extraer nombres de exclusión de autores (strips @, lowercase)
  const excludedAuthors = exclusions
    .filter(e => e.startsWith('@'))
    .map(e => e.replace('@', '').toLowerCase());

  const ctx = await getContext('linkedin');

  try {
    const page = await ctx.newPage();
    const preciseQuery = buildPreciseQuery(keyword, extraTerms);
    console.log(`[LinkedIn] Buscando "${preciseQuery}" (${dateFilter || 'sin filtro fecha'})...`);

    // LinkedIn requiere comillas literales en sortBy y datePosted (%22 = ")
    // /content/ = Publicaciones; sortBy="date_posted"; datePosted="past-week"
    const enc = encodeURIComponent(preciseQuery);
    const searchUrls = [
      dateFilter
        ? `https://www.linkedin.com/search/results/content/?keywords=${enc}&sortBy=%22date_posted%22&datePosted=%22${dateFilter}%22`
        : `https://www.linkedin.com/search/results/content/?keywords=${enc}&sortBy=%22date_posted%22`,
      `https://www.linkedin.com/search/results/content/?keywords=${enc}&sortBy=%22date_posted%22`,
      `https://www.linkedin.com/search/results/content/?keywords=${enc}`,
    ].filter((u, i, arr) => arr.indexOf(u) === i);

    let loaded = false;
    for (const url of searchUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        // Esperar a que el JS termine de renderizar el feed
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await delay(3000);

        // Cerrar modales
        try {
          for (const dismissSel of [
            '[aria-label="Dismiss"]', '[aria-label="Cerrar"]',
            '.artdeco-modal__dismiss', '.modal__dismiss',
            'button[data-tracking-control-name="nav-oc-signin_join-now_modal_dismiss"]',
          ]) {
            const btn = await page.$(dismissSel);
            if (btn) { await btn.click(); await delay(800); break; }
          }
        } catch { /* ok */ }

        // Esperar explícitamente a que aparezca cualquier contenedor de resultados
        // LinkedIn renderiza el feed de búsqueda de forma asíncrona, networkidle no es suficiente
        const RESULT_WAIT_SELS = [
          'div[data-view-name="feed-full-update"]',
          '.feed-shared-update-v2',
          '[data-urn*="urn:li:activity"]',
          'li.reusable-search__result-container',
          '[data-chameleon-result-urn]',
          '.search-results__cluster-content',
          '.reusable-search-simple-insight__text',
        ];
        let found = false;
        for (const sel of RESULT_WAIT_SELS) {
          try {
            await page.waitForSelector(sel, { timeout: 12000 });
            found = true;
            break;
          } catch { /* probar siguiente */ }
        }

        // Scroll inicial para forzar render lazy
        if (!found) {
          for (let s = 0; s < 4; s++) {
            await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
            await delay(1000);
          }
          // Segundo intento tras scroll
          for (const sel of RESULT_WAIT_SELS) {
            try {
              await page.waitForSelector(sel, { timeout: 5000 });
              found = true;
              break;
            } catch { /* probar siguiente */ }
          }
        }

        if (!found) {
          // Fallback: verificar con POST_SELS
          for (const sel of POST_SELS) {
            const count: number = await page.evaluate((s: string) => document.querySelectorAll(s).length, sel);
            if (count > 0) { found = true; break; }
          }
        }

        // Último recurso: probar extractPosts con método Follow-button (LinkedIn 2026 sin data-urn)
        if (!found) {
          const testPosts = await extractPosts(page);
          if (testPosts.length > 0) {
            found = true;
            console.log(`[LinkedIn] ${testPosts.length} posts detectados (método Follow-button) — procediendo con scroll`);
          }
        }

        if (!found) {
          const pageTitle = await page.title().catch(() => '?');
          const domInfo = await page.evaluate(() => {
            const tags = ['div[data-view-name]', '.search-results', '.feed-shared-update-v2',
              'main', '[role="main"]', '.scaffold-layout__main',
              'li.reusable-search__result-container', '[data-chameleon-result-urn]'];
            return tags.map(s => `${s}: ${document.querySelectorAll(s).length}`).join(' | ');
          }).catch(() => 'DOM no accesible');
          console.warn(`[LinkedIn] DOM debug — título: "${pageTitle}" | ${domInfo}`);
        }

        if (found) { loaded = true; break; }
        await delay(3000);
      } catch { /* reintentar */ }
    }

    if (!loaded) {
      console.warn('[LinkedIn] No cargaron resultados');
      await page.close();
      return { mentions, comments, etiquetados };
    }

    // Filtro de fecha ya aplicado via URL (%22past-week%22 etc.) — no clic UI para evitar errores

    // Scroll con extracción incremental — LinkedIn virtualiza el DOM, los posts que
    // salen del viewport se eliminan. Hay que capturarlos mientras están visibles.
    const accumulated = new Map<string, { author: string; authorUrl: string; text: string; url: string; likes: string; date: string; urn: string }>();
    const screenshotMap = new Map<string, string>();

    // Clic para dar foco
    await page.mouse.click(380, 400).catch(() => {});
    await delay(500);

    // Diagnóstico: identificar el contenedor scrollable real
    const scrollDiag = await page.evaluate(() => {
      const els = [
        { sel: '.scaffold-layout__main', el: document.querySelector('.scaffold-layout__main') },
        { sel: '.search-results-container', el: document.querySelector('.search-results-container') },
        { sel: 'main', el: document.querySelector('main') },
        { sel: 'body', el: document.body },
        { sel: 'html', el: document.documentElement },
      ];
      return els.map(({ sel, el }) => el
        ? `${sel}: scrollH=${el.scrollHeight} clientH=${el.clientHeight} scrollTop=${el.scrollTop}`
        : `${sel}: NOT FOUND`
      ).join(' | ');
    });
    console.log(`[LinkedIn] Scroll diag: ${scrollDiag}`);

    // Detectar el contenedor scrollable real de LinkedIn (puede ser window, main, o un div interno)
    const scrollScript = `
      (function(amount) {
        // Intentar todos los candidatos en orden
        var candidates = [
          document.querySelector('.scaffold-layout__main'),
          document.querySelector('.search-results-container'),
          document.querySelector('[class*="search-results"]'),
          document.querySelector('main'),
          document.querySelector('[role="main"]'),
          document.documentElement,
          document.body,
        ];
        var scrolled = false;
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          if (el && el.scrollHeight > el.clientHeight + 50) {
            el.scrollTop += amount;
            scrolled = true;
            break;
          }
        }
        // Siempre intentar window también
        window.scrollBy(0, amount);
        return scrolled;
      })(700)
    `;

    // Scroll dirigido por fecha — igual que Twitter/Threads: seguimos bajando
    // hasta que el post más viejo visto cruce la fecha de inicio pedida, en
    // vez de un número fijo de pasadas. LinkedIn no tiene un operador tipo
    // until: de X, así que no podemos saltar directo a una fecha pasada — el
    // scroll siempre arranca desde lo más reciente, pero ya no se corta antes
    // de tiempo ni sigue de más una vez cubrió el rango pedido.
    const targetStartMs = Date.now() - (days >= 1 ? Math.max(days, 30) : days) * 86400000;
    const oldestSeenMs = (): number => {
      let min = Infinity;
      for (const p of accumulated.values()) {
        const ms = new Date(parseRelativeDate(p.date)).getTime();
        if (!isNaN(ms) && ms < min) min = ms;
      }
      return min;
    };
    let noNewStreak = 0;
    const MAX_PASSES = 80;
    for (let s = 0; s < MAX_PASSES; s++) {
      const before = accumulated.size;
      await page.evaluate(scrollScript);
      await delay(1200);
      // Extraer en cada pasada — captura todo lo visible antes de que se virtualice
      const batch = await extractPosts(page);
      for (const p of batch) {
        const key = p.text.slice(0, 50);
        if (!accumulated.has(key)) accumulated.set(key, p);
      }
      const after = accumulated.size;
      console.log(`[LinkedIn] Pasada ${s + 1}: ${after} posts (+${after - before})`);

      if (after >= 200) { console.log('[LinkedIn] Tope de 200 posts, deteniendo scroll.'); break; }

      const oldest = oldestSeenMs();
      if (oldest <= targetStartMs) {
        console.log(`[LinkedIn] Fecha de inicio alcanzada (post más viejo visto: ${new Date(oldest).toISOString().slice(0, 10)}), deteniendo scroll.`);
        break;
      }

      if (after === before) {
        noNewStreak++;
        if (noNewStreak > 6) { console.log('[LinkedIn] Sin más posts nuevos, deteniendo scroll.'); break; }
      } else {
        noNewStreak = 0;
      }

      // Capturar miniaturas cada 4 pasadas usando bounding boxes de los contenedores visibles
      if (s % 4 === 0) {
        try {
          const scrollY: number = await page.evaluate(() => window.scrollY);
          const boxes: { key: string; x: number; y: number; w: number; h: number }[] = await page.evaluate(() => {
            const results: { key: string; x: number; y: number; w: number; h: number }[] = [];
            const allBtns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
            const followBtns = allBtns.filter(b => {
              const t = (b.textContent?.trim() || '').replace(/^\+\s*/, '');
              return t === 'Seguir' || t === 'Follow' || t === 'Following' || t === 'Siguiendo';
            });
            for (const followBtn of followBtns.slice(0, 5)) {
              let container: HTMLElement | null = followBtn.parentElement as HTMLElement;
              for (let i = 0; i < 15; i++) {
                if (!container || container === document.body) break;
                const txt = container.textContent?.trim() || '';
                const btnCount = container.querySelectorAll('button').length;
                if (txt.length > 150 && btnCount >= 3) break;
                container = container.parentElement as HTMLElement;
              }
              if (!container || container === document.body) continue;
              let text = '';
              (container.querySelectorAll('p') as NodeListOf<HTMLElement>).forEach(p => {
                const t = p.textContent?.trim() || '';
                if (t.length > text.length) text = t;
              });
              const key = text.slice(0, 50);
              if (!key) continue;
              const rect = container.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 10 && rect.top >= -50 && rect.top < window.innerHeight) {
                results.push({ key, x: Math.max(0, rect.left), y: rect.top, w: rect.width, h: Math.min(rect.height, 700) });
              }
            }
            return results;
          });
          for (const { key, x, y, w, h } of boxes) {
            if (!screenshotMap.has(key) && w > 0 && h > 0) {
              try {
                const buf = await page.screenshot({ clip: { x, y: y + scrollY, width: w, height: h } });
                screenshotMap.set(key, `data:image/png;base64,${buf.toString('base64')}`);
              } catch {}
            }
          }
        } catch {}
      }
    }
    // Extracción final
    const finalBatch = await extractPosts(page);
    for (const p of finalBatch) {
      const key = p.text.slice(0, 50);
      if (!accumulated.has(key)) accumulated.set(key, p);
    }

    let posts = [...accumulated.values()];
    console.log(`[LinkedIn] ${posts.length} posts encontrados (acumulados durante scroll)`);

    if (posts.length < 3) {
      for (let s = 0; s < 10; s++) {
        await page.evaluate(scrollScript);
        await delay(1500);
        const batch = await extractPosts(page);
        for (const p of batch) {
          const key = p.text.slice(0, 50);
          if (!accumulated.has(key)) accumulated.set(key, p);
        }
      }
      posts = [...accumulated.values()];
      console.log(`[LinkedIn] Tras scroll extra: ${posts.length} posts`);
    }

    if (posts.length === 0) {
      console.warn('[LinkedIn] 0 posts tras todos los intentos');
      await page.close();
      return { mentions, comments, etiquetados };
    }

    // Ancla "ahora" a la fecha real más reciente vista en el scrape (no al
    // reloj de esta máquina) — ver comentario en getBatchReferenceNow().
    const referenceNow = getBatchReferenceNow(posts.map(p => parseRelativeDate(p.date)));

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const isoDate = parseRelativeDate(post.date);
      if (!isRecent(isoDate, days >= 1 ? Math.max(days, 30) : days, referenceNow)) continue;

      // Omitir posts del perfil oficial de la marca (exclusiones de autor)
      if (excludedAuthors.length > 0) {
        const authorLower = post.author.toLowerCase();
        if (excludedAuthors.some(ex => authorLower.includes(ex))) {
          console.log(`[LinkedIn] Omitiendo perfil oficial: "${post.author}"`);
          continue;
        }
      }

      const shot = screenshotMap.get(post.text.slice(0, 50));

      // OJO: antes caía a searchUrls[0] (la página genérica de resultados de
      // búsqueda) cuando no se pudo extraer el link real del post — eso hacía
      // que el usuario cayera en la página de búsqueda en vez del post real.
      // Preferible el perfil del autor (al menos es relevante) o, si tampoco
      // hay eso, dejarlo vacío — el frontend ya maneja bien la ausencia de link.
      if (!post.url) console.warn(`[LinkedIn] Sin link de post extraído para "${post.author}" — usando fallback`);
      const item: any = {
        platform: 'linkedin',
        author: post.author,
        text: post.text.slice(0, 600),
        url: post.url || post.authorUrl || '',
        date: isoDate,
        likes: parseInt((post.likes || '').replace(/[^0-9]/g, '') || '0') || 0,
        tipo: 'post',
        screenshot: shot,
      };

      // Enriquecer con seguidores
      if (post.authorUrl && post.authorUrl.includes('linkedin.com') && i < 5) {
        try {
          const profPage = await ctx.newPage();
          await profPage.goto(post.authorUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await delay(2500);
          const followersRaw = await profPage.evaluate(() => {
            // Método 1: elemento con clase followers
            const sels = [
              '.t-normal.t-black--light.link-without-visited-state.link-without-hover-state',
              '[class*="follower"]',
              '.org-top-card-summary-info-list__info-item',
            ];
            for (const s of sels) {
              const els = Array.from(document.querySelectorAll(s));
              for (const el of els) {
                const t = el.textContent?.trim() || '';
                const m = t.match(/([\d.,]+\s*[KkMm]?)\s*(follower|seguidor)/i);
                if (m) return m[1];
              }
            }
            // Método 2: buscar texto suelto en spans
            for (const el of Array.from(document.querySelectorAll('span, li, p'))) {
              const t = el.textContent?.trim() || '';
              if (/(follower|seguidor)/i.test(t) && t.length < 50) {
                const m = t.match(/([\d.,]+\s*[KkMm]?)/i);
                if (m) return m[1];
              }
            }
            return null;
          });
          if (followersRaw) {
            const fc = parseFC(followersRaw);
            if (fc > 0) {
              item.follower_count = fc;
              item.is_influencer = fc >= 5000;
              // Foto de perfil solo para influencers relevantes — ya estamos en su
              // página por el conteo de seguidores, no cuesta una visita extra.
              if (fc >= 5000) {
                const avatar = await profPage.evaluate(() =>
                  (document.querySelector('img.pv-top-card-profile-picture__image, img[class*="profile-photo"], .org-top-card-primary-content__logo img') as HTMLImageElement | null)?.src || ''
                ).catch(() => '');
                if (avatar) (item as any).avatar = avatar;
              }
            }
          }
          await profPage.close();
          await delay(800);
        } catch { /* skip */ }
      }

      mentions.push(item);

      // Tags y hashtags
      const tags = post.text.match(/@[\w\u00C0-\u024F]+/g) || [];
      for (const tag of tags) {
        if (keyword.toLowerCase().split(/\s+/).some(p => tag.toLowerCase().replace('@', '').includes(p.slice(0, 5))))
          etiquetados.push({ platform: 'linkedin', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'mencion' });
      }
      const hashes = post.text.match(/#[\w\u00C0-\u024F]+/g) || [];
      for (const ht of hashes) {
        if (keyword.toLowerCase().split(/\s+/).some(p => ht.toLowerCase().replace('#', '').includes(p.slice(0, 5))))
          etiquetados.push({ platform: 'linkedin', quien: post.author, texto: post.text.slice(0, 280), url: post.url, date: isoDate, tipo: 'hashtag' });
      }

      await humanDelay(800, 1500);
    }

    await page.close();
  } catch (e: any) {
    console.error('[LinkedIn] Error general:', e.message?.slice(0, 100));
  } finally {
    await ctx.close();
  }

  // Ordenar por fecha más reciente primero
  const byDate = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  mentions.sort(byDate);
  comments.sort(byDate);
  console.log(`[LinkedIn] TOTAL: ${mentions.length}m ${comments.length}c ${etiquetados.length}e`);
  return { mentions, comments, etiquetados };
}
