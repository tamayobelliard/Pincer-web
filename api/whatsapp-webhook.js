import crypto from 'crypto';
import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

export const config = { maxDuration: 60 };

const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

function validateTwilioSignature(authToken, signature, url, params) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  return crypto.createHmac('sha1', authToken).update(data).digest('base64') === signature;
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

// Check if text is an affirmation
function isConfirmation(text) {
  const clean = text.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sí → si
    .replace(/[^a-z0-9\s]/g, ''); // strip punctuation
  return /^(si|ok|listo|dale|perfecto|publicar|yes|confirmar|va|claro|correcto|bueno|bien)$/.test(clean);
}

// Parse corrections from owner text: "nombre: X, precio: Y, desc: Z"
function parseCorrections(text) {
  const corrections = {};
  const nameMatch = text.match(/nombre[:\s]+(.+?)(?:,\s*(?:precio|desc)|$)/i);
  const priceMatch = text.match(/precio[:\s]+\$?(\d+)/i);
  const descMatch = text.match(/desc(?:ripcion)?[:\s]+(.+?)(?:,\s*(?:nombre|precio)|$)/i);

  if (nameMatch) corrections.title = nameMatch[1].trim();
  if (priceMatch) corrections.price = parseInt(priceMatch[1], 10);
  if (descMatch) corrections.description = descMatch[1].trim();

  // If just a number, treat as price
  if (!Object.keys(corrections).length && /^\$?\d+$/.test(text.trim())) {
    corrections.price = parseInt(text.trim().replace('$', ''), 10);
  }

  return corrections;
}

// Generate product ID from slug + name
function makeProductId(slug, name) {
  const base = (name || 'promo').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  return `${slug}-${base}`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, { allowNoOrigin: true })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'wa-webhook' })) return;

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
        console.error('[wa] Invalid Twilio signature');
        return res.status(403).send('<Response/>');
      }
    }

    const { From, Body, NumMedia, MediaUrl0, MediaContentType0 } = req.body || {};
    const numMedia = parseInt(NumMedia || '0', 10);
    const bodyText = (Body || '').trim();
    const phone = (From || '').replace('whatsapp:', '');

    // --- Map phone → restaurant ---
    const supabaseUrl = sbUrl();
    const supabaseKey = sbKey();
    const headers = sbHeaders(supabaseKey);

    const restaurantRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?phone=eq.${encodeURIComponent(phone)}&status=eq.active&select=restaurant_slug,display_name&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!restaurantRes.ok) {
      return res.status(200).send(twiml('Error interno. Intenta de nuevo.'));
    }
    const restaurants = await restaurantRes.json();
    if (!restaurants.length) {
      return res.status(200).send(twiml('Este numero no esta registrado en Pincer.'));
    }

    const restaurant = restaurants[0];
    const slug = restaurant.restaurant_slug;
    const restaurantName = restaurant.display_name || slug;

    // --- Check for pending conversation ---
    const pendingRes = await fetch(
      `${supabaseUrl}/rest/v1/promotions?source_phone=eq.${encodeURIComponent(phone)}&restaurant_slug=eq.${encodeURIComponent(slug)}&wa_status=eq.awaiting_details&order=created_at.desc&limit=1&select=*`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    const pendingRows = pendingRes.ok ? await pendingRes.json() : [];
    const pending = pendingRows.length > 0 ? pendingRows[0] : null;
    console.log(`[wa] ${slug} | media=${numMedia} | text="${bodyText.slice(0, 30)}" | pending=${pending ? pending.id : 'none'}`);

    // ═══════════════════════════════════════════════════════════
    // CASE 1: New photo received (start new or replace pending)
    // ═══════════════════════════════════════════════════════════
    if (numMedia > 0 && MediaUrl0) {
      // Download image from Twilio
      const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
      const mediaAuth = Buffer.from(`${twilioAccountSid}:${authToken}`).toString('base64');
      const mediaRes = await fetch(MediaUrl0, {
        headers: { 'Authorization': `Basic ${mediaAuth}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!mediaRes.ok) {
        return res.status(200).send(twiml('No se pudo descargar la imagen. Intenta de nuevo.'));
      }

      const imageBuffer = Buffer.from(await mediaRes.arrayBuffer());
      const contentType = MediaContentType0 || 'image/jpeg';

      // Upload to Supabase Storage
      const timestamp = Date.now();
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const storagePath = `promos/${slug}/${timestamp}.${ext}`;
      const uploadRes = await fetch(
        `${supabaseUrl}/storage/v1/object/product-images/${storagePath}`,
        {
          method: 'PUT',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': contentType, 'x-upsert': 'true' },
          body: imageBuffer,
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!uploadRes.ok) {
        return res.status(200).send(twiml('Error subiendo la imagen. Intenta de nuevo.'));
      }
      const imageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}`;

      // Call Claude to analyze the photo
      const base64 = imageBuffer.toString('base64');
      const claudePrompt = `Analiza esta foto de comida para el restaurante "${restaurantName}".
${bodyText ? `El dueño escribió: "${bodyText}"` : ''}
Responde SOLO con JSON válido:
{"name": "Nombre del plato (max 40 chars)", "price": precio_en_pesos_o_null, "description": "Descripción apetitosa corta en español (max 80 chars)"}`;

      let suggestion = { name: 'Especial del Día', price: null, description: '' };

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
            { type: 'text', text: claudePrompt },
          ]}],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (claudeRes.ok) {
        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { suggestion = { ...suggestion, ...JSON.parse(jsonMatch[0]) }; } catch (e) { /* use defaults */ }
        }
      }

      // If owner sent text with the photo, use it to override AI suggestions
      if (bodyText) {
        const corr = parseCorrections(bodyText);
        if (corr.title) suggestion.name = corr.title;
        if (corr.price) suggestion.price = corr.price;
        if (corr.description) suggestion.description = corr.description;
      }

      // If there's a pending promo, update it; otherwise insert new
      if (pending) {
        const patchR = await fetch(
          `${supabaseUrl}/rest/v1/promotions?id=eq.${pending.id}`,
          {
            method: 'PATCH', headers,
            body: JSON.stringify({
              title: String(suggestion.name).slice(0, 100),
              price: suggestion.price ? Math.round(Number(suggestion.price)) : null,
              description: String(suggestion.description || '').slice(0, 300),
              image_url: imageUrl,
            }),
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!patchR.ok) console.error('[wa] Patch pending promo error:', patchR.status, await patchR.text().catch(() => ''));
      } else {
        const insertR = await fetch(`${supabaseUrl}/rest/v1/promotions`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            restaurant_slug: slug,
            is_active: false,
            title: String(suggestion.name).slice(0, 100),
            price: suggestion.price ? Math.round(Number(suggestion.price)) : null,
            description: String(suggestion.description || '').slice(0, 300),
            image_url: imageUrl,
            source_phone: phone,
            wa_status: 'awaiting_details',
            badge_text: 'NUEVO',
            cta_text: '¡Pruébalo Ya!',
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!insertR.ok) {
          const errText = await insertR.text().catch(() => '');
          console.error('[wa] Insert promo error:', insertR.status, errText);
          return res.status(200).send(twiml('Error guardando la promo. Verifica que la tabla promotions tenga las columnas wa_status y product_id.'));
        }
        console.log(`[wa] Promo saved for ${slug}, wa_status=awaiting_details`);
      }

      const priceText = suggestion.price ? `RD$${suggestion.price.toLocaleString()}` : '(sin precio)';
      return res.status(200).send(twiml(
        `📸 ¡Foto recibida!\n\n` +
        `• Nombre: ${suggestion.name}\n` +
        `• Precio: ${priceText}\n` +
        `• Desc: ${suggestion.description || '(sin descripción)'}\n\n` +
        `¿Está bien? Responde *si* para publicar.\n` +
        `O envía correcciones: "nombre: X, precio: Y"`
      ));
    }

    // ═══════════════════════════════════════════════════════════
    // CASE 2: Text received with pending conversation
    // ═══════════════════════════════════════════════════════════
    if (pending && bodyText) {

      // --- Confirmation → publish ---
      console.log(`[wa] CASE 2: isConfirmation("${bodyText}")=${isConfirmation(bodyText)}`);
      if (isConfirmation(bodyText)) {
        if (!pending.price) {
          return res.status(200).send(twiml(
            `Falta el precio. Envía: "precio: 350"`
          ));
        }

        // Create product in products table
        const productId = makeProductId(slug, pending.title);
        const productPayload = {
          id: productId,
          restaurant_slug: slug,
          name: String(pending.title).slice(0, 100),
          price: pending.price,
          description: String(pending.description || '').slice(0, 500),
          img_url: pending.image_url || null,
          category: 'Especiales',
          active: true,
          sold_out: false,
          display_order: 0,
        };

        // Upsert product (in case it already exists)
        console.log(`[wa] Creating product: ${productId}, price=${pending.price}`);
        const prodRes = await fetch(`${supabaseUrl}/rest/v1/products`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(productPayload),
          signal: AbortSignal.timeout(5000),
        });
        if (!prodRes.ok) {
          console.error('[wa] Product upsert error:', prodRes.status, await prodRes.text().catch(() => ''));
        }

        // Deactivate previous promos
        await fetch(
          `${supabaseUrl}/rest/v1/promotions?restaurant_slug=eq.${encodeURIComponent(slug)}&is_active=eq.true`,
          { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }), signal: AbortSignal.timeout(5000) }
        ).catch(() => {});

        // Calculate expires_at (end of day DR timezone UTC-4)
        const now = new Date();
        const drNow = new Date(now.getTime() - 4 * 3600000);
        const endOfDay = new Date(drNow);
        endOfDay.setUTCHours(23, 59, 59, 999);
        const expiresAt = new Date(endOfDay.getTime() + 4 * 3600000).toISOString();

        // Activate promo
        await fetch(
          `${supabaseUrl}/rest/v1/promotions?id=eq.${pending.id}`,
          {
            method: 'PATCH', headers,
            body: JSON.stringify({
              wa_status: 'published',
              is_active: true,
              product_id: productId,
              expires_at: expiresAt,
            }),
            signal: AbortSignal.timeout(5000),
          }
        );

        console.log(`[wa] Published promo for ${slug}: "${pending.title}" → product ${productId}`);
        return res.status(200).send(twiml(
          `✅ ¡Publicado!\n\n` +
          `"${pending.title}" - RD$${pending.price.toLocaleString()}\n\n` +
          `Ya esta en tu menu y en el popup de promo. Expira a medianoche.`
        ));
      }

      // --- Corrections ---
      const corrections = parseCorrections(bodyText);

      if (Object.keys(corrections).length > 0) {
        const patch = {};
        if (corrections.title) patch.title = String(corrections.title).slice(0, 100);
        if (corrections.price) patch.price = Math.round(corrections.price);
        if (corrections.description) patch.description = String(corrections.description).slice(0, 300);

        await fetch(
          `${supabaseUrl}/rest/v1/promotions?id=eq.${pending.id}`,
          { method: 'PATCH', headers, body: JSON.stringify(patch), signal: AbortSignal.timeout(5000) }
        );

        const updatedName = corrections.title || pending.title;
        const updatedPrice = corrections.price || pending.price;
        const updatedDesc = corrections.description || pending.description;
        const priceText = updatedPrice ? `RD$${updatedPrice.toLocaleString()}` : '(sin precio)';

        return res.status(200).send(twiml(
          `✏️ Actualizado:\n\n` +
          `• Nombre: ${updatedName}\n` +
          `• Precio: ${priceText}\n` +
          `• Desc: ${updatedDesc || '(sin descripción)'}\n\n` +
          `¿Listo para publicar? Responde *si*`
        ));
      }

      // --- Unstructured text → treat as product name ---
      if (bodyText.length > 1 && bodyText.length < 60) {
        await fetch(
          `${supabaseUrl}/rest/v1/promotions?id=eq.${pending.id}`,
          { method: 'PATCH', headers, body: JSON.stringify({ title: bodyText.slice(0, 100) }), signal: AbortSignal.timeout(5000) }
        );

        const priceText = pending.price ? `RD$${pending.price.toLocaleString()}` : '(sin precio)';
        return res.status(200).send(twiml(
          `✏️ Nombre cambiado a "${bodyText}"\n` +
          `• Precio: ${priceText}\n` +
          `• Desc: ${pending.description || '(sin descripción)'}\n\n` +
          `¿Publicar? Responde *si*`
        ));
      }

      return res.status(200).send(twiml(
        `Responde *si* para publicar, o envía correcciones:\n"nombre: X, precio: Y, desc: Z"`
      ));
    }

    // ═══════════════════════════════════════════════════════════
    // CASE 3: Text without pending conversation and no photo
    // ═══════════════════════════════════════════════════════════
    return res.status(200).send(twiml(
      'Para crear una promo, envía una foto del plato. Puedes agregar nombre y precio en el mensaje.'
    ));

  } catch (error) {
    console.error('[wa] error:', error);
    return res.status(200).send(twiml('Error procesando el mensaje. Intenta de nuevo.'));
  }
}
