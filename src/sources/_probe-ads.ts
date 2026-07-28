// Prueba real de los scrapers de bibliotecas de anuncios.
// Uso: npx tsx src/sources/_probe-ads.ts meta ETB,Claro
import { writeFileSync, mkdirSync } from 'fs';
import { scrapeMetaAds } from './adsMeta.js';
import { closeBrowser } from '../browser.js';

const cual = (process.argv[2] || 'meta').toLowerCase();
const marcas = (process.argv[3] || 'ETB').split(',');
const OUT = 'pruebas-ads';
mkdirSync(OUT, { recursive: true });

try {
    for (const raw of marcas) {
        const marca = raw.trim();
        if (cual !== 'meta') continue;
        const r = await scrapeMetaAds(marca, { maxAnuncios: 5, minConfianza: 'media' });

        console.log(`\n══════════ META · "${marca}" ══════════`);
        r.diagnostico.forEach(d => console.log(`  · ${d}`));
        console.log(`\n  ANUNCIANTES (${r.anunciantesEncontrados.length}):`);
        r.anunciantesEncontrados.forEach(a =>
            console.log(`    ${a.aceptado ? '[OK]' : '[--]'} ${a.nombre.padEnd(30).slice(0, 30)} ${String(a.anuncios).padStart(3)}  ${a.confianza.padEnd(6)} ${a.paginaUrl}`));

        console.log(`\n  ACEPTADOS: ${r.total}`);
        let conImagen = 0;
        r.anuncios.forEach((a, i) => {
            const kb = a.imagenB64 ? Math.round(a.imagenB64.length / 1365) : 0;
            if (a.imagenB64) conImagen++;
            console.log(`   [${i + 1}] ${a.anunciante} · ${a.confianza} · ${a.titulo.slice(0, 55)}`);
            console.log(`       captura: ${a.imagenB64 ? `SI (~${kb} KB)` : 'NO'}   fbcdn: ${a.imagenUrl ? 'si (403 externo)' : 'no'}`);
            if (a.imagenB64) {
                const f = `${OUT}/${marca.replace(/\W/g, '_')}_${a.adId}.jpg`;
                writeFileSync(f, Buffer.from(a.imagenB64.split(',')[1], 'base64'));
                console.log(`       guardada: ${f}`);
            }
        });
        console.log(`\n  >>> ${marca}: ${conImagen}/${r.total} con captura usable`);
    }
} finally {
    await closeBrowser();
}
