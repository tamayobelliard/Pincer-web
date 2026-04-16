import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

/**
 * Create a promo (special) from the dashboard.
 * Inserts both:
 *  - a row in `products` under category "Especiales" (so it appears in the menu)
 *  - a row in `promotions` with is_active=true, wa_status='published' (so it
 *    appears in the customer menu popup carousel)
 *
 * Body: { title, price, description?, image_url? }
 * Auth: restaurant session.
 */

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'create-promo' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const token = getRestaurantToken(req);
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ error: 'Sesión inválida' });

  try {
    const { title, price, description, image_url } = req.body;

    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return res.status(400).json({ error: 'El nombre es requerido' });

    const priceInt = parseInt(price, 10);
    if (!priceInt || priceInt <= 0) return res.status(400).json({ error: 'El precio debe ser mayor a 0' });

    const slug = session.restaurant_slug;
    const base = slugify(cleanTitle) || 'especial';
    // Add a short suffix from timestamp so re-uploads with same name don't collide
    const productId = `${slug}-${base}-${Date.now().toString(36).slice(-4)}`;

    const productPayload = {
      id: productId,
      restaurant_slug: slug,
      name: cleanTitle.slice(0, 100),
      price: priceInt,
      description: description ? String(description).slice(0, 500) : null,
      img_url: image_url || null,
      category: 'Recomendacion del Chef',
      active: true,
      sold_out: false,
      display_order: 0,
    };

    const prodRes = await fetch(`${supabaseUrl}/rest/v1/products`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(productPayload),
      signal: AbortSignal.timeout(5000),
    });
    if (!prodRes.ok) {
      console.error('[create-promo] Product insert error:', prodRes.status, await prodRes.text().catch(() => ''));
      return res.status(500).json({ error: 'No se pudo crear el producto' });
    }

    const promoPayload = {
      restaurant_slug: slug,
      is_active: true,
      wa_status: 'published',
      title: cleanTitle.slice(0, 100),
      price: priceInt,
      description: description ? String(description).slice(0, 300) : null,
      image_url: image_url || null,
      badge_text: 'NUEVO',
      cta_text: '¡Pruébalo Ya!',
      product_id: productId,
    };

    const promoRes = await fetch(`${supabaseUrl}/rest/v1/promotions`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(promoPayload),
      signal: AbortSignal.timeout(5000),
    });
    if (!promoRes.ok) {
      const errText = await promoRes.text().catch(() => '');
      console.error('[create-promo] Promo insert error:', promoRes.status, errText);
      // Roll back the product we just created so we don't leave an orphan
      await fetch(
        `${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
        { method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' }, signal: AbortSignal.timeout(5000) }
      ).catch(() => {});
      return res.status(500).json({ error: 'No se pudo crear el especial' });
    }

    const rows = await promoRes.json();
    console.log(`[create-promo] ${slug}: created promo ${rows[0]?.id || '?'} + product ${productId}`);
    return res.status(200).json({ success: true, promo: rows[0] });

  } catch (error) {
    console.error('[create-promo] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
