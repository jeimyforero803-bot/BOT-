/**
 * WhatsApp notifications via CallMeBot (gratis, sin aprobación Meta)
 * Setup:
 *   1. Agrega tu número en .env → WHATSAPP_PHONE=+57XXXXXXXXXX
 *   2. Envía un WhatsApp a +34 644 44 52 66 con el texto: "I allow callmebot to send me messages"
 *   3. Recibirás un API key → agrégalo en .env → WHATSAPP_APIKEY=XXXXXX
 */

export async function sendWhatsApp(message: string): Promise<void> {
  const phone = process.env.WHATSAPP_PHONE?.trim();
  const apikey = process.env.WHATSAPP_APIKEY?.trim();

  if (!phone || !apikey) {
    // No configurado — silencioso
    return;
  }

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${apikey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      console.log('[WhatsApp] ✅ Notificación enviada');
    } else {
      console.warn('[WhatsApp] ⚠ Respuesta inesperada:', res.status);
    }
  } catch (e: any) {
    console.warn('[WhatsApp] ⚠ No se pudo enviar:', e.message?.slice(0, 80));
  }
}
