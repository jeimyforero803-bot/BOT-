/**
 * Análisis IA del scan — usa Gemini Flash para generar resumen ejecutivo,
 * detectar alertas reales con explicación y recomendar acciones.
 *
 * Requiere: GEMINI_API_KEY en .env
 */

export interface AISummary {
  resumen: string;
  hitos: string[];
  alertas: Array<{ titulo: string; descripcion: string; severidad: 'alta' | 'media' | 'baja' }>;
  sentimiento: string;
  recomendacion: string;
  temas: string[];
  topTemas: Array<{ plataforma: string; autor: string; narrativa: string; url: string }>;
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

export async function generateAISummary(
  mentions: any[],
  comments: any[],
  keyword: string,
): Promise<AISummary | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.warn('[AISummary] GEMINI_API_KEY no configurado — omitiendo resumen IA');
    return null;
  }

  // Construir muestra de contenido (máx 60 items, 180 chars c/u)
  const sample = [
    ...mentions.slice(0, 25).map(m => `[${m.platform}|M] ${m.author}: ${(m.text || '').slice(0, 180)}`),
    ...comments.slice(0, 35).map(c => `[${c.platform}|C] ${c.author}: ${(c.text || '').slice(0, 180)}`),
  ].join('\n');

  // Top menciones con URLs para generar topTemas narrativos
  const topWithUrls = mentions
    .filter(m => m.url && m.url.startsWith('http'))
    .slice(0, 8)
    .map(m => `[${m.platform}] @${m.author}: "${(m.text || '').slice(0, 200)}" | URL: ${m.url}`)
    .join('\n');

  const prompt = `Eres un analista experto en social listening para marcas en Colombia y Latinoamérica.
Analiza las siguientes menciones y comentarios de redes sociales sobre la marca/keyword: "${keyword}".

DATOS RECOLECTADOS:
${sample}

TOP MENCIONES CON URL (usa estas para topTemas):
${topWithUrls || 'Sin URLs disponibles'}

INSTRUCCIONES:
- Responde ÚNICAMENTE con un JSON válido (sin markdown, sin explicaciones extra).
- El idioma de tu respuesta debe ser ESPAÑOL.
- Analiza el sentimiento REAL basado en el texto, no solo palabras clave.
- Las alertas deben ser situaciones REALMENTE preocupantes (crisis, quejas graves, desinformación, comparaciones negativas con competidores).
- No inventes datos ni exageres.
- Para topTemas: elige las 3 menciones más significativas de TOP MENCIONES CON URL. Cada narrativa debe ser un párrafo de 3-4 oraciones que: (1) identifique la plataforma y autor, (2) describa qué comparte la publicación, (3) explique su valor estratégico para la marca "${keyword}", (4) indique el impacto en posicionamiento. Usa la URL real de la mención.

Responde con este JSON exacto:
{
  "resumen": "Párrafo de 2-3 oraciones sobre qué se está diciendo, dónde y con qué tono general.",
  "hitos": ["Hito 1 más relevante", "Hito 2", "Hito 3"],
  "alertas": [
    {
      "titulo": "Título corto de la alerta",
      "descripcion": "Explicación de por qué es una alerta y qué comentarios la generaron.",
      "severidad": "alta|media|baja"
    }
  ],
  "sentimiento": "Descripción del tono general: qué emociones predominan, si es positivo/negativo/mixto y por qué.",
  "recomendacion": "Una acción concreta que la marca debería tomar basada en este análisis.",
  "temas": ["Tema principal 1", "Tema 2", "Tema 3"],
  "topTemas": [
    {
      "plataforma": "Instagram",
      "autor": "@handle",
      "narrativa": "Párrafo narrativo de 3-4 oraciones describiendo la mención y su valor estratégico para la marca.",
      "url": "https://url-real-de-la-mencion.com"
    }
  ]
}

Si no hay alertas reales, devuelve "alertas": []. Devuelve siempre exactamente 3 elementos en topTemas.`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2800, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.warn('[AISummary] Gemini error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const json = await res.json() as any;
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extraer JSON de la respuesta (puede venir con ```json ... ```)
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[AISummary] No se encontró JSON en la respuesta'); return null; }

    // Limpiar trailing commas que Gemini a veces genera (invalid JSON)
    const cleaned = match[0].replace(/,(\s*[}\]])/g, '$1');
    const parsed: AISummary = JSON.parse(cleaned);
    console.log('[AISummary] ✅ Resumen IA generado');
    return parsed;
  } catch (e: any) {
    console.warn('[AISummary] Error:', e.message?.slice(0, 80));
    return null;
  }
}
