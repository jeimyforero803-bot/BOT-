/**
 * Google Ads Transparency Center — scraper web (no hay API pública).
 *
 * IDENTIFICACIÓN DE MARCA — por DOMINIO, no por nombre:
 *   Buscar "ETB" en el autocompletado devuelve, en este orden real:
 *     1. "اي تي بي تورز- ETB Tours"  (Egipto)   ← primera sugerencia
 *     2. etb.co
 *     3. etb.com                                ← la correcta
 *     4. jetbus.co, petbus.cl, jetblue.com      ← ruido por subcadena
 *   Tomar la primera sugerencia trae una agencia de viajes egipcia. Por eso
 *   este scraper prefiere SIEMPRE la sugerencia que sea un dominio y que
 *   coincida con el dominio esperado de la marca. El nombre visible es el
 *   último recurso.
 *
 * ESTRUCTURA DEL DOM (verificada):
 *   - <creative-preview> por anuncio, con <a href="/advertiser/AR.../creative/CR...?region=CO">
 *   - la creatividad se renderiza dentro de <html-renderer> / iframe, así que
 *     la imagen NO es un <img> con src usable → hay que capturar.
 *   - la URL del anunciante queda como /advertiser/AR<id>?region=CO
 */
import type { Page } from 'playwright';
import { getContext, humanDelay, delay } from '../browser.js';

export interface AnuncioGoogle {
    plataforma: 'google';
    adId: string;
    anunciante: string;
    anuncianteId: string;
    dominio: string;
    marcaConsultada: string;
    confianza: 'exacta' | 'alta' | 'media' | 'baja';
    formato: string;
    enlace: string;
    imagenB64?: string;
}

export interface ResultadoGoogle {
    marca: string;
    total: number;
    anuncios: AnuncioGoogle[];
    sugerencias: Array<{ texto: string; elegida: boolean; motivo: string }>;
    anuncianteElegido: string;
    urlConsultada: string;
    diagnostico: string[];
}

function norm(s: string): string {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ¿La sugerencia es un dominio (tiene punto y sin espacios)? */
const esDominio = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim());

/**
 * Elige la mejor sugerencia del autocompletado.
 * Orden de preferencia, de más a menos confiable:
 *   1. dominio exacto pedido por el llamador (dominioEsperado)
 *   2. dominio cuyo label (antes del primer punto) es exactamente la marca
 *   3. dominio que empieza con la marca
 *   4. nombre que contiene la marca como palabra completa y NO menciona otro país
 */
function elegirSugerencia(
    sugerencias: string[], marca: string, dominioEsperado?: string,
): { indice: number; motivo: string; confianza: AnuncioGoogle['confianza'] } {
    const m = norm(marca);
    const dom = dominioEsperado ? norm(dominioEsperado) : '';

    if (dom) {
        const i = sugerencias.findIndex(s => norm(s) === dom);
        if (i >= 0) return { indice: i, motivo: `dominio esperado "${dominioEsperado}"`, confianza: 'exacta' };
    }
    let i = sugerencias.findIndex(s => esDominio(s) && norm(s).split('.')[0] === m);
    if (i >= 0) return { indice: i, motivo: `dominio con label exacto "${sugerencias[i]}"`, confianza: 'exacta' };

    i = sugerencias.findIndex(s => esDominio(s) && norm(s).startsWith(m));
    if (i >= 0) return { indice: i, motivo: `dominio que empieza con la marca "${sugerencias[i]}"`, confianza: 'alta' };

    const PAISES = ['egipto', 'espana', 'argentina', 'mexico', 'chile', 'peru', 'brasil', 'egypt'];
    i = sugerencias.findIndex(s => {
        const n = norm(s);
        if (PAISES.some(p => n.includes(p))) return false;
        return n.split(' ').includes(m);
    });
    if (i >= 0) return { indice: i, motivo: `nombre con la marca como palabra completa`, confianza: 'media' };

    return { indice: -1, motivo: 'ninguna sugerencia confiable', confianza: 'baja' };
}

export async function scrapeGoogleAds(
    marca: string,
    opciones: { region?: string; maxAnuncios?: number; dominioEsperado?: string } = {},
): Promise<ResultadoGoogle> {
    const { region = 'CO', maxAnuncios = 20, dominioEsperado } = opciones;
    const diag: string[] = [];
    const url = `https://adstransparency.google.com/?region=${region}`;
    const ctx = await getContext('google');
    const page = await ctx.newPage();

    const anuncios: AnuncioGoogle[] = [];
    let sugerenciasOut: ResultadoGoogle['sugerencias'] = [];
    let anuncianteElegido = '';
    let confianza: AnuncioGoogle['confianza'] = 'baja';

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay(2500, 4000);

        const input = page.locator('input').first();
        await input.click({ timeout: 15000 });
        await input.fill(marca);
        await delay(2800);

        const textos = await page.evaluate(() =>
            [...document.querySelectorAll('material-select-item, [role="option"]')]
                .map(e => (e as HTMLElement).innerText?.trim() || '')
                .filter(Boolean));

        if (!textos.length) { diag.push('el autocompletado no devolvió sugerencias'); throw new Error('sin sugerencias'); }

        // El label del anunciante puede traer varias líneas (nombre / Verificado
        // / país / "~12 anuncios"): para comparar usamos solo la primera.
        const primeras = textos.map(t => t.split('\n')[0].trim());
        const elec = elegirSugerencia(primeras, marca, dominioEsperado);
        confianza = elec.confianza;

        sugerenciasOut = primeras.map((t, i) => ({
            texto: t,
            elegida: i === elec.indice,
            motivo: i === elec.indice ? elec.motivo : '',
        }));
        diag.push(`sugerencias: ${primeras.length} · elegida: ${elec.indice >= 0 ? `"${primeras[elec.indice]}" (${elec.motivo})` : 'NINGUNA'}`);

        if (elec.indice < 0) throw new Error('ninguna sugerencia confiable — no se consulta para no traer otra marca');

        anuncianteElegido = primeras[elec.indice];
        await page.locator('material-select-item, [role="option"]').nth(elec.indice).click({ timeout: 15000 });
        await delay(4500);

        const urlAnunciante = page.url();
        const anuncianteId = (urlAnunciante.match(/\/advertiser\/(AR[\w-]+)/) || [])[1] || '';
        diag.push(`anunciante: ${anuncianteId} · ${urlAnunciante}`);

        // Cuánto hay en total, para saber cuánto nos estamos perdiendo.
        try {
            const t = await page.locator('text=/~?\\s*[\\d.,]+\\s+anuncios?/i').first().textContent({ timeout: 8000 });
            diag.push(`el anunciante declara: ${t?.trim()}`);
        } catch { /* sin contador */ }

        /**
         * Google usa <material-button>, no <button> ni <a>. Buscar por esas dos
         * etiquetas no encontraba nada y se capturaban 4 creatividades de ~400.
         * Se busca por texto en CUALQUIER elemento clicable.
         */
        const clicarPorTexto = async (textos: string[]): Promise<string | null> => {
            for (const t of textos) {
                try {
                    const b = page.locator(
                        `material-button:has-text("${t}"), [role="button"]:has-text("${t}"), button:has-text("${t}"), a:has-text("${t}")`
                    ).first();
                    if (await b.isVisible({ timeout: 2000 })) {
                        await b.click({ timeout: 6000 });
                        return t;
                    }
                } catch { /* probar el siguiente */ }
            }
            return null;
        };

        // "See all ads" abre la ficha completa del anunciante.
        const verTodos = await clicarPorTexto(['See all ads', 'Ver todos los anuncios', 'Ver todo', 'See all']);
        if (verTodos) { diag.push(`clic en "${verTodos}"`); await delay(4500); }

        // Scroll con carga progresiva + "Ver más resultados". Se corta cuando
        // deja de aparecer contenido nuevo, en vez de un número fijo de pasadas.
        let previos = 0, sinCambio = 0;
        for (let i = 0; i < 25; i++) {
            await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
            await delay(1800);

            const mas = await clicarPorTexto(['Ver más resultados', 'View more results', 'Cargar más', 'Load more', 'Show more']);
            if (mas) await delay(3000);

            const n = await page.evaluate(() => document.querySelectorAll('creative-preview').length);
            if (n === previos) {
                if (++sinCambio >= 3) { diag.push(`saturado en ${n} creatividades (pasada ${i + 1})`); break; }
            } else { sinCambio = 0; }
            previos = n;
            if (n >= maxAnuncios * 2) { diag.push(`suficientes (${n}) para el tope pedido`); break; }
        }

        const crudos = await page.evaluate(() => {
            const out: any[] = [];
            document.querySelectorAll('creative-preview').forEach((el, i) => {
                const a = el.querySelector('a');
                const href = a?.getAttribute('href') || '';
                const id = (href.match(/\/creative\/(CR[\w-]+)/) || [])[1] || `idx_${i}`;
                el.setAttribute('data-zelva-gad', id);
                out.push({
                    adId: id,
                    href,
                    texto: (el as HTMLElement).innerText?.trim().slice(0, 200) || '',
                    // El formato se infiere del renderer: video vs imagen vs texto.
                    formato: el.querySelector('video') ? 'video'
                        : el.querySelector('img') ? 'imagen'
                        : el.querySelector('iframe, html-renderer') ? 'html'
                        : 'desconocido',
                });
            });
            return out;
        });
        diag.push(`creative-preview encontrados: ${crudos.length}`);

        // Volver al tope: tras cargar ~160 creatividades la página queda al
        // final y las primeras tienen el <html-renderer> sin pintar todavía.
        await page.evaluate(() => window.scrollTo({ top: 0 }));
        await delay(1500);

        for (const c of crudos.slice(0, maxAnuncios)) {
            let imagenB64: string | undefined;
            try {
                const nodo = page.locator(`[data-zelva-gad="${c.adId}"]`).first();
                await nodo.scrollIntoViewIfNeeded({ timeout: 8000 });
                await page.evaluate(() => window.scrollBy({ top: -120 }));
                await nodo.evaluate((el: Element) => Promise.all(
                    [...el.querySelectorAll('img')]
                        .filter(i => !(i as HTMLImageElement).complete)
                        .map(i => new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); setTimeout(r, 2500); }))
                )).catch(() => {});
                await delay(600); // el renderer del creativo tarda en pintar
                const buf = await nodo.screenshot({ type: 'jpeg', quality: 72, timeout: 15000 });
                imagenB64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
            } catch { /* sigue sin captura */ }

            anuncios.push({
                plataforma: 'google',
                adId: c.adId,
                anunciante: anuncianteElegido,
                anuncianteId,
                dominio: esDominio(anuncianteElegido) ? anuncianteElegido : '',
                marcaConsultada: marca,
                confianza,
                formato: c.formato,
                enlace: c.href ? `https://adstransparency.google.com${c.href}` : urlAnunciante,
                imagenB64,
            });
        }
        diag.push(`capturas: ${anuncios.filter(a => a.imagenB64).length}/${anuncios.length}`);
    } catch (e: any) {
        diag.push(`ERROR: ${e.message}`);
    } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }

    return { marca, total: anuncios.length, anuncios, sugerencias: sugerenciasOut, anuncianteElegido, urlConsultada: url, diagnostico: diag };
}
