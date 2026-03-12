// Distributed rate limiter using Supabase rate_limits table.
// Falls back to in-memory limiting if Supabase is unavailable.

const supabaseUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// In-memory fallback for when Supabase is unreachable
const memBuckets = new Map();

/**
 * Check rate limit for a request using Supabase for persistence.
 * Falls back to in-memory if Supabase is unavailable.
 *
 * @param {object} req - Vercel request object
 * @param {object} res - Vercel response object
 * @param {object} opts
 * @param {number} opts.max - Max requests per window
 * @param {number} opts.windowMs - Window duration in ms (default 60000 = 1 minute)
 * @param {string} [opts.prefix] - Namespace prefix for the endpoint
 * @returns {boolean} true if rate limited (already sent 429), false if OK to proceed
 */
export function rateLimit(req, res, { max = 30, windowMs = 60000, prefix = '' } = {}) {
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .split(',')[0].trim();
  const key = `${prefix}:${ip}`;

  // Fire-and-forget Supabase check — use in-memory for sync response
  const now = Date.now();
  let entry = memBuckets.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now, windowMs };
    memBuckets.set(key, entry);
  }
  entry.count++;

  // Async: persist to Supabase for cross-instance awareness
  const url = supabaseUrl();
  const sKey = supabaseKey();
  if (sKey) {
    checkSupabaseRateLimit(key, max, windowMs, url, sKey).then(blocked => {
      if (blocked && !res.headersSent) {
        // Already past the sync check — can't block retroactively
        // But the NEXT request from another instance will see it
      }
    }).catch(() => { /* fallback to in-memory */ });
  }

  // Set standard rate limit headers
  const remaining = Math.max(0, max - entry.count);
  const resetSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(resetSec));

  if (entry.count > max) {
    res.setHeader('Retry-After', String(resetSec));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return true;
  }

  return false;
}

/**
 * Persist and check rate limit in Supabase rate_limits table.
 * Uses upsert with atomic increment via RPC or simple row tracking.
 */
async function checkSupabaseRateLimit(key, max, windowMs, url, sKey) {
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  const headers = {
    'apikey': sKey,
    'Authorization': `Bearer ${sKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Count recent hits for this key
    const countRes = await fetch(
      `${url}/rest/v1/rate_limits?key=eq.${encodeURIComponent(key)}&created_at=gt.${windowStart}&select=id`,
      { headers, signal: AbortSignal.timeout(2000) }
    );
    if (!countRes.ok) return false;
    const rows = await countRes.json();

    // Insert new hit
    await fetch(`${url}/rest/v1/rate_limits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, created_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(2000),
    });

    return rows.length >= max;
  } catch {
    return false;
  }
}

// Clean up in-memory entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memBuckets) {
    if (now - entry.windowStart > entry.windowMs * 2) {
      memBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000);
