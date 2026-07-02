/**
 * ZELVA Agent — Scraper local sin APIs
 * Uso: npx tsx scan.ts "Providencia Ron"
 *      npx tsx scan.ts "WOM Colombia" --headless=false
 */
import 'dotenv/config';
import { scrapeYouTube } from './src/sources/youtube.js';
import { scrapeReddit } from './src/sources/reddit.js';
import { scrapeNews } from './src/sources/news.js';
import { scrapeTwitter } from './src/sources/twitter.js';
import { scrapeInstagram } from './src/sources/instagram.js';
import { scrapeTikTok } from './src/sources/tiktok.js';
import { scrapeFacebook } from './src/sources/facebook.js';
import { closeBrowser } from './src/browser.js';
import type { Mention, Comment, Etiquetado, Alert, ScanPayload } from './src/types.js';
import fs from 'fs';
import path from 'path';

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const keyword = args.find(a => !a.startsWith('--'))?.trim();

if (!keyword) {
  console.error('Uso: npx tsx scan.ts "keyword a buscar"');
  process.exit(1);
}

if (args.includes('--headless=false')) process.env.HEADLESS = 'false';

const BACKEND_URL = (process.env.ZALVAJE_BACKEND || 'http://localhost:3001').replace(/\/$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';

// ─── Sentiment simple (sin IA) ─────────────────────────────────────────────────
const POSITIVE_WORDS = ['excelente', 'bueno', 'increíble', 'amor', 'feliz', 'perfecto', 'maravilloso', 'genial', 'recomiendo', 'satisfecho', 'mejor', 'encanta', 'único', 'delicioso', 'top'];
const NEGATIVE_WORDS = ['malo', 'terrible', 'horrible', 'odio', 'pésimo', 'decepcionante', 'basura', 'fraude', 'estafa', 'nunca', 'peor', 'desastre', 'asco', 'roban', 'caro', 'deficiente'];

function simpleSentiment(text: string): { label: 'positivo' | 'negativo' | 'neutro'; score: number } {
  const t = text.toLowerCase();
  const pos = POSITIVE_WORDS.filter(w => t.includes(w)).length;
  const neg = NEGATIVE_WORDS.filter(w => t.includes(w)).length;
  if (pos > neg) return { label: 'positivo', score: 0.6 };
  if (neg > pos) return { label: 'negativo', score: -0.6 };
  return { label: 'neutro', score: 0 };
}

function applySentiment(items: (Mention | Comment)[]): void {
  for (const item of items) {
    const s = simpleSentiment(item.text);
    (item as any).sentiment = s.label;
    (item as any).sentiment_score = s.score;
  }
}

// ─── Alertas ──────────────────────────────────────────────────────────────────
function buildAlerts(keyword: string, mentions: Mention[], comments: Comment[], avgScore: number): Alert[] {
  const alerts: Alert[] = [];

  if (avgScore < -0.4 && mentions.length > 3) {
    alerts.push({ level: 'critical', tipo: 'crisis_sentimiento', mensaje: `Crisis de reputación detectada para "${keyword}". Alto volumen de sentimiento negativo.` });
  } else if (avgScore < -0.2) {
    alerts.push({ level: 'warning', tipo: 'sentimiento_negativo', mensaje: `Tendencia negativa detectada para "${keyword}".` });
  }

  if (mentions.length > 40) {
    alerts.push({ level: 'warning', tipo: 'spike_menciones', mensaje: `Alto volumen: ${mentions.length} menciones. Posible tendencia viral.` });
  }

  const negativeNews = mentions.filter(m => m.platform === 'noticias' && (m as any).sentiment === 'negativo');
  if (negativeNews.length >= 2) {
    alerts.push({ level: 'warning', tipo: 'cobertura_negativa', mensaje: `${negativeNews.length} artículos de noticias con tono negativo.`, plataforma: 'noticias', url: negativeNews[0]?.url });
  }

  return alerts;
}

// ─── Extraer keywords ─────────────────────────────────────────────────────────
function extractKeywords(items: (Mention | Comment)[], keyword: string): string[] {
  const stopwords = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'que', 'es', 'un', 'una', 'los', 'las', 'del', 'con', 'por', 'para', 'se', 'no', 'al', 'más', 'como', 'lo', 'su', 'ya', 'pero']);
  const kwParts = keyword.toLowerCase().split(/\s+/);
  const text = items.map(i => i.text).join(' ').toLowerCase();
  const words = text.match(/\b[a-záéíóúñü]{4,}\b/g) || [];
  const freq: Record<string, number> = {};
  for (const w of words) {
    if (!stopwords.has(w) && !kwParts.some(p => w.includes(p))) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w);
}

// ─── Postear al backend ───────────────────────────────────────────────────────
async function postToBackend(payload: ScanPayload): Promise<void> {
  const url = `${BACKEND_URL}/api/agent/scan-result`;
  console.log(`\n[Post] Enviando a ${url}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGENT_KEY ? { 'x-agent-key': AGENT_KEY } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json();
  if (data.success) {
    console.log(`✅ Datos enviados al backend. Keyword: "${data.keyword}", menciones: ${payload.totalMentions}`);
  } else {
    console.error('❌ Error del backend:', data.error);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 ZELVA Agent — Escaneando: "${keyword}"`);
  console.log('='.repeat(50));
  const startTime = Date.now();

  // Correr fuentes en paralelo (4 a la vez)
  const [ytResult, redditResult, newsResult, twResult, igResult, ttResult, fbResult] = await Promise.allSettled([
    scrapeYouTube(keyword),
    scrapeReddit(keyword),
    scrapeNews(keyword),
    scrapeTwitter(keyword),
    scrapeInstagram(keyword),
    scrapeTikTok(keyword),
    scrapeFacebook(keyword),
  ]);

  // Agregar resultados
  const allMentions: Mention[] = [];
  const allComments: Comment[] = [];
  const allEtiquetados: Etiquetado[] = [];
  const platforms: Record<string, { mentions: number; comments: number; etiquetados: number }> = {};

  const add = (
    platform: string,
    res: PromiseSettledResult<{ mentions: Mention[]; comments: Comment[]; etiquetados?: Etiquetado[] }>
  ) => {
    if (res.status === 'rejected') { console.warn(`[${platform}] Falló:`, res.reason?.message?.slice(0, 80)); return; }
    const { mentions, comments, etiquetados = [] } = res.value;
    allMentions.push(...mentions);
    allComments.push(...comments);
    allEtiquetados.push(...etiquetados);
    platforms[platform] = { mentions: mentions.length, comments: comments.length, etiquetados: etiquetados.length };
  };

  add('youtube',   ytResult     as any);
  add('reddit',    redditResult as any);
  add('noticias',  newsResult   as any);
  add('twitter',   twResult     as any);
  add('instagram', igResult     as any);
  add('tiktok',    ttResult     as any);
  add('facebook',  fbResult     as any);

  // Aplicar sentimiento
  applySentiment(allMentions);
  applySentiment(allComments);

  // Calcular sentimiento promedio
  const scores = [...allMentions, ...allComments].map(i => (i as any).sentiment_score || 0);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const sentimentLabel: 'positivo' | 'negativo' | 'neutro' = avgScore > 0.1 ? 'positivo' : avgScore < -0.1 ? 'negativo' : 'neutro';

  // Influencers (likes altos)
  const influencers = [...allMentions]
    .filter(m => (m.likes || 0) >= 50)
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, 10);

  const alerts = buildAlerts(keyword, allMentions, allComments, avgScore);
  const keywords = extractKeywords([...allMentions, ...allComments], keyword);

  // Resumen
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log(`Escaneo completado en ${elapsed}s`);
  console.log(`Menciones: ${allMentions.length} | Comentarios: ${allComments.length} | Etiquetados: ${allEtiquetados.length}`);
  console.log(`Sentimiento: ${sentimentLabel} (${avgScore.toFixed(2)})`);
  if (alerts.length > 0) console.log(`Alertas: ${alerts.map(a => `[${a.level}] ${a.tipo}`).join(', ')}`);

  const payload: ScanPayload = {
    keyword,
    brand: keyword,
    scannedAt: new Date().toISOString(),
    totalMentions: allMentions.length,
    platforms,
    sentiment: parseFloat(avgScore.toFixed(4)),
    sentimentLabel,
    topMentions: allMentions.slice(0, 30),
    comments: allComments.slice(0, 120),
    etiquetados: allEtiquetados.slice(0, 60),
    influencers,
    alerts,
    summary: `Escaneo local de "${keyword}": ${allMentions.length} menciones en ${Object.keys(platforms).join(', ')}. Sentimiento ${sentimentLabel}.`,
    keywords,
  };

  // Guardar backup local
  const backupDir = path.join(process.cwd(), 'results');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  const backupFile = path.join(backupDir, `${keyword.replace(/\s+/g, '_')}_${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2));
  console.log(`\n💾 Backup guardado: ${backupFile}`);

  // Enviar al backend
  try {
    await postToBackend(payload);
  } catch (e: any) {
    console.error('❌ No se pudo enviar al backend:', e.message);
    console.log('Los datos están guardados localmente en:', backupFile);
  }

  await closeBrowser();
  console.log('\n✅ Agente finalizado.\n');
}

main().catch(async (e) => {
  console.error('Error fatal:', e);
  await closeBrowser();
  process.exit(1);
});
