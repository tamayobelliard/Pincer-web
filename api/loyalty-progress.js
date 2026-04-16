import { handleCors } from './cors.js';
import { rateLimit } from './rate-limit.js';
import { normalizePhone } from './normalize-phone.js';

/**
 * GET /api/loyalty-progress?phone=8095551234&slug=mrsandwich
 *
 * Public endpoint (no auth). Returns the customer's loyalty progress
 * for a given restaurant: how many qualifying orders, how many rewards
 * earned/available, and what the program rules are.
 *
 * Used by the checkout UI to render the VIP box after the customer
 * enters their phone number.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: 'loyalty-progress' })) return;

  const phone = req.query.phone;
  const slug = req.query.slug;

  if (!phone || !slug) {
    return res.status(400).json({ error: 'phone and slug required' });
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) return res.status(500).json({ error: 'Server config error' });
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

  try {
    // 1. Fetch loyalty config for this restaurant
    const configRes = await fetch(
      `${supabaseUrl}/rest/v1/loyalty_config?restaurant_slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=program_name,orders_needed,reward_product_id,reward_name,qualifying_categories&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!configRes.ok) {
      console.error('[loyalty-progress] config query error:', configRes.status);
      return res.status(500).json({ error: 'DB error' });
    }
    const configs = await configRes.json();
    if (!configs.length) {
      // No active loyalty program for this restaurant
      return res.status(200).json({ active: false });
    }
    const config = configs[0];

    // 2. Fetch loyalty balance for this phone + restaurant
    const balanceRes = await fetch(
      `${supabaseUrl}/rest/v1/loyalty_balance?restaurant_slug=eq.${encodeURIComponent(slug)}&phone=eq.${encodeURIComponent(normalizedPhone)}&select=orders_count,rewards_redeemed,last_order_at&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!balanceRes.ok) {
      console.error('[loyalty-progress] balance query error:', balanceRes.status);
      return res.status(500).json({ error: 'DB error' });
    }
    const balances = await balanceRes.json();
    const balance = balances[0] || { orders_count: 0, rewards_redeemed: 0 };

    // 3. Compute derived values
    const ordersCount = balance.orders_count;
    const ordersNeeded = config.orders_needed;
    const rewardsEarned = Math.floor(ordersCount / ordersNeeded);
    const rewardsAvailable = Math.max(0, rewardsEarned - balance.rewards_redeemed);
    const progressTowardNext = ordersCount % ordersNeeded;
    const remaining = ordersNeeded - progressTowardNext;

    return res.status(200).json({
      active: true,
      program_name: config.program_name,
      reward_name: config.reward_name,
      reward_product_id: config.reward_product_id,
      qualifying_categories: config.qualifying_categories || [],
      orders_needed: ordersNeeded,
      orders_count: ordersCount,
      rewards_earned: rewardsEarned,
      rewards_available: rewardsAvailable,
      progress_toward_next: progressTowardNext,
      remaining: remaining,
    });

  } catch (error) {
    console.error('[loyalty-progress] error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
