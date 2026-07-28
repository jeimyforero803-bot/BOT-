/**
 * TikTok — Creative Center · Top Ads (Colombia).
 *
 * POR QUÉ NO la Commercial Content Library (library.tiktok.com):
 *   Verificado el 2026-07-28, sin filtro de anunciante y ventana de 60 días:
 *     España   131.204.236 anuncios
 *     Francia  141.011.060
 *     Alemania 178.264.925
 *     Colombia          0     ← vacío
 *   La interfaz acepta region=CO pero el dataset es solo del espacio europeo
 *   (obligación del DSA). No sirve para Colombia.
 *
 * QUÉ ES ESTO EN CAMBIO:
 *   Top Ads es un RANKING curado de anuncios que rindieron bien, no un censo.
 *   Muestra lo que le funcionó a la competencia, no todo lo que publicó. Las
 *   métricas vienen en TRAMOS (Top 15% CTR, presupuesto bajo/medio/alto), no
 *   en absolutos. Se marca `esRanking: true` para que el dashboard no lo
 *   presente como cobertura exhaustiva.
 *
 * ESTRUCTURA DE LA TARJETA (verificada):
 *   "<objetivo> | <industria> | <anunciante> | <likes> | Top N% | CTR | <presupuesto> | Budget"
 *   Algunas tarjetas OMITEN el anunciante: "Lead Generation | Medical Services | 286 | Likes".
 *   Cada tarjeta enlaza a /business/creativecenter/topads/<id>.
 */
import { getContext, humanDelay, delay } from '../browser.js';

export interface AnuncioTikTok {
    plataforma: 'tiktok';
    adId: string;
    anunciante: string;
    industria: string;
    objetivo: string;
    likes: string;
    tramoCtr: string;
    tramoPresupuesto: string;
    enlace: string;
    /** Siempre true: Top Ads es un ranking, no la totalidad de lo pautado. */
    esRanking: true;
    imagenB64?: string;
}

export interface ResultadoTikTok {
    industriaBuscada: string;
    total: number;
    anuncios: AnuncioTikTok[];
    industriasVistas: Array<{ industria: string; anuncios: number }>;
    urlConsultada: string;
    diagnostico: string[];
}

const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Industria telecom en la taxonomía real de TikTok. "Cell Phones" es la
 * etiqueta que efectivamente usa para operadores y móviles en Colombia —
 * observada en la primera corrida; "Telecommunications" no aparece.
 */
export const INDUSTRIA_TELECOM = [
    'cell phone', 'telecom', 'telecommunication', 'telecomunicaciones',
    'mobile operator', 'internet service', 'phone & service', 'electronics',
];

export async function scrapeTikTokTopAds(
    opciones: { region?: string; periodo?: 7 | 30 | 180; industria?: string[]; maxAnuncios?: number } = {},
): Promise<ResultadoTikTok> {
    const { region = 'CO', periodo = 30, industria = INDUSTRIA_TELECOM, maxAnuncios = 30 } = opciones;
    const diag: string[] = [];
    const url = `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?region=${region}&period=${periodo}`;
    const ctx = await getContext('tiktok');
    const page = await ctx.newPage();

    let anuncios: AnuncioTikTok[] = [];
    let industriasVistas: Array<{ industria: string; anuncios: number }> = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay(4500, 6500);

        // Cargar tantas tarjetas como se pueda: Top Ads pagina con "Ver más"
        // además del scroll infinito.
        for (let i = 0; i < 12; i++) {
            await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
            await delay(1900);
            try {
                const btn = page.locator('button:has-text("View More"), button:has-text("Ver más")').first();
                if (await btn.isVisible({ timeout: 1200 })) { await btn.click({ timeout: 4000 }); await delay(2600); }
            } catch { /* sin botón: solo scroll */ }
        }

        const crudos = await page.evaluate(() => {
            // La tarjeta mínima es la que tiene el bloque de métricas completo.
            // Anclar a la clase real del componente: filtrar divs por texto
            // devolvía solo 4 de ~101 tarjetas, porque la mayoría reparte el
            // contenido entre nodos hijos y ninguno cumple los 3 términos.
            let nodos = [...document.querySelectorAll('[class*="TopadsVideoCard"]')] as HTMLElement[];
            if (!nodos.length) {
                nodos = [...document.querySelectorAll('div')].filter(e => {
                    const t = (e as HTMLElement).innerText || '';
                    return /Likes/.test(t) && /CTR/.test(t) && /Budget/.test(t) && t.length < 700;
                }) as HTMLElement[];
            }
            // Subir al contenedor de la tarjeta: la clase matchea nodos internos.
            nodos = nodos.map(e => {
                let el: HTMLElement = e;
                for (let k = 0; k < 5 && el.parentElement; k++) {
                    if (el.querySelector('a[href*="topads/"]')) break;
                    el = el.parentElement;
                }
                return el;
            });

            const out: any[] = [];
            const vistos = new Set<string>();
            nodos.forEach((el, i) => {
                const t = ((el as HTMLElement).innerText || '').trim();
                const partes = t.split('\n').map(x => x.trim()).filter(Boolean);
                // Necesita al menos: objetivo, industria, ..., Likes, Top N%, CTR, tramo, Budget
                if (partes.length < 6) return;

                const iLikes = partes.findIndex(p => /^Likes$/i.test(p));
                if (iLikes < 2) return;

                const objetivo = partes[0] || '';
                const industria = partes[1] || '';
                // Entre industria y el número de likes puede haber (o no) el anunciante.
                const anunciante = iLikes - 2 > 1 ? partes[2] : '';
                const likes = partes[iLikes - 1] || '';
                const iCtr = partes.findIndex(p => /^CTR$/i.test(p));
                const tramoCtr = iCtr > 0 ? partes[iCtr - 1] : '';
                const iBudget = partes.findIndex(p => /^Budget$/i.test(p));
                const tramoPresupuesto = iBudget > 0 ? partes[iBudget - 1] : '';

                const a = el.querySelector('a') as HTMLAnchorElement | null
                    || el.closest('div')?.querySelector('a[href*="topads/"]') as HTMLAnchorElement | null;
                const href = a?.href || '';
                const adId = (href.match(/topads\/(\d+)/) || [])[1] || `idx_${i}`;
                if (vistos.has(adId)) return;
                vistos.add(adId);

                el.setAttribute('data-zelva-tt', adId);
                out.push({ adId, objetivo, industria, anunciante, likes, tramoCtr, tramoPresupuesto, enlace: href });
            });
            return out;
        });

        diag.push(`tarjetas detectadas: ${crudos.length}`);

        const conteo = new Map<string, number>();
        for (const c of crudos) if (c.industria) conteo.set(c.industria, (conteo.get(c.industria) || 0) + 1);
        industriasVistas = [...conteo.entries()].map(([industria, n]) => ({ industria, anuncios: n }))
            .sort((a, b) => b.anuncios - a.anuncios);
        diag.push(`industrias: ${industriasVistas.map(i => `${i.industria}(${i.anuncios})`).join(', ') || 'ninguna'}`);

        const filtrados = industria.length
            ? crudos.filter(c => industria.some(term => norm(c.industria).includes(norm(term))))
            : crudos;
        diag.push(`tras filtro de industria [${industria.join('|')}]: ${filtrados.length}`);

        anuncios = filtrados.slice(0, maxAnuncios).map(c => ({
            plataforma: 'tiktok' as const,
            adId: c.adId,
            anunciante: c.anunciante,
            industria: c.industria,
            objetivo: c.objetivo,
            likes: c.likes,
            tramoCtr: c.tramoCtr,
            tramoPresupuesto: c.tramoPresupuesto,
            enlace: c.enlace || url,
            esRanking: true as const,
        }));

        let capturadas = 0;
        for (const a of anuncios) {
            try {
                const nodo = page.locator(`[data-zelva-tt="${a.adId}"]`).first();
                await nodo.scrollIntoViewIfNeeded({ timeout: 8000 });
                await delay(700); // el video de la tarjeta tarda en pintar el primer frame
                const buf = await nodo.screenshot({ type: 'jpeg', quality: 72, timeout: 15000 });
                a.imagenB64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
                capturadas++;
            } catch { /* sin captura */ }
        }
        diag.push(`capturas: ${capturadas}/${anuncios.length}`);
    } catch (e: any) {
        diag.push(`ERROR: ${e.message}`);
    } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }

    return { industriaBuscada: industria.join('|'), total: anuncios.length, anuncios, industriasVistas, urlConsultada: url, diagnostico: diag };
}
