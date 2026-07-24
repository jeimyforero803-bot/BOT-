/**
 * ZELVA Agent — Servidor local
 * Corre en tu PC y la UI de ZALVAJE lo activa automáticamente.
 *
 * Uso: npx tsx server.ts
 * Puerto: 3002
 *
 * Endpoints:
 *   GET  /status   → { online: true }
 *   POST /scan     → { keyword } → dispara el escaneo en background
 *   GET  /results  → último resultado del escaneo
 */
import 'dotenv/config';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { scrapeYouTube, scrapeYouTubeProfile } from './src/sources/youtube.js';
import { scrapeReddit } from './src/sources/reddit.js';
import { scrapeNews } from './src/sources/news.js';
import { scrapeTwitter, scrapeTwitterProfile } from './src/sources/twitter.js';
import { scrapeInstagram, scrapeInstagramProfile } from './src/sources/instagram.js';
import { scrapeTikTok, scrapeTikTokProfile } from './src/sources/tiktok.js';
import { scrapeFacebook } from './src/sources/facebook.js';
import { scrapeLinkedIn } from './src/sources/linkedin.js';
import { scrapeThreads } from './src/sources/threads.js';
import { closeBrowser, SCREENSHOTS_DIR, ensureScreenshotsDir, isRecent } from './src/browser.js';
import { sendWhatsApp } from './src/whatsapp.js';
import { generateAISummary } from './src/aiSummary.js';
import type { Mention, Comment, Etiquetado, Alert, ScanPayload, ProfileScanResult, ProfileInfo, ProfilePost } from './src/types.js';
import fs from 'fs';
import path from 'path';

ensureScreenshotsDir();

const PORT = parseInt(process.env.AGENT_PORT || '3002');
const BACKEND_URL = (process.env.ZALVAJE_BACKEND || 'http://localhost:3001').replace(/\/$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';

// ─── Estado del agente ────────────────────────────────────────────────────────
type ScanStatus = 'idle' | 'running' | 'done' | 'error';
let status: ScanStatus = 'idle';
let currentKeyword = '';
let lastResult: ScanPayload | null = null;
let lastError = '';
let scanStartedAt = '';
let stopRequested = false;

// ─── Estado del escaneo de PERFIL de influencer — independiente del scan por
// keyword de arriba, corre su propio job en paralelo sin bloquearse mutuamente. ──
let profileStatus: ScanStatus = 'idle';
let currentProfileHandle = '';
let lastProfileResult: ProfileScanResult | null = null;
let profileError = '';

// Filtro de rango de fecha exacto — aplicado DESPUÉS de que los scrapers ya
// buscaron con su ventana `days` habitual (que sigue usándose para acotar cuánto
// buscan hacia atrás), para recortar al rango preciso pedido por el usuario.
function inExactRange(dateStr: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return true; // sin fecha parseable, no descartar
  if (start && t < new Date(start).getTime()) return false;
  if (end && t > new Date(end + 'T23:59:59.999').getTime()) return false;
  return true;
}

// ─── URLs ya vistas (persiste entre scans, por keyword) ───────────────────────
const SEEN_FILE = path.join(process.cwd(), 'results', 'seen_urls.json');
const seenByKeyword: Record<string, Set<string>> = {};

function loadSeenUrls() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      for (const [kw, urls] of Object.entries(raw)) {
        seenByKeyword[kw] = new Set(urls as string[]);
      }
      console.log(`[Seen] Cargadas ${Object.keys(seenByKeyword).length} keywords con historial`);
    }
  } catch { /* ok, empieza vacío */ }
}

function saveSeenUrls() {
  try {
    const dir = path.join(process.cwd(), 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const obj: Record<string, string[]> = {};
    for (const [kw, set] of Object.entries(seenByKeyword)) obj[kw] = [...set];
    fs.writeFileSync(SEEN_FILE, JSON.stringify(obj));
  } catch { /* ok */ }
}

function getSeenUrls(keyword: string): Set<string> {
  if (!seenByKeyword[keyword]) seenByKeyword[keyword] = new Set();
  return seenByKeyword[keyword];
}

function markAsSeen(keyword: string, items: { url?: string }[]) {
  const seen = getSeenUrls(keyword);
  for (const item of items) if (item.url) seen.add(item.url);
  saveSeenUrls();
}

loadSeenUrls();

// ─── Análisis de emociones ────────────────────────────────────────────────────
const EMOTION_LEXICON: Record<string, string[]> = {
  alegría: [
    'excelente', 'bueno', 'amor', 'feliz', 'perfecto', 'maravilloso', 'genial', 'recomiendo',
    'satisfecho', 'encanta', 'fantástico', 'espectacular', 'fabuloso', 'amo', 'me gusta',
    'me encanta', 'divertido', 'bacano', 'chévere', 'increíble', 'hermoso', 'precioso',
    'brutal', 'top', 'crack', 'épico', 'buenísimo', 'estupendo', 'grandioso', 'brillante',
    'impecable', 'calidad', 'confiable', 'recomendable', 'efectivo', 'eficiente', 'innovador',
    'orgulloso', 'agradecido', 'contento', 'emocionado', 'encantado', 'exitoso', 'alegre',
    'felicidad', 'gozo', 'triunfo', 'logro', 'éxito', 'victoria', 'win', 'wow que bueno',
    'de lujo', 'bacán', 'chimba', 'parce que bien', 'qué rico', 'delicioso', 'divino',
    'espléndido', 'sobresaliente', 'notable', 'superior', 'excepcional', 'inmejorable',
  ],
  ira: [
    'odio', 'rabia', 'furioso', 'indignado', 'inaceptable', 'vergüenza', 'escándalo',
    'fraude', 'estafa', 'mentira', 'robo', 'abuso', 'corrupto', 'injusto', 'harto', 'molesto',
    'enojado', 'pésimo', 'desastre', 'ridículo', 'absurdo', 'impresentable', 'descaro',
    'sinvergüenza', 'incompetente', 'mediocre', 'catastrófico', 'caótico', 'traición',
    'engaño', 'mentiroso', 'ladrón', 'roban', 'timan', 'indignante', 'repugnante',
    'asco de', 'no sirve', 'porquería', 'mierda', 'basura', 'horrible', 'nefasto',
    'terrible', 'pésima atención', 'nunca más', 'hartazgo', 'descarado', 'se burlan',
  ],
  tristeza: [
    'triste', 'decepcionante', 'decepción', 'lamentable', 'pena', 'nostalgia', 'fracaso',
    'pérdida', 'desolado', 'abandonado', 'defraudado', 'frustrado', 'mal', 'difícil',
    'doloroso', 'sufrimiento', 'soledad', 'melancolía', 'deprimido', 'desanimado',
    'rendido', 'agotado', 'qué pena', 'da tristeza', 'lástima', 'extraño', 'añoro',
    'no fue lo que esperaba', 'quedé mal', 'fallaron', 'me fallaron', 'decayó',
    'perdí la fe', 'ya no es lo mismo', 'empeoró', 'fue mejor antes',
  ],
  miedo: [
    'preocupa', 'miedo', 'temor', 'inseguro', 'peligro', 'amenaza', 'riesgo', 'terror',
    'pánico', 'nervioso', 'angustia', 'alerta', 'incertidumbre', 'desconfianza', 'sospecha',
    'duda', 'crisis', 'emergencia', 'urgente', 'grave', 'ansioso', 'estresado', 'tenso',
    'inquieto', 'intranquilo', 'vulnerable', 'inestable', 'cuidado', 'ojo con', 'tener cuidado',
    'preocupado por', 'qué pasará', 'no sé si', 'me da miedo', 'aterra',
  ],
  disgusto: [
    'asco', 'horrible', 'basura', 'asqueroso', 'peor', 'deficiente', 'sucio', 'infame',
    'nefasto', 'malo', 'feo', 'vulgar', 'ordinario', 'desagradable', 'insoportable',
    'inaguantable', 'inapropiado', 'inadecuado', 'incómodo', 'fastidioso', 'tedioso',
    'monótono', 'aburrido', 'da asco', 'no me gustó', 'no recomiendo', 'pésimo servicio',
    'mala calidad', 'sobrevalorado', 'una decepción', 'para nada vale', 'no vale la pena',
  ],
  sorpresa: [
    'sorprendente', 'inesperado', 'impresionante', 'wow', 'impactante', 'asombroso',
    'alucinante', 'no lo puedo creer', 'flipante', 'épico', 'viral', 'histórico',
    'revolucionario', 'sin precedentes', 'extraordinario', 'llamativo', 'qué locura',
    'no me lo esperaba', 'de repente', 'me sorprendió', 'quién lo diría', 'increíble cómo',
    'jamás pensé', 'no lo creería', 'de la nada', 'inesperadamente', 'fue una sorpresa',
  ],
};

const EMOTION_SCORE: Record<string, number> = {
  alegría: 0.85, sorpresa: 0.3, ira: -0.85, disgusto: -0.75, tristeza: -0.55, miedo: -0.45, neutro: 0,
};

const NEGATORS = /\b(no|sin|nunca|jamás|tampoco|ni|nada de|para nada|en absoluto)\b/;
const INTENSIFIERS = /\b(muy|súper|super|demasiado|bastante|extremadamente|totalmente|completamente|absolutamente|realmente|genuinamente|increíblemente)\b/;

function simpleSentiment(text: string): { label: string; score: number } {
  const t = text.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [emotion, words] of Object.entries(EMOTION_LEXICON)) {
    let total = 0;
    for (const w of words) {
      const idx = t.indexOf(w);
      if (idx === -1) continue;
      // Detectar negación en ventana de 35 chars antes de la palabra
      const before = t.slice(Math.max(0, idx - 35), idx);
      const negated = NEGATORS.test(before);
      // Detectar intensificador en ventana de 20 chars antes
      const intensified = INTENSIFIERS.test(before);
      let weight = 1;
      if (intensified) weight = 1.6;
      if (negated) {
        // Negación invierte la emoción: alegría negada → disgusto, ira negada → reduce
        if (emotion === 'alegría') { scores['disgusto'] = (scores['disgusto'] || 0) + weight; continue; }
        if (emotion === 'disgusto') { scores['alegría'] = (scores['alegría'] || 0) + weight * 0.5; continue; }
        weight = -weight * 0.5; // reduce parcialmente otras emociones negativas
      }
      total += weight;
    }
    if (total > 0) scores[emotion] = (scores[emotion] || 0) + total;
  }

  const top = Object.entries(scores).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
  if (!top) return { label: 'neutro', score: 0 };
  return { label: top[0], score: parseFloat((EMOTION_SCORE[top[0]] ?? 0).toFixed(4)) };
}

// ─── Parseo de términos de búsqueda ───────────────────────────────────────────
function parseSearchTerms(raw: string, pills?: string[]): { base: string; extraTerms: string[] } {
  const terms = (pills && pills.length > 0) ? pills : raw.split(/\s+/).filter(Boolean);
  const handles  = terms.filter(t => t.startsWith('@'));
  const hashtags = terms.filter(t => t.startsWith('#'));
  const rest     = terms.filter(t => !t.startsWith('@') && !t.startsWith('#'));
  // Prefer handle name (stripped @) as base for better text matching across all platforms
  const base = handles.length > 0
    ? handles[0].replace('@', '').trim()
    : (rest.find(t => !t.includes(' ')) || rest[0] || terms[0].replace(/[@#]/g, '').trim() || raw);
  // Keep all original pills as extraTerms so scrapers can use @handle, #tag and phrases
  const extraTerms = [...handles, ...hashtags, ...rest];
  return { base, extraTerms };
}

// Términos de contexto (ej. "Colombia" agregado a una sigla ambigua como "ETB")
// — solo los pills de texto plano que no sean el propio keyword base.
function getContextTerms(baseKeyword: string, extraTerms: string[]): string[] {
  return extraTerms.filter(t => !t.startsWith('@') && !t.startsWith('#') && t.toLowerCase() !== baseKeyword.toLowerCase());
}

// Filtro suave: cuando hay término(s) de contexto, se descarta contenido que
// NI menciona ese contexto NI "suena" a español — esto tumba ruido como
// tweets de coleccionistas de Pokémon (siempre en inglés) para siglas
// ambiguas tipo "ETB", sin exigir que "Colombia" aparezca literal (la
// mayoría de menciones reales de una marca colombiana no aclaran el país).
function looksSpanish(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (/[áéíóúñ¿¡]/.test(t)) return true;
  const stop = [' de ', ' la ', ' el ', ' que ', ' en ', ' y ', ' los ', ' las ', ' con ', ' para ', ' por ', ' es ', ' una ', ' un ', ' mi ', ' me '];
  return stop.some(w => t.includes(w));
}

function passesContext(text: string, contextTerms: string[]): boolean {
  if (contextTerms.length === 0) return true;
  const low = (text || '').toLowerCase();
  if (contextTerms.some(ct => low.includes(ct.toLowerCase()))) return true;
  return looksSpanish(text);
}

// Filtra mentions/comments por contexto y loguea cuántos se descartaron
function filterByContext<T extends { text?: string }>(items: T[], contextTerms: string[], key: string, kind: string): T[] {
  if (contextTerms.length === 0) return items;
  const kept = items.filter(i => passesContext(i.text || '', contextTerms));
  const dropped = items.length - kept.length;
  if (dropped > 0) console.log(`[${key}] Filtro de contexto (${kind}): ${dropped} descartados (ni "${contextTerms.join('/')}" ni español)`);
  return kept;
}

function applySentiment(items: (Mention | Comment)[]) {
  for (const item of items) {
    const s = simpleSentiment(item.text);
    (item as any).sentiment = s.label;
    (item as any).sentiment_score = s.score;
  }
}

function buildAlerts(keyword: string, mentions: Mention[], comments: Comment[], avgScore: number): Alert[] {
  // Alertas basadas solo en contenido de los últimos 7 días
  const recent7d = (m: Mention | Comment) => isRecent((m as any).date, 7);
  const recentMentions = mentions.filter(recent7d);
  const recentComments = comments.filter(recent7d);
  const recentAll = [...recentMentions, ...recentComments];

  const recentScores = recentAll.map(i => (i as any).sentiment_score || 0);
  const recentAvg = recentScores.length > 0 ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length : avgScore;

  const alerts: Alert[] = [];
  if (recentAvg < -0.4 && recentMentions.length > 3) alerts.push({ level: 'critical', tipo: 'crisis_sentimiento', mensaje: `Crisis detectada para "${keyword}" en los últimos 7 días. Alto volumen de sentimiento negativo.` });
  else if (recentAvg < -0.2) alerts.push({ level: 'warning', tipo: 'sentimiento_negativo', mensaje: `Tendencia negativa para "${keyword}" en los últimos 7 días.` });
  if (recentMentions.length > 40) alerts.push({ level: 'warning', tipo: 'spike_menciones', mensaje: `Alto volumen reciente: ${recentMentions.length} menciones en 7 días.` });
  const negNews = recentMentions.filter(m => m.platform === 'noticias' && (m as any).sentiment === 'negativo');
  if (negNews.length >= 2) alerts.push({ level: 'warning', tipo: 'cobertura_negativa', mensaje: `${negNews.length} artículos negativos en prensa en los últimos 7 días.`, plataforma: 'noticias', url: negNews[0]?.url });
  return alerts;
}

function extractKeywords(items: (Mention | Comment)[], keyword: string): string[] {
  const stop = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'que', 'es', 'un', 'una', 'los', 'las', 'del', 'con', 'por', 'para', 'se', 'no', 'al', 'más', 'como', 'lo', 'su']);
  const kwParts = keyword.toLowerCase().split(/\s+/);
  const text = items.map(i => i.text).join(' ').toLowerCase();
  const words = text.match(/\b[a-záéíóúñü]{4,}\b/g) || [];
  const freq: Record<string, number> = {};
  for (const w of words) if (!stop.has(w) && !kwParts.some(p => w.includes(p))) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w);
}

async function postToBackend(payload: ScanPayload): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/agent/scan-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(AGENT_KEY ? { 'x-agent-key': AGENT_KEY } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.success) console.log(`[Backend] ✅ Datos enviados: "${payload.keyword}" — ${payload.totalMentions} menciones`);
  else console.error('[Backend] ❌ Error:', data.error);
}

// ─── Reporte diario formateado ────────────────────────────────────────────────
function buildDailyReport(
  keyword: string,
  mentions: any[],
  comments: any[],
  platforms: Record<string, { mentions: number; comments: number; etiquetados: number }>,
  aiSummary: any | null,
): string {
  const now = new Date();
  const dia = now.getDate().toString().padStart(2, '0');
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mes = meses[now.getMonth()];
  const anio = now.getFullYear();
  const horaRaw = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true });

  const total = mentions.length + comments.length;

  // Sentiment breakdown por score
  const allItems = [...mentions, ...comments];
  let posCount = 0, negCount = 0, neuCount = 0;
  for (const item of allItems) {
    const score = (item as any).sentiment_score ?? 0;
    if (score > 0.1) posCount++;
    else if (score < -0.1) negCount++;
    else neuCount++;
  }
  const sentTotal = allItems.length || 1;
  const fmt = (n: number) => ((n / sentTotal) * 100).toFixed(2).replace('.', ',');

  // Platform breakdown
  const platCounts: Record<string, number> = {};
  for (const m of mentions) platCounts[m.platform || 'otro'] = (platCounts[m.platform || 'otro'] || 0) + 1;
  const platTotal = mentions.length || 1;
  const PLAT_LABELS: Record<string, string> = {
    twitter:'X/Twitter', x:'X/Twitter', instagram:'Instagram', linkedin:'LinkedIn',
    threads:'Threads', facebook:'Facebook', youtube:'YouTube', reddit:'Reddit',
    noticias:'Noticias', tiktok:'TikTok',
  };
  const platLines = Object.entries(platCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${PLAT_LABELS[p] || p}: ${Math.round((n / platTotal) * 100)}%`)
    .join('\n');

  // Top temas narrativos
  let temasSection = '';
  if (aiSummary?.topTemas?.length > 0) {
    temasSection = '\n\n\nTop de temas:\n\n' +
      (aiSummary.topTemas as any[])
        .map((t: any) => `${t.narrativa}\n\nMención destacada:\n${t.url}`)
        .join('\n\n\n');
  }

  return [
    `Monitoreo diario ${dia} ${mes} ${anio}, hora ${horaRaw}`,
    '',
    `Total menciones: ${total}`,
    '',
    'Sentiment:',
    `⚪ Neutral: ${fmt(neuCount)}%`,
    `🔴 Negativo: ${fmt(negCount)}%`,
    `🟢 Positivo: ${fmt(posCount)}%`,
    '',
    'Fuentes de menciones:',
    '',
    platLines,
    temasSection,
  ].join('\n');
}

// ─── Escaneo principal ────────────────────────────────────────────────────────
async function runScan(keyword: string, pills?: string[], days = 30, exclusions: string[] = [], selectedPlatforms: string[] = [], dateRange?: { start?: string; end?: string }): Promise<void> {
  status = 'running';
  currentKeyword = keyword;
  scanStartedAt = new Date().toISOString();
  stopRequested = false;

  const { base: baseKeyword, extraTerms } = parseSearchTerms(keyword, pills);
  const displayKeyword = keyword; // nombre para mostrar al usuario (todos los pills)

  console.log(`\n🔍 Escaneando: "${displayKeyword}"`);
  if (extraTerms.length > 0) console.log(`   Base: "${baseKeyword}" | Extra: ${extraTerms.join(', ')}`);

  try {
    const allMentions: Mention[] = [];
    const allComments: Comment[] = [];
    const allEtiquetados: Etiquetado[] = [];
    const platforms: Record<string, { mentions: number; comments: number; etiquetados: number }> = {};
    const completedPlatforms: string[] = [];

    // Publica resultado parcial en lastResult para que el frontend lo vea en tiempo real.
    // `note` es para progreso DENTRO de una sola plataforma que tarda mucho (ej. Twitter
    // buscando por bloques mensuales) — sin esto, el frontend no tiene nada nuevo que
    // mostrar entre el inicio de una plataforma y su finalización completa, aunque haya
    // progreso real ocurriendo (bloque 3/7, bloque 4/7, etc.).
    const publishPartial = (final: boolean, note?: string) => {
      applySentiment(allMentions);
      applySentiment(allComments);
      const scores = [...allMentions, ...allComments].map(i => (i as any).sentiment_score || 0);
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const sentimentLabel: 'positivo' | 'negativo' | 'neutro' = avgScore > 0.1 ? 'positivo' : avgScore < -0.1 ? 'negativo' : 'neutro';
      const influencers = [...allMentions].filter(m => (m.likes || 0) >= 50).sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10);
      const alerts = final ? buildAlerts(displayKeyword, allMentions, allComments, avgScore) : [];
      const kws = extractKeywords([...allMentions, ...allComments], baseKeyword);
      const byDateDesc = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
      lastResult = {
        keyword: displayKeyword, brand: displayKeyword,
        scannedAt: new Date().toISOString(),
        totalMentions: allMentions.length,
        platforms: { ...platforms },
        sentiment: parseFloat(avgScore.toFixed(4)),
        sentimentLabel,
        topMentions: [...allMentions].sort(byDateDesc).slice(0, 100),
        comments: [...allComments].sort(byDateDesc).slice(0, 200),
        etiquetados: allEtiquetados.slice(0, 60),
        influencers, alerts, keywords: kws,
        summary: final
          ? `Escaneo de "${displayKeyword}": ${allMentions.length} menciones, ${allComments.length} comentarios, ${allEtiquetados.length} etiquetados. Sentimiento ${sentimentLabel}.`
          : note || `Escaneando "${displayKeyword}"… ${completedPlatforms.length}/9 fuentes listas · ${allMentions.length} menciones encontradas.`,
        _partial: !final,
        _completedPlatforms: [...completedPlatforms],
      } as any;
    };

    // OJO: scrapeLinkedIn ya usa la posición 4 para "exclusions" (un array) —
    // sinceDate/untilDate van en las posiciones 5 y 6 para no chocar con eso.
    // Pasamos `undefined` explícito en la 4 porque el filtro de exclusions ya
    // se aplica de forma centralizada más abajo en runScan, no por-scraper.
    // Posiciones 7/8 (onChunkProgress/shouldStop) solo las usa Twitter, que
    // divide búsquedas de rango largo en bloques mensuales — cada bloque puede
    // tardar minutos, así que sin esto el frontend no ve NADA nuevo entre el
    // inicio de Twitter y su finalización completa (podían ser 20-40 min en
    // silencio), y /stop no interrumpía un escaneo a mitad de sus bloques.
    type Scraper = (kw: string, extra: string[], days: number, exclusions?: string[], sinceDate?: string, untilDate?: string, onChunkProgress?: (note: string) => void, shouldStop?: () => boolean) => Promise<{ mentions: Mention[]; comments: Comment[]; etiquetados?: Etiquetado[] }>;

    const contextTerms = getContextTerms(baseKeyword, extraTerms);

    const runScraper = async (key: string, run: Scraper) => {
      try {
        // Si el rango pedido termina en el pasado (no "hoy"), pasamos esas
        // fechas para que el scraper (Twitter, Noticias) pueda buscar directo
        // en esa ventana (until:/cdr: en vez de scrollear desde hoy hasta
        // llegar, que gastaría el tope de resultados en contenido irrelevante).
        const onChunkProgress = key === 'twitter' ? (note: string) => publishPartial(false, note) : undefined;
        const shouldStop = () => stopRequested;
        let { mentions, comments, etiquetados = [] } = await run(baseKeyword, extraTerms, days, undefined, dateRange?.start, dateRange?.end, onChunkProgress, shouldStop);
        mentions = filterByContext(mentions, contextTerms, key, 'menciones');
        comments = filterByContext(comments, contextTerms, key, 'comentarios');
        allMentions.push(...mentions);
        allComments.push(...comments);
        allEtiquetados.push(...etiquetados);
        platforms[key] = { mentions: mentions.length, comments: comments.length, etiquetados: etiquetados.length };
        console.log(`[${key}] ✅ ${mentions.length}m ${comments.length}c — acumulado: ${allMentions.length}m`);
      } catch (e: any) {
        console.warn(`[${key}] ❌ Falló:`, e.message?.slice(0, 60));
        platforms[key] = { mentions: 0, comments: 0, etiquetados: 0 };
      }
      completedPlatforms.push(key);
      publishPartial(false);
    };

    // Filtro de plataformas — si se pasaron plataformas seleccionadas, solo correr esas
    const active = selectedPlatforms.length > 0 ? selectedPlatforms : ['twitter','youtube','noticias','instagram','reddit','facebook','linkedin','threads','tiktok'];

    // Una plataforma a la vez, en secuencia — NO en paralelo. Correr varios
    // scrapers Playwright a la vez (cada uno con su propio contexto/pestañas,
    // Twitter llega a abrir 20+ pestañas para hilos) satura una máquina con
    // poca RAM y el scan completo termina más lento e inestable que corriendo
    // una por una. Cada scraper cierra su contexto en su propio `finally`
    // (ctx.close()), así que la memoria sí se libera entre plataforma y plataforma.
    const PLATFORM_ORDER: [string, Scraper][] = [
      ['twitter', scrapeTwitter as Scraper],
      ['youtube', scrapeYouTube as Scraper],
      ['noticias', scrapeNews as Scraper],
      ['instagram', scrapeInstagram as Scraper],
      ['reddit', scrapeReddit as Scraper],
      ['facebook', scrapeFacebook as Scraper],
      ['linkedin', scrapeLinkedIn as Scraper],
      ['threads', scrapeThreads as Scraper],
      ['tiktok', scrapeTikTok as Scraper],
    ];

    for (const [key, scraper] of PLATFORM_ORDER) {
      if (stopRequested) break;
      if (!active.includes(key)) continue;
      console.log(`🔄 ${key}`);
      await runScraper(key, scraper);
    }

    if (stopRequested) {
      console.log('[Scan] Detenido manualmente por el usuario.');
      status = 'error';
      lastError = 'Escaneo detenido manualmente.';
      return;
    }

    // Filtrar por autor Y por contenido de texto
    // - Términos con @ → solo comparan contra el autor
    // - Términos sin @ → comparan contra autor Y texto del post
    if (exclusions.length > 0) {
      const authorTerms  = exclusions.map(e => e.toLowerCase().replace(/[@#\s]/g, ''));
      const contentTerms = exclusions
        .filter(e => !e.startsWith('@'))
        .map(e => e.toLowerCase().replace(/[@#\s]/g, ''));

      const isExcluded = (author: string, text: string) => {
        const a = author.toLowerCase().replace(/[@#\s]/g, '');
        const t = text.toLowerCase();
        // Excluir por autor (coincidencia exacta, prefijo o subcadena)
        if (authorTerms.some(e => a === e || a.startsWith(e) || a.includes(e))) return true;
        // Excluir por contenido del texto (palabra completa o subcadena)
        if (contentTerms.some(e => t.includes(e))) return true;
        return false;
      };

      const beforeM = allMentions.length;
      const beforeC = allComments.length;

      const keepM = allMentions.filter(m => !isExcluded(m.author, m.text || ''));
      const keepC = allComments.filter(c => !isExcluded(c.author, c.text || ''));

      const removedM = beforeM - keepM.length;
      const removedC = beforeC - keepC.length;

      if (removedM + removedC > 0) {
        console.log(`[Filtro] Excluidos: ${removedM} menciones + ${removedC} comentarios (autor o contenido)`);
        allMentions.length = 0; allMentions.push(...keepM);
        allComments.length = 0; allComments.push(...keepC);
      }
    }

    // ── Rango de fecha exacto (si el usuario eligió fecha/rango específico) ──
    if (dateRange?.start || dateRange?.end) {
      const beforeM2 = allMentions.length, beforeC2 = allComments.length;
      const keepM2 = allMentions.filter(m => inExactRange(m.date, dateRange.start, dateRange.end));
      const keepC2 = allComments.filter(c => inExactRange(c.date, dateRange.start, dateRange.end));
      allMentions.length = 0; allMentions.push(...keepM2);
      allComments.length = 0; allComments.push(...keepC2);
      allEtiquetados.splice(0, allEtiquetados.length, ...allEtiquetados.filter(e => inExactRange(e.date, dateRange.start, dateRange.end)));
      console.log(`[Fecha] Rango ${dateRange.start || '…'} a ${dateRange.end || '…'}: ${beforeM2}→${keepM2.length}m, ${beforeC2}→${keepC2.length}c`);
    }

    // ── Dedup contra historial de scans anteriores ────────────────────────────
    const seenUrls = getSeenUrls(baseKeyword);
    const totalBeforeDedup = allMentions.length + allComments.length;

    // Separar nuevos de ya vistos
    const newMentions  = allMentions.filter(m => !m.url || !seenUrls.has(m.url));
    const newComments  = allComments.filter(c => !c.url || !seenUrls.has(c.url));
    const seenMentions = allMentions.filter(m => m.url && seenUrls.has(m.url));
    const seenComments = allComments.filter(c => c.url && seenUrls.has(c.url));

    // Marcar como nuevo / ya visto
    newMentions.forEach(m => (m as any)._isNew = true);
    newComments.forEach(c => (c as any)._isNew = true);
    seenMentions.forEach(m => (m as any)._isNew = false);
    seenComments.forEach(c => (c as any)._isNew = false);

    const skippedM = seenMentions.length;
    const skippedC = seenComments.length;
    if (skippedM + skippedC > 0)
      console.log(`[Dedup] ${skippedM}m + ${skippedC}c ya vistos → omitidos. Nuevos: ${newMentions.length}m + ${newComments.length}c`);

    // Reemplazar con solo los nuevos (descarta los ya vistos)
    allMentions.length = 0; allMentions.push(...newMentions);
    allComments.length = 0; allComments.push(...newComments);
    allEtiquetados.splice(0, allEtiquetados.length, ...allEtiquetados.filter(e => !e.url || !seenUrls.has(e.url)));

    if (allMentions.length === 0 && allComments.length === 0 && totalBeforeDedup > 0) {
      console.log(`[Dedup] Todo ya fue visto antes — sin contenido nuevo en este scan`);
    }

    // ── Resumen IA (Gemini) ───────────────────────────────────────────────────
    console.log('[AISummary] Generando resumen IA...');
    const aiSummary = await generateAISummary(allMentions, allComments, displayKeyword).catch(() => null);

    // Resultado final con alertas — mantener _partial:true mientras se genera IA
    publishPartial(true);
    (lastResult as any)._partial = true; // IA aún computando — el frontend espera

    const payload = lastResult! as any;
    if (aiSummary) {
      payload.aiSummary = aiSummary;
      payload.summary = aiSummary.resumen;
    } else {
      // Fallback: resumen básico sin IA para que el payload siempre tenga algo
      payload.aiSummary = {
        resumen: `Escaneo de "${displayKeyword}": ${allMentions.length} menciones en ${Object.keys(platforms).join(', ')}. Sentimiento ${payload.sentimentLabel}.`,
        hitos: allMentions.slice(0, 3).map(m => `${m.platform}: ${m.text.slice(0, 80)}`),
        alertas: [],
        sentimiento: payload.sentimentLabel,
        recomendacion: 'Revisar los resultados del escaneo y tomar acciones según el sentimiento predominante.',
        temas: [],
        topTemas: [],
      };
    }

    // Construir reporte diario formateado y añadir al payload
    const dailyReport = buildDailyReport(displayKeyword, allMentions, allComments, platforms, payload.aiSummary);
    payload.dailyReport = dailyReport;
    payload._partial = false; // ahora sí — IA + dailyReport listos → frontend puede salir
    status = 'done';

    console.log(`✅ "${displayKeyword}": ${allMentions.length}m ${allComments.length}c ${allEtiquetados.length}e | ${payload.sentimentLabel}`);

    // Registrar URLs nuevas como "ya vistas" para el próximo scan
    markAsSeen(baseKeyword, [...allMentions, ...allComments, ...allEtiquetados]);

    // Backup local
    const dir = path.join(process.cwd(), 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${baseKeyword.replace(/\s+/g, '_')}_${Date.now()}.json`), JSON.stringify(payload, null, 2));

    // Enviar al backend de Zalvaje (non-blocking)
    await postToBackend(payload).catch((e: any) => console.warn('[Backend] ⚠ No se pudo enviar:', e.message?.slice(0, 80)));

    // ── WhatsApp ────
    sendWhatsApp(dailyReport.slice(0, 860) + (dailyReport.length > 860 ? '…' : '')).catch(() => {});

  } catch (e: any) {
    status = 'error';
    lastError = e.message;
    console.error('[Scan] Error:', e.message);
  } finally {
    await closeBrowser();
  }
}

// ─── Escaneo de PERFIL de influencer — visita el perfil propio en cada
// plataforma seleccionada (no una búsqueda) y trae sus posts reales con
// likes/comentarios/views/miniatura/link. Corre las plataformas en secuencia
// (mismo motivo que runScan: no saturar una máquina con poca RAM) y publica
// resultados parciales a medida que cada plataforma termina. ──────────────
async function runProfileScan(handle: string, platforms: string[]): Promise<void> {
  profileStatus = 'running';
  currentProfileHandle = handle;
  stopRequested = false;

  console.log(`\n👤 Escaneando perfil: "${handle}" en [${platforms.join(', ')}]`);

  try {
    const profiles: ProfileInfo[] = [];
    const allPosts: ProfilePost[] = [];

    const publishPartial = () => {
      const byPlatform: Record<string, { posts: number; likes: number; comments: number; views: number }> = {};
      for (const p of allPosts) {
        if (!byPlatform[p.platform]) byPlatform[p.platform] = { posts: 0, likes: 0, comments: 0, views: 0 };
        const b = byPlatform[p.platform];
        b.posts++; b.likes += p.likes || 0; b.comments += p.comments || 0; b.views += p.views || 0;
      }
      const totalLikes = allPosts.reduce((s, p) => s + (p.likes || 0), 0);
      const totalComments = allPosts.reduce((s, p) => s + (p.comments || 0), 0);
      const totalViews = allPosts.reduce((s, p) => s + (p.views || 0), 0);
      const n = allPosts.length || 1;
      // Engagement rate estándar: (likes+comentarios promedio) / seguidores.
      // Antes dividía por "views", que en Instagram solo existe en reels/videos
      // — un feed de fotos (la mayoría de las cuentas) siempre daba 0%.
      const totalFollowers = profiles.reduce((s, p) => s + (p.followers || 0), 0);
      const avgEngagementRate = totalFollowers > 0
        ? (totalLikes / n + totalComments / n) / totalFollowers
        : 0;

      lastProfileResult = {
        handle,
        scannedAt: new Date().toISOString(),
        profiles: [...profiles],
        posts: [...allPosts].sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()),
        totals: {
          posts: allPosts.length,
          likes: totalLikes,
          comments: totalComments,
          views: totalViews,
          avgLikes: Math.round(totalLikes / n),
          avgComments: Math.round(totalComments / n),
          avgEngagementRate: parseFloat((avgEngagementRate * 100).toFixed(2)),
        },
        byPlatform,
      };
    };

    type ProfileScraper = (h: string, max?: number) => Promise<{ profile: ProfileInfo | null; posts: ProfilePost[] }>;
    const SCRAPERS: Record<string, ProfileScraper> = {
      twitter: scrapeTwitterProfile,
      instagram: scrapeInstagramProfile,
      tiktok: scrapeTikTokProfile,
      youtube: scrapeYouTubeProfile,
    };

    for (const key of platforms) {
      if (stopRequested) break;
      const scraper = SCRAPERS[key];
      if (!scraper) { console.warn(`[ProfileScan] Plataforma desconocida: ${key}`); continue; }
      try {
        const { profile, posts } = await scraper(handle, 12);
        if (profile) profiles.push(profile);
        allPosts.push(...posts);
        console.log(`[ProfileScan] ${key} → ${posts.length} posts`);
      } catch (e: any) {
        console.error(`[ProfileScan] Error en ${key}:`, e.message?.slice(0, 100));
      }
      publishPartial();
    }

    profileStatus = 'done';
    console.log(`[ProfileScan] Completo: ${allPosts.length} posts en ${profiles.length} plataformas`);
  } catch (e: any) {
    profileStatus = 'error';
    profileError = e.message;
    console.error('[ProfileScan] Error:', e.message);
  } finally {
    await closeBrowser();
  }
}

// ─── Escaneo parcial (plataformas seleccionadas, merge con lastResult) ───────
async function runScanPartial(keyword: string, pills?: string[], days = 7, exclusions: string[] = [], platforms: string[] = []): Promise<void> {
  status = 'running';
  currentKeyword = keyword;
  scanStartedAt = new Date().toISOString();

  const { base: baseKeyword, extraTerms } = parseSearchTerms(keyword, pills);
  const displayKeyword = keyword;
  console.log(`\n🔎 Enriqueciendo: "${displayKeyword}" | Plataformas: ${platforms.join(', ')} | ${days}d`);

  const SCRAPER_MAP: Record<string, (kw: string, extra: string[], d: number) => Promise<{ mentions: Mention[]; comments: Comment[]; etiquetados?: Etiquetado[] }>> = {
    twitter:   scrapeTwitter,
    youtube:   scrapeYouTube,
    noticias:  scrapeNews,
    instagram: scrapeInstagram,
    reddit:    scrapeReddit,
    facebook:  scrapeFacebook,
    linkedin:  scrapeLinkedIn,
    threads:   scrapeThreads,
    tiktok:    scrapeTikTok,
  };

  const newMentions: Mention[] = [];
  const newComments: Comment[] = [];
  const newEtiquetados: Etiquetado[] = [];
  const newPlatforms: Record<string, { mentions: number; comments: number; etiquetados: number }> = {};
  const completedPlatforms: string[] = [];

  // Snapshot inicial de URLs ya existentes en lastResult (para dedup incremental)
  const prevSnapshot = lastResult;
  const existingUrls = new Set<string>();
  if (prevSnapshot) {
    (prevSnapshot.topMentions || []).forEach((m: any) => m.url && existingUrls.add(m.url));
    (prevSnapshot.comments    || []).forEach((c: any) => c.url && existingUrls.add(c.url));
    (prevSnapshot.etiquetados || []).forEach((e: any) => e.url && existingUrls.add(e.url));
  }

  // Construye el merge actual (parcial o final) y lo publica en lastResult
  // para que el frontend lo vea via /results.
  const pushMerged = (isFinal: boolean) => {
    const byDateDesc = (a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();

    // Aplicar exclusiones
    let filtM = newMentions.slice();
    let filtC = newComments.slice();
    if (exclusions.length > 0) {
      const authorTerms  = exclusions.map(e => e.toLowerCase().replace(/[@#\s]/g, ''));
      const contentTerms = exclusions.filter(e => !e.startsWith('@')).map(e => e.toLowerCase().replace(/[@#\s]/g, ''));
      const isExcl = (author: string, text: string) => {
        const a = author.toLowerCase().replace(/[@#\s]/g, '');
        const t = text.toLowerCase();
        return authorTerms.some(e => a.includes(e)) || contentTerms.some(e => t.includes(e));
      };
      filtM = filtM.filter(m => !isExcl(m.author, m.text || ''));
      filtC = filtC.filter(c => !isExcl(c.author, c.text || ''));
    }

    const dedupM = filtM.filter(m => !existingUrls.has(m.url));
    const dedupC = filtC.filter(c => !existingUrls.has(c.url));
    const dedupE = newEtiquetados.filter(e => !existingUrls.has(e.url));

    const allM: Mention[]    = [...(prevSnapshot?.topMentions || []) as Mention[], ...dedupM].sort(byDateDesc);
    const allC: Comment[]    = [...(prevSnapshot?.comments    || []) as Comment[], ...dedupC].sort(byDateDesc);
    const allE: Etiquetado[] = [...(prevSnapshot?.etiquetados || []) as Etiquetado[], ...dedupE];

    const mergedPlatforms: Record<string, { mentions: number; comments: number; etiquetados: number }> = {
      ...(prevSnapshot?.platforms || {}),
      ...Object.fromEntries(Object.entries(newPlatforms).map(([k, v]) => {
        const ex = (prevSnapshot?.platforms as any)?.[k];
        return [k, ex ? { mentions: ex.mentions + v.mentions, comments: ex.comments + v.comments, etiquetados: ex.etiquetados + v.etiquetados } : v];
      })),
    };

    applySentiment(allM);
    applySentiment(allC);
    const scores = [...allM, ...allC].map(i => (i as any).sentiment_score || 0);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const sentimentLabel: 'positivo' | 'negativo' | 'neutro' = avgScore > 0.1 ? 'positivo' : avgScore < -0.1 ? 'negativo' : 'neutro';
    const influencers = [...allM].filter(m => (m.likes || 0) >= 50).sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10);
    const kws = extractKeywords([...allM, ...allC], baseKeyword);

    lastResult = {
      keyword: displayKeyword, brand: displayKeyword,
      scannedAt: new Date().toISOString(),
      totalMentions: allM.length,
      platforms: mergedPlatforms,
      sentiment: parseFloat(avgScore.toFixed(4)),
      sentimentLabel,
      topMentions: allM.slice(0, 100),
      comments: allC.slice(0, 200),
      etiquetados: allE.slice(0, 80),
      influencers,
      alerts: isFinal ? buildAlerts(displayKeyword, allM, allC, avgScore) : [],
      keywords: kws,
      summary: isFinal
        ? `Enriquecido "${displayKeyword}": +${dedupM.length} nuevas menciones, +${dedupC.length} nuevos comentarios (${platforms.join(', ')}).`
        : `Enriqueciendo "${displayKeyword}"… ${completedPlatforms.length}/${platforms.length} plataformas · ${allM.length} menciones`,
      _partial: !isFinal,
      _completedPlatforms: [...completedPlatforms],
      _enriched: true,
      _newMentions: dedupM.length,
      _newComments: dedupC.length,
    } as any;
  };

  const contextTerms = getContextTerms(baseKeyword, extraTerms);

  try {
    const selected = platforms.filter(p => SCRAPER_MAP[p]);

    for (const key of selected) {
      try {
        let { mentions, comments, etiquetados = [] } = await SCRAPER_MAP[key](baseKeyword, extraTerms, days);
        mentions = filterByContext(mentions, contextTerms, key, 'menciones');
        comments = filterByContext(comments, contextTerms, key, 'comentarios');
        newMentions.push(...mentions);
        newComments.push(...comments);
        newEtiquetados.push(...etiquetados);
        newPlatforms[key] = { mentions: mentions.length, comments: comments.length, etiquetados: etiquetados.length };
        console.log(`[${key}] ✅ ${mentions.length}m ${comments.length}c`);
      } catch (e: any) {
        console.warn(`[${key}] ❌ Falló:`, e.message?.slice(0, 60));
        newPlatforms[key] = { mentions: 0, comments: 0, etiquetados: 0 };
      }
      completedPlatforms.push(key);
      // Push parcial con datos reales mergeados — igual que el scan inicial
      pushMerged(false);
    }

    pushMerged(true);
    (lastResult as any)._partial = true; // IA aún computando — el frontend espera
    console.log(`✅ Enriquecido | Total: ${lastResult!.totalMentions}m ${lastResult!.comments?.length ?? 0}c`);

    // Generar AI summary para el enriquecimiento
    const enrichAISummary = await generateAISummary(
      (lastResult!.topMentions || []) as any[],
      (lastResult!.comments || []) as any[],
      displayKeyword,
    ).catch(() => null);

    if (enrichAISummary) {
      (lastResult as any).aiSummary = enrichAISummary;
      (lastResult as any).summary = enrichAISummary.resumen;
    } else if (!(lastResult as any).aiSummary) {
      (lastResult as any).aiSummary = {
        resumen: `Enriquecimiento de "${displayKeyword}": ${lastResult!.totalMentions} menciones en ${Object.keys((lastResult!.platforms || {})).join(', ')}.`,
        hitos: [], alertas: [], sentimiento: (lastResult as any).sentimentLabel,
        recomendacion: 'Revisar los nuevos resultados del enriquecimiento.',
        temas: [], topTemas: [],
      };
    }

    // Reporte diario formateado
    const enrichReport = buildDailyReport(
      displayKeyword,
      (lastResult!.topMentions || []) as any[],
      (lastResult!.comments || []) as any[],
      (lastResult!.platforms || {}) as any,
      (lastResult as any).aiSummary,
    );
    (lastResult as any).dailyReport = enrichReport;
    (lastResult as any)._partial = false; // IA + dailyReport listos → frontend puede salir
    status = 'done';

    sendWhatsApp(enrichReport.slice(0, 860) + (enrichReport.length > 860 ? '…' : '')).catch(() => {});

  } catch (e: any) {
    status = 'error';
    lastError = e.message;
    console.error('[Partial] Error:', e.message);
  } finally {
    await closeBrowser();
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning, x-agent-key');
}

function json(res: http.ServerResponse, data: unknown, code = 200) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // Autenticación — obligatoria si AGENT_KEY está configurada (necesario en cuanto
  // el puerto queda expuesto a internet vía túnel; sin esto cualquiera podría
  // disparar scans, borrar el historial o leer resultados).
  if (AGENT_KEY && req.headers['x-agent-key'] !== AGENT_KEY) {
    return json(res, { error: 'unauthorized' }, 401);
  }

  // GET /status
  if (method === 'GET' && url === '/status') {
    return json(res, {
      online: true,
      status,
      currentKeyword: currentKeyword || null,
      scanStartedAt: scanStartedAt || null,
      lastKeyword: lastResult?.keyword || null,
      completedPlatforms: lastResult ? Object.keys((lastResult as any).platforms ?? {}) : [],
      totalMentions: lastResult?.totalMentions ?? 0,
      version: '1.0',
    });
  }

  // POST /scan
  if (method === 'POST' && url === '/scan') {
    const b = await body(req);
    const keyword = (b.keyword || b.brand || '').trim();
    const pills: string[] = Array.isArray(b.pills) ? b.pills.map((p: string) => String(p).trim()).filter(Boolean) : [];
    const exclusions: string[] = Array.isArray(b.exclusions) ? b.exclusions.map((e: string) => String(e).trim().toLowerCase().replace(/[@#]/g, '')).filter(Boolean) : [];
    const platforms: string[] = Array.isArray(b.platforms) ? b.platforms.map((p: string) => String(p).trim()).filter(Boolean) : [];
    if (!keyword) return json(res, { error: 'keyword requerida' }, 400);

    // Fecha/rango específico (YYYY-MM-DD) — si viene, los scrapers igual buscan
    // con una ventana `days` que cubra de sobra el rango, y luego se recorta
    // al rango exacto en runScan (inExactRange).
    const startDate: string | undefined = typeof b.startDate === 'string' && b.startDate ? b.startDate : undefined;
    const endDate: string | undefined = typeof b.endDate === 'string' && b.endDate ? b.endDate : undefined;
    let days: number = typeof b.days === 'number' && b.days > 0 ? Math.min(b.days, 3650) : 30;
    if (startDate) {
      const daysBack = Math.ceil((Date.now() - new Date(startDate).getTime()) / 86400000);
      days = Math.min(Math.max(daysBack, 1), 3650);
    }

    if (status === 'running') {
      return json(res, { queued: false, message: `Ya hay un escaneo en curso: "${currentKeyword}". Espera que termine.` });
    }

    // Arrancar escaneo en background — timeout máximo 2 horas
    const SCAN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
    const scanTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Scan superó el límite de 2 horas')), SCAN_TIMEOUT_MS)
    );
    Promise.race([
      runScan(keyword, pills.length > 0 ? pills : undefined, days, exclusions, platforms, { start: startDate, end: endDate }),
      scanTimeout,
    ]).catch(e => {
      console.error('[Server] Scan error:', e.message);
      if (status === 'running') { status = 'error'; lastError = e.message; }
    });

    return json(res, { queued: true, keyword, message: `Escaneando "${keyword}"… puede tardar hasta 20-30 min dependiendo del volumen. Los resultados aparecerán en ZALVAJE automáticamente.` });
  }

  // POST /stop — interrumpe el escaneo en curso cerrando el browser (los scrapers
  // en vuelo fallan con "Target closed" y sus propios try/catch lo manejan).
  if (method === 'POST' && url === '/stop') {
    if (status !== 'running' && profileStatus !== 'running') {
      return json(res, { stopped: false, message: 'No hay ningún escaneo en curso.' });
    }
    stopRequested = true;
    await closeBrowser().catch(() => {});
    if (status === 'running') { status = 'error'; lastError = 'Escaneo detenido manualmente por el usuario.'; }
    if (profileStatus === 'running') { profileStatus = 'error'; profileError = 'Escaneo detenido manualmente por el usuario.'; }
    console.log('[Server] Escaneo detenido manualmente.');
    return json(res, { stopped: true, message: 'Escaneo detenido.' });
  }

  // GET /results — payload con screenshots (ngrok es red local, timeout frontend = 120s)
  if (method === 'GET' && (url === '/results' || url.startsWith('/results?'))) {
    if (!lastResult) return json(res, { success: false, message: 'Sin resultados aún. Dispara un escaneo primero.' });
    return json(res, { success: true, status, result: lastResult });
  }

  // GET /screenshots/:file — sirve capturas de pantalla al frontend
  if (method === 'GET' && url.startsWith('/screenshots/')) {
    const fname = path.basename(url.replace('/screenshots/', ''));
    const fpath = path.join(SCREENSHOTS_DIR, fname);
    if (fs.existsSync(fpath)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(fpath).pipe(res);
    } else {
      json(res, { error: 'Screenshot not found' }, 404);
    }
    return;
  }

  // POST /scan-partial — escanea solo las plataformas seleccionadas y merge con lastResult
  if (method === 'POST' && url === '/scan-partial') {
    const b = await body(req);
    const keyword    = (b.keyword || b.brand || '').trim();
    const pills: string[] = Array.isArray(b.pills) ? b.pills.map((p: string) => String(p).trim()).filter(Boolean) : [];
    const days: number = typeof b.days === 'number' && b.days > 0 ? Math.min(b.days, 3650) : 7;
    const exclusions: string[] = Array.isArray(b.exclusions) ? b.exclusions.map((e: string) => String(e).trim().toLowerCase().replace(/[@#]/g, '')).filter(Boolean) : [];
    const platforms: string[] = Array.isArray(b.platforms) ? b.platforms.map((p: string) => String(p).toLowerCase().trim()) : [];
    if (!keyword) return json(res, { error: 'keyword requerida' }, 400);
    if (platforms.length === 0) return json(res, { error: 'platforms[] requerido' }, 400);

    if (status === 'running') {
      return json(res, { queued: false, message: `Ya hay un escaneo en curso: "${currentKeyword}". Espera que termine.` });
    }

    const SCAN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
    const scanTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Scan superó el límite de 2 horas')), SCAN_TIMEOUT_MS)
    );
    Promise.race([
      runScanPartial(keyword, pills.length > 0 ? pills : undefined, days, exclusions, platforms),
      scanTimeout,
    ]).catch(e => {
      console.error('[Server] Scan-partial error:', e.message);
      if (status === 'running') { status = 'error'; lastError = e.message; }
    });

    return json(res, { queued: true, keyword, platforms, message: `Enriqueciendo "${keyword}" en ${platforms.join(', ')}… (${days}d)` });
  }

  // POST /scan-profile — visita el perfil PROPIO de un handle (no una búsqueda)
  // y trae sus posts reales con likes/comentarios/views/miniatura/link.
  if (method === 'POST' && url === '/scan-profile') {
    const b = await body(req);
    const handle = (b.handle || '').trim();
    const platforms: string[] = Array.isArray(b.platforms) && b.platforms.length > 0
      ? b.platforms.map((p: string) => String(p).toLowerCase().trim())
      : ['twitter', 'instagram', 'tiktok', 'youtube'];
    if (!handle) return json(res, { error: 'handle requerido' }, 400);

    if (profileStatus === 'running') {
      return json(res, { queued: false, message: `Ya hay un escaneo de perfil en curso: "${currentProfileHandle}". Espera que termine.` });
    }
    if (status === 'running') {
      return json(res, { queued: false, message: 'Hay un escaneo por palabra clave en curso. Espera que termine antes de escanear un perfil (comparten el navegador).' });
    }

    const SCAN_TIMEOUT_MS = 20 * 60 * 1000; // un perfil (4 plataformas, ~12 posts c/u) es mucho más rápido que un scan por keyword
    const scanTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Escaneo de perfil superó el límite de 20 minutos')), SCAN_TIMEOUT_MS)
    );
    Promise.race([runProfileScan(handle, platforms), scanTimeout]).catch(e => {
      console.error('[Server] Scan-profile error:', e.message);
      if (profileStatus === 'running') { profileStatus = 'error'; profileError = e.message; }
    });

    return json(res, { queued: true, handle, platforms, message: `Escaneando perfil de "${handle}"… puede tardar unos minutos.` });
  }

  // GET /profile-status
  if (method === 'GET' && url === '/profile-status') {
    return json(res, {
      online: true,
      status: profileStatus,
      currentHandle: currentProfileHandle || null,
      lastHandle: lastProfileResult?.handle || null,
    });
  }

  // GET /profile-results
  if (method === 'GET' && (url === '/profile-results' || url.startsWith('/profile-results?'))) {
    if (!lastProfileResult) return json(res, { success: false, message: 'Sin resultados aún. Dispara un escaneo de perfil primero.' });
    return json(res, { success: true, status: profileStatus, result: lastProfileResult });
  }

  // POST /clear-seen — resetea el historial de URLs vistas (para re-escanear todo desde cero)
  if (method === 'POST' && url === '/clear-seen') {
    const b = await body(req);
    const keyword = (b.keyword || '').trim();
    if (keyword) {
      delete seenByKeyword[keyword];
      console.log(`[Seen] Historial de "${keyword}" borrado`);
    } else {
      for (const k of Object.keys(seenByKeyword)) delete seenByKeyword[k];
      console.log('[Seen] Historial completo borrado');
    }
    saveSeenUrls();
    return json(res, { ok: true, cleared: keyword || 'all' });
  }

  // 404
  json(res, { error: 'Not found' }, 404);
});

// ─── Quick Tunnel — expone el agente en internet sin necesitar un dominio propio ──
// Sin dominio en Cloudflare no hay hostname público estable, así que en vez de fijar
// una URL, el agente lanza un Quick Tunnel (URL aleatoria *.trycloudflare.com), la
// detecta en el output de cloudflared y la reporta al backend. El backend guarda
// "la URL vigente" y el frontend la consulta en caliente — si el proceso se reinicia
// y la URL cambia, se auto-corrige sin tocar código ni redeploys.
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let tunnelProc: ChildProcess | null = null;
let currentTunnelUrl = '';

async function registerTunnelUrl(url: string) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/agent/register-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(AGENT_KEY ? { 'x-agent-key': AGENT_KEY } : {}) },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) console.log(`[Tunnel] ✅ URL registrada en el backend: ${url}`);
    else console.warn(`[Tunnel] ⚠️ Backend rechazó el registro (${res.status})`);
  } catch (e: any) {
    console.warn('[Tunnel] ⚠️ No se pudo registrar la URL en el backend:', e.message);
  }
}

function startQuickTunnel() {
  tunnelProc = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onOutput = (chunk: Buffer) => {
    const match = chunk.toString().match(TUNNEL_URL_REGEX);
    if (match && match[0] !== currentTunnelUrl) {
      currentTunnelUrl = match[0];
      console.log(`[Tunnel] 🌐 URL pública detectada: ${currentTunnelUrl}`);
      registerTunnelUrl(currentTunnelUrl);
    }
  };
  tunnelProc.stdout?.on('data', onOutput);
  tunnelProc.stderr?.on('data', onOutput); // cloudflared loguea por stderr

  tunnelProc.on('exit', (code) => {
    console.warn(`[Tunnel] cloudflared salió (código ${code}) — reintentando en 5s...`);
    currentTunnelUrl = '';
    setTimeout(startQuickTunnel, 5000);
  });
}

// Re-registrar cada 6h mientras el proceso vive, por si el TTL del backend expira
setInterval(() => { if (currentTunnelUrl) registerTunnelUrl(currentTunnelUrl); }, 6 * 60 * 60 * 1000);

// ─── Auto-sanación del túnel — el fallo real observado en producción: cloudflared
// puede quedar "vivo" (el proceso sigue corriendo, el evento 'exit' nunca dispara)
// pero SORDO (la sesión con el edge de Cloudflare se cae, típicamente tras
// suspender/reanudar el PC o cambiar de red) — nadie lo detecta desde adentro.
// Antes dependíamos 100% del watchdog EXTERNO (cada 2 min, mata y relanza todo
// el proceso). Este chequeo interno prueba el túnel cada 90s y, si no responde,
// mata cloudflared directamente — el handler 'exit' ya existente lo relanza en
// 5s con una URL nueva, sin esperar al ciclo completo del watchdog externo.
setInterval(async () => {
  if (!currentTunnelUrl || !tunnelProc) return;
  try {
    const res = await fetch(currentTunnelUrl, { signal: AbortSignal.timeout(8000) });
    if (res.status > 0) return; // cualquier respuesta HTTP (incluso 401) = túnel vivo
  } catch {
    console.warn(`[Tunnel] ⚠️ Auto-chequeo: ${currentTunnelUrl} no responde — matando cloudflared para forzar reinicio...`);
    tunnelProc.kill();
  }
}, 90 * 1000);

// Sin timeout en el servidor — los scans pueden tardar hasta 2 horas
server.timeout = 0;
server.keepAliveTimeout = 7_200_000; // 2 horas

server.listen(PORT, () => {
  startQuickTunnel();
  console.log(`
╔══════════════════════════════════════════╗
║        ZELVA Agent — Servidor Local      ║
║  Puerto: ${PORT}                              ║
║  Estado: ONLINE ✅                        ║
╚══════════════════════════════════════════╝

Esperando solicitudes de ZALVAJE...
• ZALVAJE detecta automáticamente el agente cuando está corriendo.
• Haz clic en "Escanear" en la UI para disparar un scan.
• Para escanear directamente: curl -X POST http://localhost:${PORT}/scan -d '{"keyword":"WOM Colombia"}'

Ctrl+C para detener.
`);
});

server.on('error', (e: any) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} ya está en uso. Cambia AGENT_PORT en .env o detén el proceso existente.`);
  } else {
    console.error('Error del servidor:', e.message);
  }
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nDeteniendo agente...');
  tunnelProc?.removeAllListeners('exit');
  tunnelProc?.kill();
  await closeBrowser();
  server.close();
  process.exit(0);
});
