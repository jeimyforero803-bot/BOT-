/**
 * Orquestador de bibliotecas de anuncios.
 *
 * Corre los scrapers de Meta y Google para una lista de marcas y deposita el
 * resultado en el backend de Zalvaje, que es quien tiene las credenciales de
 * Supabase. El agente no las necesita — mismo patrón que /api/agent/register-url.
 *
 * TikTok queda declarado pero desactivado: sin sesión iniciada el Creative
 * Center solo devuelve ~4 tarjetas rotativas de las ~101 que existen
 * (verificado en dos corridas: industrias completamente distintas). Cuando
 * exista auth/tiktok.json se habilita solo.
 */
import { scrapeMetaAds } from './sources/adsMeta.js';
import { scrapeGoogleAds } from './sources/adsGoogle.js';
import { scrapeTikTokTopAds, INDUSTRIA_TELECOM } from './sources/adsTikTok.js';
import { hasAuth, closeBrowser, humanDelay } from './browser.js';

export interface ObjetivoMarca {
    marca: string;
    /** Dominio oficial. Es el ancla de Google: sin él elige mal (para "ETB"
     *  la primera sugerencia es una agencia de viajes egipcia). */
    dominio?: string;
}

export interface ResumenBiblioteca {
    marca: string;
    meta: { capturados: number; anunciantes: number; error?: string };
    google: { capturados: number; anuncianteElegido: string; error?: string };
    tiktok: { capturados: number; omitido?: string };
}

interface CreativaPlana {
    plataforma: string;
    marca: string;
    anunciante: string;
    ad_id: string;
    titulo: string;
    cuerpo: string;
    formato: string;
    imagen_b64?: string;
    imagen_url?: string;
    enlace: string;
}

const BACKEND = (process.env.ZALVAJE_BACKEND || 'http://localhost:3001').replace(/\/$/, '');

/**
 * Deposita en /api/agent/ads-deposit, no en /api/atl/creatives.
 *
 * /api/atl exige X-Zelva-Key, que el agente no tiene: en producción el POST
 * moría con 401 y nadie se enteraba porque el resumen contaba lo ENVIADO, no
 * lo guardado. /api/agent está exento de ese guard y valida con x-agent-key,
 * que es la credencial propia del agente.
 */
async function depositar(creatividades: CreativaPlana[]): Promise<{ ok: boolean; guardadas: number; detalle: string }> {
    if (!creatividades.length) return { ok: true, guardadas: 0, detalle: 'nada que enviar' };
    try {
        const res = await fetch(`${BACKEND}/api/agent/ads-deposit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.AGENT_KEY ? { 'x-agent-key': process.env.AGENT_KEY } : {}),
            },
            body: JSON.stringify({ creatividades }),
        });
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, guardadas: 0, detalle: `HTTP ${res.status}: ${j?.error || 'sin detalle'}` };
        return { ok: true, guardadas: Number(j?.guardadas) || 0, detalle: `${j?.guardadas}/${j?.recibidas} guardadas` };
    } catch (e: any) {
        return { ok: false, guardadas: 0, detalle: e.message };
    }
}

/**
 * Cuántas creatividades capturar por plataforma y marca.
 *
 * Cada captura cuesta ~1,5 s y pesa ~20 KB en base64. Google llega a declarar
 * ~400 anuncios por dominio, así que el tope decide cuánto se deja afuera:
 *   50  → ~1,5 min por marca y plataforma  ·  1 MB
 *   160 → ~4 min                           ·  3,2 MB
 * El default es 50: cubre bien el repertorio activo sin que una corrida de
 * 5 marcas se vaya a más de media hora.
 */
export const TOPE_POR_DEFECTO = 50;

export async function capturarBibliotecas(
    objetivos: ObjetivoMarca[],
    opciones: { maxPorPlataforma?: number; incluirTikTok?: boolean } = {},
): Promise<{ resumen: ResumenBiblioteca[]; enviadas: number; deposito: string }> {
    const { maxPorPlataforma = TOPE_POR_DEFECTO, incluirTikTok = true } = opciones;
    const resumen: ResumenBiblioteca[] = [];
    const todas: CreativaPlana[] = [];

    for (const obj of objetivos) {
        const marca = obj.marca.trim();
        const fila: ResumenBiblioteca = {
            marca,
            meta: { capturados: 0, anunciantes: 0 },
            google: { capturados: 0, anuncianteElegido: '' },
            tiktok: { capturados: 0 },
        };

        // ── META ──────────────────────────────────────────────────────────────
        try {
            const r = await scrapeMetaAds(marca, { maxAnuncios: maxPorPlataforma, minConfianza: 'media' });
            fila.meta = { capturados: r.total, anunciantes: r.anunciantesEncontrados.length };
            for (const a of r.anuncios) {
                todas.push({
                    plataforma: 'meta',
                    marca,
                    anunciante: a.anunciante,
                    ad_id: a.adId,
                    titulo: a.titulo,
                    cuerpo: a.cuerpo,
                    formato: a.versiones > 1 ? 'carousel' : 'display',
                    imagen_b64: a.imagenB64,
                    // fbcdn responde 403 fuera de Facebook: se guarda solo como
                    // referencia, la imagen usable es imagen_b64.
                    imagen_url: a.imagenUrl,
                    enlace: a.enlace,
                });
            }
        } catch (e: any) { fila.meta.error = e.message; }

        await humanDelay(2500, 5000);

        // ── GOOGLE ────────────────────────────────────────────────────────────
        try {
            const r = await scrapeGoogleAds(marca, { maxAnuncios: maxPorPlataforma, dominioEsperado: obj.dominio });
            fila.google = { capturados: r.total, anuncianteElegido: r.anuncianteElegido };
            for (const a of r.anuncios) {
                todas.push({
                    plataforma: 'google',
                    marca,
                    anunciante: a.anunciante,
                    ad_id: a.adId,
                    titulo: '',
                    cuerpo: '',
                    formato: a.formato,
                    imagen_b64: a.imagenB64,
                    enlace: a.enlace,
                });
            }
        } catch (e: any) { fila.google.error = e.message; }

        await humanDelay(2500, 5000);
        resumen.push(fila);
    }

    // ── TIKTOK ────────────────────────────────────────────────────────────────
    // Una sola pasada para todas las marcas: Top Ads no se consulta por marca
    // sino por industria, así que correrlo por marca sería repetir la misma
    // llamada N veces.
    if (incluirTikTok) {
        if (!hasAuth('tiktok')) {
            const motivo = 'sin sesión (auth/tiktok.json) — Creative Center solo devuelve ~4 tarjetas rotativas de ~101';
            resumen.forEach(r => { r.tiktok.omitido = motivo; });
        } else {
            try {
                const r = await scrapeTikTokTopAds({ industria: INDUSTRIA_TELECOM, maxAnuncios: maxPorPlataforma });
                for (const a of r.anuncios) {
                    // El anunciante de TikTok es texto libre: se asocia a la marca
                    // objetivo cuya palabra aparezca en él; si ninguna, se guarda
                    // bajo la industria para no atribuirlo mal.
                    const dueño = objetivos.find(o =>
                        a.anunciante.toLowerCase().includes(o.marca.toLowerCase()));
                    todas.push({
                        plataforma: 'tiktok',
                        marca: (dueño?.marca || a.industria || 'telecom').toLowerCase(),
                        anunciante: a.anunciante,
                        ad_id: a.adId,
                        titulo: a.objetivo,
                        cuerpo: `${a.industria} · ${a.likes} likes · CTR ${a.tramoCtr} · presupuesto ${a.tramoPresupuesto}`,
                        formato: 'video',
                        imagen_b64: a.imagenB64,
                        enlace: a.enlace,
                    });
                    const f = resumen.find(x => x.marca === dueño?.marca);
                    if (f) f.tiktok.capturados++;
                }
            } catch (e: any) {
                resumen.forEach(r => { r.tiktok.omitido = e.message; });
            }
        }
    } else {
        resumen.forEach(r => { r.tiktok.omitido = 'desactivado por parámetro'; });
    }

    await closeBrowser();
    const dep = await depositar(todas);
    // `enviadas` refleja lo GUARDADO, no lo intentado: contar lo enviado fue
    // exactamente lo que hizo que un fallo de 401 pasara por éxito.
    return {
        resumen,
        enviadas: dep.guardadas,
        intentadas: todas.length,
        deposito: `${dep.ok ? 'OK' : 'FALLO'} — ${dep.detalle}`,
    };
}
