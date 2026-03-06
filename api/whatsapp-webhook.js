import crypto from 'crypto';
import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

export const config = { maxDuration: 60 };

const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

// Twilio signature validation (HMAC-SHA1, no npm dependency)
function validateTwilioSignature(authToken, signature, url, params) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const computed = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  return computed === signature;
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, { allowNoOrigin: true })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'wa-webhook' })) return;

  res.setHeader('Content-Type', 'text/xml');

  try {
    // --- Validate Twilio signature ---
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioSig = req.headers['x-twilio-signature'];

    if (authToken && twilioSig) {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'];
      const fullUrl = `${proto}://${host}${req.url}`;
      if (!validateTwilioSignature(authToken, twilioSig, fullUrl, req.body || {})) {
        console.error('[whatsapp-webhook] Invalid Twilio signature');
        return res.status(403).send('<Response/>');
      }
    }

    const { From, Body, NumMedia, MediaUrl0, MediaContentType0 } = req.body || {};
    const numMedia = parseInt(NumMedia || '0', 10);

    // No image → send instructions
    if (numMedia === 0 || !MediaUrl0) {
      return res.status(200).send(twiml(
        'Para crear una promo, envia una foto del plato o producto. Puedes agregar texto con el precio o detalles.'
      ));
    }

    // --- Map phone → restaurant ---
    const phone = (From || '').replace('whatsapp:', '');
    const supabaseUrl = sbUrl();
    const supabaseKey = sbKey();
    const headers = sbHeaders(supabaseKey);

    const restaurantRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?phone=eq.${encodeURIComponent(phone)}&status=eq.active&select=restaurant_slug,display_name,menu_style,logo_url&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );

    if (!restaurantRes.ok) {
      console.error('[whatsapp-webhook] Failed to query restaurant_users:', restaurantRes.status);
      return res.status(200).send(twiml('Error interno. Intenta de nuevo.'));
    }

    const restaurants = await restaurantRes.json();
    if (!restaurants.length) {
      return res.status(200).send(twiml(
        'Este numero no esta registrado en Pincer. Verifica que tu numero de telefono este configurado en tu cuenta.'
      ));
    }

    const restaurant = restaurants[0];
    const slug = restaurant.restaurant_slug;
    console.log(`[whatsapp-webhook] Promo from ${phone} for ${slug}`);

    // --- Download image from Twilio ---
    const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    const mediaAuth = Buffer.from(`${twilioAccountSid}:${authToken}`).toString('base64');

    const mediaRes = await fetch(MediaUrl0, {
      headers: { 'Authorization': `Basic ${mediaAuth}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!mediaRes.ok) {
      console.error('[whatsapp-webhook] Failed to download media:', mediaRes.status);
      return res.status(200).send(twiml('No se pudo descargar la imagen. Intenta de nuevo.'));
    }

    const imageBuffer = Buffer.from(await mediaRes.arrayBuffer());
    const contentType = MediaContentType0 || 'image/jpeg';

    // --- Upload to Supabase Storage ---
    const timestamp = Date.now();
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const storagePath = `promos/${slug}/${timestamp}.${ext}`;

    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/product-images/${storagePath}`,
      {
        method: 'PUT',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: imageBuffer,
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!uploadRes.ok) {
      console.error('[whatsapp-webhook] Storage upload failed:', uploadRes.status, await uploadRes.text());
      return res.status(200).send(twiml('Error subiendo la imagen. Intenta de nuevo.'));
    }

    const imageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}`;

    // --- Call Claude API for promo content ---
    const base64 = imageBuffer.toString('base64');
    const bodyText = (Body || '').trim();
    const restaurantName = restaurant.display_name || slug;

    const prompt = `Eres un asistente de marketing para el restaurante "${restaurantName}".
Analiza esta foto de comida y genera contenido promocional en español (estilo dominicano, casual).
${bodyText ? `El dueño agregó este texto: "${bodyText}"` : ''}

Responde SOLO con un JSON válido:
{
  "title": "Título corto y llamativo (max 40 caracteres)",
  "description": "Descripción apetitosa de 1-2 oraciones (max 120 caracteres)",
  "price": null o precio en pesos dominicanos si es visible/mencionado (solo el número),
  "original_price": null o precio original si hay descuento (solo el número),
  "badge_text": "NUEVO" o "HOY" o "OFERTA" o "ESPECIAL" (el más apropiado),
  "cta_text": "Ordenar Ahora" o un CTA similar en español
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    let promo = {
      title: 'Especial del Día',
      description: bodyText || '',
      price: null,
      original_price: null,
      badge_text: 'NUEVO',
      cta_text: 'Ordenar Ahora',
    };

    if (claudeRes.ok) {
      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          promo = { ...promo, ...parsed };
        } catch (e) {
          console.error('[whatsapp-webhook] Failed to parse Claude JSON:', e.message);
        }
      }
    } else {
      console.error('[whatsapp-webhook] Claude API error:', claudeRes.status);
    }

    // --- Deactivate previous promos for this restaurant ---
    await fetch(
      `${supabaseUrl}/rest/v1/promotions?restaurant_slug=eq.${encodeURIComponent(slug)}&is_active=eq.true`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_active: false }),
        signal: AbortSignal.timeout(5000),
      }
    ).catch(e => console.error('[whatsapp-webhook] Deactivate old promos error:', e.message));

    // --- Calculate expires_at: end of today in DR timezone (UTC-4) ---
    const drOffset = -4 * 60; // DR is UTC-4
    const now = new Date();
    const drNow = new Date(now.getTime() + drOffset * 60000);
    const endOfDay = new Date(drNow);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const expiresAt = new Date(endOfDay.getTime() - drOffset * 60000).toISOString();

    // --- Insert new promo ---
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/promotions`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        restaurant_slug: slug,
        is_active: true,
        title: String(promo.title || 'Especial del Día').slice(0, 100),
        description: String(promo.description || '').slice(0, 300),
        price: promo.price ? Math.round(Number(promo.price)) : null,
        original_price: promo.original_price ? Math.round(Number(promo.original_price)) : null,
        badge_text: String(promo.badge_text || 'NUEVO').slice(0, 20),
        cta_text: String(promo.cta_text || 'Ordenar Ahora').slice(0, 40),
        image_url: imageUrl,
        source_phone: phone,
        expires_at: expiresAt,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!insertRes.ok) {
      console.error('[whatsapp-webhook] Insert promo error:', insertRes.status, await insertRes.text());
      return res.status(200).send(twiml('Error guardando la promo. Intenta de nuevo.'));
    }

    console.log(`[whatsapp-webhook] Promo created for ${slug}: "${promo.title}"`);
    return res.status(200).send(twiml(
      `✅ Promo creada!\n"${promo.title}"\nYa esta visible en tu menu. Expira a medianoche.`
    ));

  } catch (error) {
    console.error('[whatsapp-webhook] error:', error);
    return res.status(200).send(twiml('Error procesando el mensaje. Intenta de nuevo.'));
  }
}
