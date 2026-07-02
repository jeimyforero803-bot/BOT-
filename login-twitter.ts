/**
 * Ejecuta este script UNA SOLA VEZ para guardar tu sesion de X/Twitter.
 * Despues el agente la reutiliza automaticamente sin volver a pedir login.
 *
 * Uso: npx tsx login-twitter.ts
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth');
const AUTH_PATH = path.join(AUTH_DIR, 'twitter.json');

(async () => {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  console.log('Abriendo Chrome...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1366,768'],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await ctx.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('');
  console.log('-----------------------------------------');
  console.log('  Inicia sesion en X manualmente en la');
  console.log('  ventana que se abrio.');
  console.log('');
  console.log('  Cuando estes DENTRO de tu feed,');
  console.log('  regresa aqui y presiona ENTER.');
  console.log('-----------------------------------------');
  console.log('');

  await new Promise<void>(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  await ctx.storageState({ path: AUTH_PATH });
  console.log('Sesion guardada en: ' + AUTH_PATH);
  console.log('Ya puedes cerrar la ventana y correr el agente.');

  await browser.close();
  process.exit(0);
})();
