/**
 * Setup de autenticación — corre una sola vez para guardar sesiones
 * Uso: npm run setup
 * Abre el browser visible para que puedas iniciar sesión manualmente.
 * Guarda las sesiones en auth/twitter.json, auth/instagram.json, auth/tiktok.json, auth/facebook.json
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function setupPlatform(name: string, url: string, authPath: string, instructions?: string) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Setup: ${name}`);
  console.log('='.repeat(50));
  if (instructions) console.log(instructions);
  console.log(`\nAbriendo el navegador en: ${url}`);
  console.log('Inicia sesion manualmente, luego vuelve aqui y presiona ENTER.');

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1280,900', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'es-CO',
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    (window as any).chrome = { runtime: {} };
  });

  const page = await ctx.newPage();
  await page.goto(url);

  await ask(`\nCuando hayas iniciado sesion en ${name} correctamente, presiona ENTER...`);

  await ctx.storageState({ path: authPath });
  console.log(`✅ Sesion de ${name} guardada en: ${authPath}`);

  await browser.close();
}

async function main() {
  console.log('\nZELVA Agent — Setup de autenticacion');
  console.log('=====================================');
  console.log('Plataformas disponibles: twitter, instagram, tiktok, facebook, linkedin, threads, todas');

  const platform = await ask('\n¿Que plataforma configurar? (twitter/instagram/tiktok/facebook/linkedin/threads/todas): ');

  const platforms: { key: string; name: string; url: string; note?: string }[] = [
    {
      key: 'twitter',
      name: 'Twitter / X',
      url: 'https://twitter.com/login',
      note: 'Inicia sesion con tu usuario y contrasena de Twitter/X.',
    },
    {
      key: 'instagram',
      name: 'Instagram',
      url: 'https://www.instagram.com/accounts/login/',
      note: 'Inicia sesion con tu usuario y contrasena de Instagram.',
    },
    {
      key: 'tiktok',
      name: 'TikTok',
      url: 'https://www.tiktok.com/login',
      note: 'Inicia sesion con tu usuario y contrasena de TikTok (o con Google/Apple).',
    },
    {
      key: 'facebook',
      name: 'Facebook',
      url: 'https://www.facebook.com/login',
      note: 'Inicia sesion con tu usuario y contrasena de Facebook.',
    },
    {
      key: 'linkedin',
      name: 'LinkedIn',
      url: 'https://www.linkedin.com/login',
      note: 'Inicia sesion con tu email y contrasena de LinkedIn. Espera a ver el feed antes de presionar ENTER.',
    },
    {
      key: 'threads',
      name: 'Threads',
      url: 'https://www.threads.net/login',
      note: 'Inicia sesion con tu cuenta de Instagram. Acepta los terminos si te los piden antes de presionar ENTER.',
    },
  ];

  const toSetup = platform === 'todas'
    ? platforms
    : platforms.filter(p => p.key === platform);

  if (toSetup.length === 0) {
    console.error('Plataforma no reconocida. Usa: twitter, instagram, tiktok, facebook, linkedin, threads o todas');
    process.exit(1);
  }

  for (const p of toSetup) {
    await setupPlatform(
      p.name,
      p.url,
      path.join(AUTH_DIR, `${p.key}.json`),
      p.note,
    );
  }

  console.log('\n✅ Setup completo.');
  console.log('Ahora puedes correr el agente con: npm start');
  console.log('O un escaneo directo con: npm run scan "keyword"');
}

main().catch(console.error);
