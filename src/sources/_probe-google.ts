import { writeFileSync, mkdirSync } from 'fs';
import { scrapeGoogleAds } from './adsGoogle.js';
import { closeBrowser } from '../browser.js';

const OUT = 'pruebas-ads';
mkdirSync(OUT, { recursive: true });

// marca:dominioEsperado
const objetivos = (process.argv[2] || 'ETB:etb.com').split(',');

try {
    for (const o of objetivos) {
        const [marca, dominio] = o.split(':');
        const r = await scrapeGoogleAds(marca.trim(), { maxAnuncios: 20, dominioEsperado: dominio?.trim() });
        console.log(`\n══════════ GOOGLE · "${marca}" ══════════`);
        r.diagnostico.forEach(d => console.log(`  · ${d}`));
        console.log(`\n  SUGERENCIAS:`);
        r.sugerencias.forEach(s => console.log(`    ${s.elegida ? '>>>' : '   '} ${s.texto}${s.motivo ? `   (${s.motivo})` : ''}`));
        console.log(`\n  ANUNCIOS: ${r.total}`);
        r.anuncios.forEach((a, i) => {
            console.log(`   [${i + 1}] ${a.adId} · ${a.formato} · conf=${a.confianza} · captura=${a.imagenB64 ? `SI ${Math.round(a.imagenB64.length / 1365)}KB` : 'NO'}`);
            if (a.imagenB64) {
                const f = `${OUT}/GOOGLE_${marca.replace(/\W/g, '_')}_${a.adId}.jpg`;
                writeFileSync(f, Buffer.from(a.imagenB64.split(',')[1], 'base64'));
                console.log(`       ${f}`);
            }
        });
    }
} finally {
    await closeBrowser();
}
