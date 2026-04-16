import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

/**
 * Update an existing promo's title / price / description / image.
 * Also mirrors the changes onto the linked product so the menu stays in sync.
 *
 * Body: { promoId: number, title?, price?, description?, image_url? }
 * Auth: restaurant session.
 */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 20, windowMs: 60000, prefix: 'update-promo' })) return;

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
    const { promoId, title, price, description, image_url } = req.body;
    if (!promoId || !Number.isInteger(Number(promoId))) {
      return res.status(400).json({ error: 'promoId requerido' });
    }
    const slug = session.restaurant_slug;

    const promoPatch = {};
    const productPatch = {};

    if (typeof title === 'string') {
      const t = title.trim();
      if (!t) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      promoPatch.title = t.slice(0, 100);
      productPatch.name = t.slice(0, 100);
    }
    if (price !== undefined && price !== null) {
      const p = parseInt(price, 10);
      if (!p || p <= 0) return res.status(400).json({ error: 'El precio debe ser mayor a 0' });
      promoPatch.price = p;
      productPatch.price = p;
    }
    if (description !== undefined) {
      const d = (description == null ? '' : String(description)).trim();
      promoPatch.description = d ? d.slice(0, 300) : null;
      productPatch.description = d ? d.slice(0, 500) : null;
    }
    if (image_url !== undefined) {
      promoPatch.image_url = image_url || null;
      productPatch.img_url = image_url || null;
    }

    if (Object.keys(promoPatch).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const promoRes = await fetch(
      `${supabaseUrl}/rest/v1/promotions?id=eq.${encodeURIComponent(promoId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(promoPatch),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!promoRes.ok) {
      console.error('[update-promo] Patch error:', promoRes.status, await promoRes.text().catch(() => ''));
      return res.status(500).json({ error: 'Error actualizando la promo' });
    }
    const updated = await promoRes.json();
    if (updated.length === 0) {
      return res.status(404).json({ error: 'Promo no encontrada' });
    }

    // Mirror the fields onto the linked product so the menu reflects the edit
    const productId = updated[0].product_id;
    if (productId && Object.keys(productPatch).length > 0) {
      await fetch(
        `${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
        { method: 'PATCH', headers, body: JSON.stringify(productPatch), signal: AbortSignal.timeout(5000) }
      ).catch(() => {});
    }

    console.log(`[update-promo] ${slug}: updated promo ${promoId}`);
    return res.status(200).json({ success: true, promo: updated[0] });

  } catch (error) {
    console.error('[update-promo] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
