/**
 * Meta Ad Library — scraper web (NO la Graph API).
 *
 * Por qué web y no API: `ads_archive` devolvió 0 anuncios en 3 de 4 marcas
 * colombianas grandes, no expone ningún campo de imagen, y mete el access_token
 * dentro de cada `ad_snapshot_url` — que además responde X-Frame-Options: DENY.
 * La web entrega la URL directa de la creatividad en fbcdn.
 *
 * ESTRUCTURA DEL DOM (verificada, no asumida):
 *   La línea "Identificador de la biblioteca: N" está enterrada; el contenedor
 *   real de la tarjeta es su ancestro de NIVEL 4 (~380 chars, 2 imgs, 2 links).
 *   El nivel 6 ya es la grilla completa (11 KB). Varios divs ancla caen dentro
 *   de la misma tarjeta, así que hay que deduplicar por Library ID.
 *
 * IDENTIFICACIÓN DE MARCA:
 *   En la Ad Library conviven páginas de nombre parecido (ETB / ETB Empresas /
 *   revendedores). Se usa el SLUG de la URL de la página además del nombre
 *   visible, porque el slug es mucho más estable. El scraper nunca decide en
 *   silencio: devuelve `anunciantesEncontrados` con todo lo visto y marca cada
 *   anuncio con su `confianza`.
 */
import type { Page } from 'playwright';
import { getContext, humanDelay, delay } from '../browser.js';

export interface AnuncioMeta {
    plataforma: 'meta';
    adId: string;
    anunciante: string;
    paginaUrl: string;
    marcaConsultada: string;
    confianza: 'exacta' | 'alta' | 'media' | 'baja';
    titulo: string;
    cuerpo: string;
    inicio: string;
    activo: boolean;
    versiones: number;
    /** URL en fbcdn. OJO: responde 403 desde fuera de Facebook (hotlink
     *  protegido), así que NO sirve para pintar la miniatura. Se guarda solo
     *  como referencia; lo que se muestra es `imagenB64`. */
    imagenUrl: string;
    /** Captura real de la tarjeta renderizada. Es la única imagen usable. */
    imagenB64?: string;
    landing: string;
    enlace: string;
}

export interface ResultadoMeta {
    marca: string;
    total: number;
    anuncios: AnuncioMeta[];
    anunciantesEncontrados: Array<{ nombre: string; paginaUrl: string; anuncios: number; confianza: string; aceptado: boolean }>;
    urlConsultada: string;
    diagnostico: string[];
}

function norm(s: string): string {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Países que NO son el mercado objetivo. Una página puede ser legítimamente de
 * la marca y aun así ser irrelevante: "Movistar Argentina" es Movistar, pero no
 * compite en Colombia. Verificado en pruebas: sin esto, "Movistar Arena España"
 * y "Movistar Argentina" pasaban con confianza alta.
 */
const OTROS_PAISES = [
    'espana', 'argentina', 'mexico', 'chile', 'peru', 'ecuador', 'venezuela',
    'uruguay', 'paraguay', 'bolivia', 'brasil', 'panama', 'costa rica',
    'guatemala', 'honduras', 'nicaragua', 'salvador', 'republica dominicana',
    'puerto rico', 'usa', 'united states', 'reino unido', 'alemania',
];

/**
 * Confianza del match. Mira nombre visible Y slug de la página: el slug es
 * evidencia más dura, porque el nombre visible Meta deja ponerlo libremente.
 *
 * Dos reglas nacidas de fallos reales en pruebas:
 *  - Coincidencia por PALABRA COMPLETA, nunca por subcadena: "WOM" matcheaba
 *    "Bible for Women" y entraba como competencia.
 *  - Marca de otro país descalifica: ver OTROS_PAISES.
 */
function evaluarConfianza(nombre: string, paginaUrl: string, marca: string): AnuncioMeta['confianza'] {
    const m = norm(marca);
    const n = norm(nombre);
    const slug = norm(decodeURIComponent(String(paginaUrl || '').split('/').filter(Boolean).pop() || ''));
    if (!m) return 'baja';

    // Otro mercado: aunque sea la marca, no es competencia local.
    if (OTROS_PAISES.some(p => n.includes(p) || slug.includes(p))) return 'baja';

    const palabrasN = n.split(' ');
    const palabrasSlug = slug.split(' ');
    const palabrasM = m.split(' ').filter(Boolean);

    // Igualdad total en nombre o slug.
    if (n === m || slug === m) return 'exacta';
    // El slug contiene la marca como palabra completa: "etb colombia" para "etb".
    if (palabrasSlug.includes(m)) return 'exacta';
    // El nombre arranca con la marca completa: "ETB Digital".
    if (palabrasN.length > palabrasM.length && palabrasN.slice(0, palabrasM.length).join(' ') === m) return 'alta';
    // Todas las palabras significativas de la marca están como palabra completa.
    const sig = palabrasM.filter(w => w.length > 2);
    if (sig.length && sig.every(w => palabrasN.includes(w))) return 'alta';
    // Aparece como palabra completa en algún lugar del nombre.
    if (palabrasN.includes(m)) return 'media';
    return 'baja';
}

const URL_BASE = 'https://www.facebook.com/ads/library/';

const construirUrl = (marca: string, pais: string, soloActivos: boolean) =>
    `${URL_BASE}?${new URLSearchParams({
        active_status: soloActivos ? 'active' : 'all',
        ad_type: 'all',
        country: pais,
        q: marca,
        search_type: 'keyword_unordered',
        media_type: 'all',
    })}`;

async function cerrarCookies(page: Page, diag: string[]): Promise<void> {
    for (const t of ['Permitir todas las cookies', 'Allow all cookies', 'Rechazar cookies opcionales']) {
        try {
            const b = page.locator(`button:has-text("${t}")`).first();
            if (await b.isVisible({ timeout: 2500 })) {
                await b.click({ timeout: 4000 });
                diag.push(`cookies cerradas ("${t}")`);
                await delay(1200);
                return;
            }
        } catch { /* siguiente */ }
    }
}

/**
 * Extrae las tarjetas visibles AHORA en el DOM.
 *
 * Se define aparte para poder invocarla en cada pasada de scroll: la Ad
 * Library virtualiza la grilla y desmonta lo que queda fuera de pantalla, así
 * que una única extracción al final solo ve el último tramo.
 */
const EXTRAER_TARJETAS = () => {
            const anclas = [...document.querySelectorAll('div')].filter(e =>
                /^Identificador de la biblioteca|^Library ID/i.test((e.textContent || '').trim())
                && (e.textContent || '').trim().length < 60);

            const porId = new Map<string, any>();

            for (const a of anclas) {
                // El contenedor real de la tarjeta está 4 niveles arriba.
                let el: HTMLElement | null = a as HTMLElement;
                for (let i = 0; i < 4 && el?.parentElement; i++) el = el.parentElement;
                if (!el) continue;

                const texto = (el.innerText || '').trim();
                const id = (texto.match(/(?:Identificador de la biblioteca|Library ID)\s*:?\s*(\d+)/i) || [])[1];
                if (!id) continue;

                const enlaces = [...el.querySelectorAll('a')] as HTMLAnchorElement[];
                const imgs = [...el.querySelectorAll('img')] as HTMLImageElement[];

                // Varias anclas caen en la misma tarjeta: nos quedamos con la
                // versión más completa (la que trae enlaces e imágenes).
                const previo = porId.get(id);
                if (previo && previo.enlaces >= enlaces.length) continue;

                // Marcamos el nodo para poder capturarlo con Playwright después:
                // page.evaluate no puede tomar screenshots, y los selectores de
                // Meta son ofuscados e inestables.
                el.setAttribute('data-zelva-ad', id);

                const linkPagina = enlaces.find(x => /facebook\.com\/[^/]+\/?$/.test(x.href) && !/ads\/library/.test(x.href));
                const linkDestino = enlaces.find(x => /l\.facebook\.com\/l\.php|https?:\/\/(?!.*facebook\.com)/.test(x.href));

                // img[0] suele ser el avatar de la página (alt = nombre);
                // la creatividad es la que NO tiene alt.
                const creatividad = imgs.find(x => !x.alt) || imgs[1] || imgs[0];

                const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean)
                    .filter(l => l !== '​' && !/^[​\s]*$/.test(l));

                const iPub = lineas.findIndex(l => /^Publicidad$|^Sponsored$/i.test(l));
                const nombrePagina = linkPagina?.textContent?.trim()
                    || (iPub > 0 ? lineas[iPub - 1] : '')
                    || imgs[0]?.alt || '';

                const contenido = iPub >= 0 ? lineas.slice(iPub + 1) : lineas.slice(6);
                const utiles = contenido.filter(l =>
                    !/^(Learn More|Más información|Comprar|Shop Now|Registrarte|Sign Up|Abrir menú|Ver detalles|Enviar mensaje|Contáctanos)/i.test(l));

                porId.set(id, {
                    adId: id,
                    anunciante: nombrePagina,
                    paginaUrl: linkPagina?.href || '',
                    activo: /\bActivo\b|\bActive\b/i.test(texto),
                    inicio: (texto.match(/(?:En circulación desde el|Started running on)\s+(.+?)(?:\n|$)/i) || [])[1]?.trim() || '',
                    versiones: Number((texto.match(/(\d+)\s+anuncios? usan este contenido/i) || [])[1] || 1),
                    titulo: utiles[1] || utiles[0] || '',
                    cuerpo: utiles.slice(0, 3).join(' · ').slice(0, 400),
                    imagenUrl: creatividad?.src || '',
                    landing: linkDestino?.href || '',
                    enlaces: enlaces.length,
                });
            }
            return [...porId.values()];
};

export async function scrapeMetaAds(
    marca: string,
    opciones: { pais?: string; maxAnuncios?: number; minConfianza?: AnuncioMeta['confianza']; soloActivos?: boolean } = {},
): Promise<ResultadoMeta> {
    const { pais = 'CO', maxAnuncios = 30, minConfianza = 'media', soloActivos = true } = opciones;
    const diag: string[] = [];
    const url = construirUrl(marca, pais, soloActivos);
    const ctx = await getContext('meta');
    const page = await ctx.newPage();

    const orden: Record<AnuncioMeta['confianza'], number> = { exacta: 3, alta: 2, media: 1, baja: 0 };
    let crudos: any[] = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay(2500, 4000);
        await cerrarCookies(page, diag);

        try {
            const c = await page.locator('text=/~?\\s*[\\d.,]+\\s+resultados?/i').first().textContent({ timeout: 12000 });
            diag.push(`contador: ${c?.trim()}`);
        } catch { diag.push('contador no visible'); }

        /**
         * Extracción incremental.
         *
         * La Ad Library VIRTUALIZA la grilla: al bajar varias pantallas desmonta
         * las tarjetas de arriba. Extraer una sola vez al final devolvía solo el
         * último tramo — por eso "Banco Popular" daba 0 anuncios aunque en la
         * web se vean perfectamente. Ahora se extrae después de cada pasada y se
         * acumula por Library ID, así nada se pierde por haber salido del DOM.
         */
        const acumulado = new Map<string, any>();
        const extraer = async () => {
            const lote = await page.evaluate(EXTRAER_TARJETAS);
            for (const c of lote) {
                const previo = acumulado.get(c.adId);
                // Nos quedamos con la versión más completa de cada tarjeta.
                if (!previo || (c.enlaces || 0) > (previo.enlaces || 0)) acumulado.set(c.adId, c);
            }
        };

        /**
         * Scroll con RUEDA REAL, no window.scrollTo.
         *
         * Medido: con scrollTo el alto de la página se queda clavado (3712 px
         * pasada tras pasada) y nunca carga más allá de las primeras ~14
         * tarjetas. Meta engancha el scroll infinito a eventos de rueda /
         * IntersectionObserver que scrollTo no dispara. page.mouse.wheel emite
         * el evento de verdad y la grilla sí crece.
         */
        let sinNuevos = 0;
        for (let i = 0; i < 25; i++) {
            const antes = acumulado.size;
            const altoAntes = await page.evaluate(() => document.body.scrollHeight);

            // La rueda actúa sobre el elemento bajo el cursor: sin mover el mouse
            // al centro, page.mouse.wheel dispara sobre (0,0) — fuera de la
            // grilla — y no pasa nada.
            await page.mouse.move(683, 400);
            for (let r = 0; r < 4; r++) { await page.mouse.wheel(0, 900); await delay(320); }
            // Refuerzo por teclado: si la grilla vive en un contenedor con scroll
            // propio, End/PageDown lo mueven aunque la ventana ya esté al fondo.
            await page.keyboard.press('End').catch(() => {});
            await delay(1700);
            await extraer();

            const altoDespues = await page.evaluate(() => document.body.scrollHeight);
            if (acumulado.size === antes && altoDespues === altoAntes) {
                if (++sinNuevos >= 3) {
                    diag.push(`scroll saturado en pasada ${i + 1} (alto ${altoDespues}px)`);
                    break;
                }
            } else sinNuevos = 0;

            if (acumulado.size >= maxAnuncios * 4) { diag.push(`suficientes (${acumulado.size})`); break; }
        }
        // Una última pasada desde arriba: recupera lo que se haya desmontado.
        await page.evaluate(() => window.scrollTo({ top: 0 }));
        await delay(1800);
        await extraer();

        crudos = [...acumulado.values()];
        diag.push(`tarjetas únicas acumuladas en el scroll: ${crudos.length}`);

        // ── Capturas ──────────────────────────────────────────────────────────
        // Solo de las tarjetas que van a pasar el filtro de confianza: capturar
        // las descartadas es tiempo tirado (cada captura son ~1-2 s).
        const aCapturar = crudos
            .filter(c => c.anunciante && orden[evaluarConfianza(c.anunciante, c.paginaUrl, marca)] >= orden[minConfianza])
            .slice(0, maxAnuncios);

        // Volver al tope antes de capturar. Tras el scroll infinito la página
        // queda al final: las tarjetas de arriba pueden tener la creatividad sin
        // cargar (lazy) o haber sido desmontadas por virtualización, y salían
        // capturas en blanco o cortadas.
        await page.evaluate(() => window.scrollTo({ top: 0 }));
        await delay(1500);

        let capturadas = 0;
        for (const c of aCapturar) {
            try {
                const nodo = page.locator(`[data-zelva-ad="${c.adId}"]`).first();
                // Centrar la tarjeta en el viewport: pegada al borde superior o
                // inferior, el screenshot recorta.
                await nodo.scrollIntoViewIfNeeded({ timeout: 8000 });
                await page.evaluate(() => window.scrollBy({ top: -120 }));
                // Esperar a que las imágenes de ESTA tarjeta terminen de cargar,
                // en vez de un delay fijo que a veces era corto.
                await nodo.evaluate((el: Element) => Promise.all(
                    [...el.querySelectorAll('img')]
                        .filter(i => !(i as HTMLImageElement).complete)
                        .map(i => new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); setTimeout(r, 2500); }))
                )).catch(() => {});
                await delay(400);
                const buf = await nodo.screenshot({ type: 'jpeg', quality: 72, timeout: 15000 });
                c.imagenB64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
                capturadas++;
            } catch { /* tarjeta fuera de viewport o desmontada: sigue sin imagen */ }
        }
        diag.push(`capturas: ${capturadas} de ${aCapturar.length} intentadas`);
    } catch (e: any) {
        diag.push(`ERROR: ${e.message}`);
    } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }

    const porAnunciante = new Map<string, { nombre: string; paginaUrl: string; anuncios: number; confianza: string; aceptado: boolean }>();
    const anuncios: AnuncioMeta[] = [];

    for (const c of crudos) {
        if (!c.anunciante) continue;
        const confianza = evaluarConfianza(c.anunciante, c.paginaUrl, marca);
        const aceptado = orden[confianza] >= orden[minConfianza];

        const k = c.paginaUrl || c.anunciante;
        const acc = porAnunciante.get(k) || { nombre: c.anunciante, paginaUrl: c.paginaUrl, anuncios: 0, confianza, aceptado };
        acc.anuncios++;
        porAnunciante.set(k, acc);

        if (!aceptado || anuncios.length >= maxAnuncios) continue;
        anuncios.push({
            plataforma: 'meta',
            adId: c.adId,
            anunciante: c.anunciante,
            paginaUrl: c.paginaUrl,
            marcaConsultada: marca,
            confianza,
            titulo: c.titulo,
            cuerpo: c.cuerpo,
            inicio: c.inicio,
            activo: c.activo,
            versiones: c.versiones,
            imagenUrl: c.imagenUrl,
            imagenB64: c.imagenB64,
            landing: c.landing,
            enlace: `${URL_BASE}?id=${c.adId}`,
        });
    }

    return {
        marca,
        total: anuncios.length,
        anuncios,
        anunciantesEncontrados: [...porAnunciante.values()].sort((a, b) => b.anuncios - a.anuncios),
        urlConsultada: url,
        diagnostico: diag,
    };
}
