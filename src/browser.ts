import { chromium, type Browser, type BrowserContext } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');
export const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

export function getAuthPath(platform: string): string {
  return path.join(AUTH_DIR, `${platform}.json`);
}

export function hasAuth(platform: string): boolean {
  return fs.existsSync(getAuthPath(platform));
}

export function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    const headless = process.env.HEADLESS !== 'false';
    _browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1366,768',
      ],
    });
  }
  return _browser;
}

export async function getContext(platform?: string): Promise<BrowserContext> {
  const browser = await getBrowser();
  const authPath = platform ? getAuthPath(platform) : null;

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    storageState: (authPath && hasAuth(platform!)) ? authPath : undefined,
    extraHTTPHeaders: {
      'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
    },
  });

  // Evadir detección como bot
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-CO', 'es', 'en'] });
    (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  });

  return ctx;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

/** Delay fijo en ms */
export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Delay aleatorio entre min y max ms — más humano */
export function humanDelay(min = 1500, max = 4000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}

/** Scroll gradual simulando lectura humana */
export async function humanScroll(page: any, steps = 5): Promise<void> {
  for (let i = 0; i < steps; i++) {
    const amount = Math.floor(Math.random() * 450 + 250);
    await page.evaluate((y: number) => window.scrollBy({ top: y, behavior: 'smooth' }), amount);
    await delay(Math.floor(Math.random() * 1200 + 600));
  }
}

/** Toma captura de un elemento y devuelve data URL base64 (compatible con HTTPS) */
export async function takeScreenshot(element: any, prefix: string): Promise<string | undefined> {
  try {
    ensureScreenshotsDir();
    const fname = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const fpath = path.join(SCREENSHOTS_DIR, fname);
    const buffer = await element.screenshot({ path: fpath, type: 'png' });
    // Devolver base64 data URL — evita bloqueo mixed-content al servirla en el dashboard (HTTPS)
    const b64 = (buffer instanceof Buffer ? buffer : fs.readFileSync(fpath)).toString('base64');
    return `data:image/png;base64,${b64}`;
  } catch {
    return undefined;
  }
}

/**
 * Scroll agresivo hasta el fondo para activar lazy loading de comentarios.
 * Hace múltiples pasadas con pausa entre cada una.
 */
export async function scrollToLoadComments(page: any, passes = 4): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await delay(1800);
    await page.evaluate(() => window.scrollBy({ top: -300, behavior: 'smooth' }));
    await delay(600);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await delay(1200);
  }
}

/**
 * Espera hasta que el selector aparezca Y tenga al menos `minCount` elementos.
 * Reintenta cada segundo, hasta `timeoutMs`.
 */
export async function waitForComments(
  page: any,
  selector: string,
  minCount = 1,
  timeoutMs = 40000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count: number = await page.evaluate(
      (sel: string) => document.querySelectorAll(sel).length,
      selector
    );
    if (count >= minCount) return true;
    await delay(1200);
  }
  return false;
}

/**
 * Convierte fechas relativas de redes sociales a ISO string.
 * Ej: "hace 2 días", "3h", "2d", "June 25", "2025-06-25T10:00:00Z"
 */
export function parseRelativeDate(raw: string): string {
  if (!raw) return new Date().toISOString();
  const s = raw.trim().toLowerCase();

  // Ya es ISO
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;

  const now = Date.now();

  // Normalizar "un/una" → "1" para español
  const norm = s.replace(/\bun[ao]?\b/g, '1');

  // Español: "hace X minutos/horas/días/semanas/meses"
  const mSec  = norm.match(/hace\s+(\d+)\s+seg/);          if (mSec)   return new Date(now - +mSec[1] * 1000).toISOString();
  const mMin  = norm.match(/hace\s+(\d+)\s+min/);          if (mMin)   return new Date(now - +mMin[1] * 60000).toISOString();
  const mHour = norm.match(/hace\s+(\d+)\s+hora/);         if (mHour)  return new Date(now - +mHour[1] * 3600000).toISOString();
  const mDay  = norm.match(/hace\s+(\d+)\s+d[íi]a/);      if (mDay)   return new Date(now - +mDay[1] * 86400000).toISOString();
  const mWeek = norm.match(/hace\s+(\d+)\s+sem/);          if (mWeek)  return new Date(now - +mWeek[1] * 604800000).toISOString();
  const mMonth= norm.match(/hace\s+(\d+)\s+mes/);          if (mMonth) return new Date(now - +mMonth[1] * 2592000000).toISOString();
  const mYear = norm.match(/hace\s+(\d+)\s+a[ñn]/);        if (mYear)  return new Date(now - +mYear[1] * 31536000000).toISOString();

  // Inglés CON "ago": "3 hours ago", "2 days ago"
  const eSec  = norm.match(/(\d+)\s+sec.*ago/);    if (eSec)   return new Date(now - +eSec[1] * 1000).toISOString();
  const eMin  = norm.match(/(\d+)\s+min.*ago/);    if (eMin)   return new Date(now - +eMin[1] * 60000).toISOString();
  const eHour = norm.match(/(\d+)\s+hour.*ago/);   if (eHour)  return new Date(now - +eHour[1] * 3600000).toISOString();
  const eDay  = norm.match(/(\d+)\s+day.*ago/);    if (eDay)   return new Date(now - +eDay[1] * 86400000).toISOString();
  const eWeek = norm.match(/(\d+)\s+week.*ago/);   if (eWeek)  return new Date(now - +eWeek[1] * 604800000).toISOString();
  const eMon  = norm.match(/(\d+)\s+month.*ago/);  if (eMon)   return new Date(now - +eMon[1] * 2592000000).toISOString();
  const eYear = norm.match(/(\d+)\s+year.*ago/);   if (eYear)  return new Date(now - +eYear[1] * 31536000000).toISOString();

  // Inglés SIN "ago": "3 hours", "2 days", "1 week" (YouTube headless a veces omite "ago")
  const eHourB = norm.match(/^(\d+)\s+hours?$/);   if (eHourB) return new Date(now - +eHourB[1] * 3600000).toISOString();
  const eDayB  = norm.match(/^(\d+)\s+days?$/);    if (eDayB)  return new Date(now - +eDayB[1] * 86400000).toISOString();
  const eWeekB = norm.match(/^(\d+)\s+weeks?$/);   if (eWeekB) return new Date(now - +eWeekB[1] * 604800000).toISOString();
  const eMonB  = norm.match(/^(\d+)\s+months?$/);  if (eMonB)  return new Date(now - +eMonB[1] * 2592000000).toISOString();
  const eYearB = norm.match(/^(\d+)\s+years?$/);   if (eYearB) return new Date(now - +eYearB[1] * 31536000000).toISOString();

  // Cortos: "2h", "3d", "1w", "5m", "30s"
  const short = s.match(/^(\d+)([smhdw])$/);
  if (short) {
    const map: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    return new Date(now - +short[1] * (map[short[2]] || 0)).toISOString();
  }

  // "Edited X hours ago" / "Edited X days ago" — ignorar prefijo
  const edited = norm.match(/edited\s+(\d+)\s+(hour|day|week|month)/);
  if (edited) {
    const maps: Record<string, number> = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
    return new Date(now - +edited[1] * (maps[edited[2]] || 86400000)).toISOString();
  }

  // Timestamp Unix numérico (10 dígitos = segundos)
  if (/^\d{10}$/.test(raw.trim())) return new Date(+raw.trim() * 1000).toISOString();

  // Fecha parcial "Jun 25", "25 jun", "25/06", "25-06-2025"
  const partialDate = new Date(raw);
  if (!isNaN(partialDate.getTime())) {
    // Sanity check: no aceptar fechas futuras ni muy antiguas (> 2 años)
    const t = partialDate.getTime();
    if (t <= now && t >= now - 2 * 365 * 86400000) return partialDate.toISOString();
  }

  // Fallback seguro: asumir hoy
  return new Date().toISOString();
}

/**
 * Devuelve true si la fecha está dentro de los últimos `days` días.
 *
 * `referenceNow` por defecto es Date.now(), correcto para fechas RELATIVAS
 * ("hace 2 días") porque parseRelativeDate ya las ancló al mismo reloj.
 * Para fechas ABSOLUTAS leídas de un sitio externo (datetime="2026-01-15..."),
 * pasar un `referenceNow` calculado con getBatchReferenceNow() sobre el lote
 * scrapeado — si el reloj de esta máquina está desincronizado del real, comparar
 * contra Date.now() descarta TODO el contenido real como "viejo" y no encuentra nada.
 */
export function isRecent(isoDate: string, days = 45, referenceNow: number = Date.now()): boolean {
  try {
    const cutoff = referenceNow - days * 86400000;
    return new Date(isoDate).getTime() >= cutoff;
  } catch {
    return true;
  }
}

/**
 * Calcula un "ahora" de referencia a partir de la fecha más reciente presente
 * en un lote de fechas absolutas ya scrapeadas, para que isRecent() no dependa
 * del reloj (posiblemente desincronizado) de esta máquina. Cae a Date.now()
 * si no hay ninguna fecha válida en el lote.
 */
export function getBatchReferenceNow(isoDates: (string | undefined | null)[]): number {
  let max = -Infinity;
  for (const d of isoDates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (!isNaN(t) && t > max) max = t;
  }
  return max > -Infinity ? max : Date.now();
}

/**
 * Reconstruye la frase completa de la marca a partir de `keyword` (el término
 * "base" que ya puede venir recortado si el usuario escribió la marca como
 * varios pills sueltos) + `extraTerms`, y la devuelve entre comillas para que
 * el buscador del sitio la trate como frase exacta en vez de palabras sueltas
 * — así "Tarrito" + "Rojo" busca "Tarrito Rojo" y no cualquier cosa con "Tarrito".
 */
export function buildPreciseQuery(keyword: string, extraTerms: string[] = []): string {
  const plainExtras = extraTerms.filter(t =>
    !t.startsWith('@') && !t.startsWith('#') && t.toLowerCase() !== keyword.toLowerCase()
  );
  // Solo el keyword va entre comillas (frase exacta) cuando ya es multi-palabra
  // en sí mismo (ej. "Tiendas D1" escrito así por el usuario) — los extras NO
  // se pegan a esa frase. Antes se armaba TODO como una sola frase exacta
  // ("ETB Colombia"), lo que exige que alguien escriba esas palabras juntas y
  // seguidas — casi nadie lo hace, y la búsqueda no encontraba nada. Ahora los
  // extras van como palabras sueltas (AND: deben aparecer, no necesariamente
  // pegadas), que es lo que realmente sirve para desambiguar (ej. ETB + Colombia).
  const keywordPart = keyword.includes(' ') ? `"${keyword}"` : keyword;
  return [keywordPart, ...plainExtras].join(' ').trim();
}
