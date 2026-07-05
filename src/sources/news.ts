/**
 * News scraper — Google News (búsqueda), sin browser, ordenado por más reciente.
 * Antes iba medio por medio (El Tiempo, Semana, etc.) con selectores frágiles que
 * se rompían seguido y traían ruido; ahora solo usamos el buscador de Google News,
 * que ya indexa todos esos medios y es mucho más confiable para encontrar
 * exactamente la marca buscada.
 */
import { buildPreciseQuery } from '../browser.js';
import type { Mention, Comment } from '../types.js';

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

export async function scrapeNews(keyword: string, extraTerms: string[] = [], days = 30): Promise<{
  mentions: Mention[]; comments: Comment[];
}> {
  const mentions: Mention[] = [];
  const comments: Comment[] = []; // Google News no expone comentarios — se deja vacío por compatibilidad de tipo

  // ── 1. Frase exacta de la marca — la búsqueda más específica primero ─────
  const preciseQuery = buildPreciseQuery(keyword, extraTerms);
  const precise = await fetchGoogleNewsRSS(preciseQuery, days);
  for (const m of precise) {
    if (!mentions.some(x => x.url === m.url)) mentions.push(m);
  }

  // ── 2. Términos combinados con OR + individuales — para no perder cobertura
  // cuando la frase exacta es demasiado estricta y no trae nada ──────────────
  const allTermsStripped = [
    keyword,
    ...extraTerms
      .map(t => t.replace(/[@#]/g, '').trim())
      .filter(t => t.length >= 3 && t.toLowerCase() !== keyword.toLowerCase()),
  ];
  const uniqueTerms = [...new Map(allTermsStripped.map(t => [t.toLowerCase(), t])).values()];

  if (uniqueTerms.length > 1) {
    const combinedQuery = uniqueTerms.map(t => t.includes(' ') ? `"${t}"` : t).join(' OR ');
    const combined = await fetchGoogleNewsRSS(combinedQuery, days);
    for (const m of combined) {
      if (!mentions.some(x => x.url === m.url)) mentions.push(m);
    }
  }

  for (const term of uniqueTerms.slice(0, 4)) {
    const extra = await fetchGoogleNewsRSS(term, days);
    for (const m of extra) {
      if (!mentions.some(x => x.url === m.url)) mentions.push(m);
    }
  }

  console.log(`[News] TOTAL: ${mentions.length} artículos (Google News)`);

  // Más reciente primero
  mentions.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  return { mentions, comments };
}
