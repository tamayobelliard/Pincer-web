import { handleCors, requireJson } from './cors.js';
import { rateLimit } from './rate-limit.js';
import { normalizePhone } from './normalize-phone.js';

/**
 * POST /api/loyalty-increment
 *
 * Called by the menu frontend after a successful card-paid order.
 * Validates the order qualifies (paid, has qualifying items, not yet
 * counted), increments the loyalty balance, and optionally marks a
 * reward as redeemed if the order contains the reward item at price 0.
 *
 * Body: { orderId: number, slug: string }
 *
 * No session auth — this runs in the customer's browser after checkout.
 * Protected by: orderId must exist + loyalty_counted guard + rate limit.
 */

const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'loyalty-increment' })) return;

  const { orderId, slug } = req.body;
  if (!orderId || !slug) {
    return res.status(400).json({ error: 'orderId and slug required' });
  }

  const supabaseUrl = sbUrl();
  const supabaseKey = sbKey();
  if (!supabaseKey) return res.status(500).json({ error: 'Server config error' });
  const headers = sbHeaders(supabaseKey);

  try {
    // ── 1. Fetch the order ──
    const orderRes = await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&restaurant_slug=eq.${encodeURIComponent(slug)}&select=id,phone,status,azul_order_id,items,total,loyalty_counted`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!orderRes.ok) return res.status(500).json({ error: 'Order lookup failed' });
    const orders = await orderRes.json();
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // ── 2. Validate the order qualifies ──

    // Must be a card payment (azul_order_id present)
    if (!order.azul_order_id) {
      return res.status(200).json({ counted: false, reason: 'not_card_payment' });
    }

    // Must not already be counted
    if (order.loyalty_counted) {
      return res.status(200).json({ counted: false, reason: 'already_counted' });
    }

    // Must not be voided
    if (order.status === 'voided') {
      return res.status(200).json({ counted: false, reason: 'voided' });
    }

    // Must have a phone
    const phone = normalizePhone(order.phone);
    if (!phone) {
      return res.status(200).json({ counted: false, reason: 'no_phone' });
    }

    // ── 3. Fetch the loyalty config ──
    const configRes = await fetch(
      `${supabaseUrl}/rest/v1/loyalty_config?restaurant_slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=*&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!configRes.ok) return res.status(500).json({ error: 'Config lookup failed' });
    const configs = await configRes.json();
    if (!configs.length) {
      return res.status(200).json({ counted: false, reason: 'no_loyalty_program' });
    }
    const config = configs[0];

    // ── 4. Validate qualifying categories ──
    // At least 1 PAID item (price > 0) from the qualifying categories
    let items;
    try {
      items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    } catch (e) {
      items = [];
    }
    if (!Array.isArray(items)) items = [];

    const qualifyingCats = (config.qualifying_categories || []).map(c => c.toLowerCase());

    // We need to check item categories against the products table because the
    // order items JSON only stores name/price/qty, not category. Fetch the
    // product records for the items in this order.
    const itemIds = items.map(i => i.id).filter(Boolean);
    let hasQualifyingItem = false;

    if (qualifyingCats.length === 0) {
      // No category restriction → any paid order qualifies
      hasQualifyingItem = items.some(i => (Number(i.price) || 0) > 0);
    } else if (itemIds.length > 0) {
      const prodRes = await fetch(
        `${supabaseUrl}/rest/v1/products?id=in.(${itemIds.map(encodeURIComponent).join(',')})&restaurant_slug=eq.${encodeURIComponent(slug)}&select=id,category`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }, signal: AbortSignal.timeout(5000) }
      );
      if (prodRes.ok) {
        const products = await prodRes.json();
        const catMap = {};
        products.forEach(p => { catMap[p.id] = (p.category || '').toLowerCase(); });

        // Check if any paid item (price > 0) belongs to a qualifying category
        hasQualifyingItem = items.some(i => {
          const cat = catMap[i.id] || '';
          const price = Number(i.price) || 0;
          return price > 0 && qualifyingCats.includes(cat);
        });
      }
    }

    if (!hasQualifyingItem) {
      return res.status(200).json({ counted: false, reason: 'no_qualifying_items' });
    }

    // ── 5. Increment loyalty balance (atomic upsert via RPC) ──
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_loyalty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_slug: slug, p_phone: phone }),
      signal: AbortSignal.timeout(5000),
    });

    let newCount = 0;
    if (rpcRes.ok) {
      const rpcData = await rpcRes.json();
      newCount = typeof rpcData === 'number' ? rpcData : (rpcData?.[0] || 0);
    } else {
      console.error('[loyalty-increment] RPC error:', rpcRes.status, await rpcRes.text().catch(() => ''));
      return res.status(500).json({ error: 'Failed to increment loyalty' });
    }

    // ── 6. Mark order as counted ──
    await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ loyalty_counted: true }),
        signal: AbortSignal.timeout(5000),
      }
    );

    // ── 7. Check if the order redeems a reward ──
    // The reward product appears in the order at price 0 with source "loyalty"
    const rewardProductId = config.reward_product_id;
    const hasRedemption = rewardProductId && items.some(i =>
      i.id === rewardProductId && (Number(i.price) || 0) === 0
    );

    if (hasRedemption) {
      await fetch(`${supabaseUrl}/rest/v1/rpc/redeem_loyalty`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_slug: slug, p_phone: phone }),
        signal: AbortSignal.timeout(5000),
      }).catch(e => console.error('[loyalty-increment] redeem RPC error:', e.message));
    }

    // ── 8. Return the updated state ──
    const ordersNeeded = config.orders_needed;
    const rewardsEarned = Math.floor(newCount / ordersNeeded);
    const progressTowardNext = newCount % ordersNeeded;

    console.log(`[loyalty] ${slug} phone=${phone} orderId=${orderId} count=${newCount} earned=${rewardsEarned}${hasRedemption ? ' +redeemed' : ''}`);

    return res.status(200).json({
      counted: true,
      orders_count: newCount,
      rewards_earned: rewardsEarned,
      progress_toward_next: progressTowardNext,
      remaining: ordersNeeded - progressTowardNext,
      redeemed_in_this_order: hasRedemption,
    });

  } catch (error) {
    console.error('[loyalty-increment] error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
