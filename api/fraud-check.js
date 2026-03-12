/**
 * Fraud detection for payment processing.
 * Checks: failed attempt limits, BIN velocity, IP velocity.
 * Uses Supabase payment_audit table for persistence across serverless instances.
 */

const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

/**
 * Log a payment attempt (success or failure) for audit and fraud detection.
 */
export async function logPaymentAttempt({ ip, cardLast4, cardBin, restaurantSlug, amount, success, reason }) {
  const key = sbKey();
  if (!key) return;
  try {
    await fetch(`${sbUrl()}/rest/v1/payment_audit`, {
      method: 'POST',
      headers: { ...sbHeaders(key), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        ip,
        card_last4: cardLast4 || null,
        card_bin: cardBin || null,
        restaurant_slug: restaurantSlug || null,
        amount: amount || 0,
        success,
        reason: reason || null,
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error('[fraud] audit log error:', e.message);
  }
}

/**
 * Run fraud checks before processing a payment.
 * Returns { allowed: true } or { allowed: false, reason: string, suspicious: boolean }
 */
export async function checkFraud({ ip, cardNumber }) {
  const key = sbKey();
  if (!key) return { allowed: true }; // Can't check without DB — allow (fail-open for availability)

  const cardBin = cardNumber ? cardNumber.replace(/\s/g, '').substring(0, 6) : null;
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();
  const headers = sbHeaders(key);
  const base = sbUrl();

  try {
    // Run all checks in parallel
    const [failedByIp, ordersByBin, ordersByIp] = await Promise.all([
      // Check 1: Failed payment attempts by IP in last hour
      fetch(
        `${base}/rest/v1/payment_audit?ip=eq.${encodeURIComponent(ip)}&success=eq.false&created_at=gte.${oneHourAgo}&select=id`,
        { headers, signal: AbortSignal.timeout(3000) }
      ).then(r => r.ok ? r.json() : []).catch(() => []),

      // Check 2: Orders by same card BIN in last hour
      cardBin ? fetch(
        `${base}/rest/v1/payment_audit?card_bin=eq.${encodeURIComponent(cardBin)}&success=eq.true&created_at=gte.${oneHourAgo}&select=id`,
        { headers, signal: AbortSignal.timeout(3000) }
      ).then(r => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),

      // Check 3: All orders from same IP in last 30 min
      fetch(
        `${base}/rest/v1/payment_audit?ip=eq.${encodeURIComponent(ip)}&success=eq.true&created_at=gte.${thirtyMinAgo}&select=id`,
        { headers, signal: AbortSignal.timeout(3000) }
      ).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    // Rule 1: Max 3 failed attempts per IP per hour
    if (failedByIp.length >= 3) {
      console.warn(`[fraud] IP ${ip} blocked: ${failedByIp.length} failed attempts in 1h`);
      return { allowed: false, reason: 'Too many failed payment attempts. Try again later.', suspicious: false };
    }

    // Rule 2: Max 10 successful orders per BIN per hour (catches card testing with sequential numbers)
    if (cardBin && ordersByBin.length >= 10) {
      console.warn(`[fraud] BIN ${cardBin} flagged: ${ordersByBin.length} orders in 1h`);
      return { allowed: false, reason: 'suspicious_bin_velocity', suspicious: true };
    }

    // Rule 3: More than 5 successful orders from same IP in 30 min = flag for review
    if (ordersByIp.length >= 5) {
      console.warn(`[fraud] IP ${ip} flagged: ${ordersByIp.length} orders in 30m`);
      return { allowed: true, reason: 'suspicious_ip_velocity', suspicious: true };
    }

    return { allowed: true };

  } catch (e) {
    console.error('[fraud] check error:', e.message);
    return { allowed: true }; // Fail-open: don't block legitimate payments if fraud check fails
  }
}
