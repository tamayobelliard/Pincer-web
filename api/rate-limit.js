// In-memory rate limiter by IP address.
// Vercel serverless functions share memory within the same instance,
// so this provides basic per-instance rate limiting. For distributed
// rate limiting, use Vercel KV or Upstash Redis in the future.

const buckets = new Map();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart > entry.windowMs * 2) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check rate limit for a request.
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
  const now = Date.now();

  let entry = buckets.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now, windowMs };
    buckets.set(key, entry);
  }

  entry.count++;

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
