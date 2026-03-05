const ALLOWED_ORIGINS = [
  'https://www.pincerweb.com',
  'https://pincerweb.com',
  'https://pincer-web.vercel.app',
];

// Allow localhost in development / preview deployments
if (process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'development') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173');
}

/**
 * Handle CORS preflight + origin validation.
 *
 * @param {object} req - Vercel request
 * @param {object} res - Vercel response
 * @param {object} opts
 * @param {string}  opts.methods       - Allowed methods (default 'POST, OPTIONS')
 * @param {string}  opts.headers       - Allowed headers (default 'Content-Type')
 * @param {boolean} opts.allowNoOrigin - Allow requests with no Origin header (webhooks, cron)
 * @returns {boolean} true if request was handled (preflight answered or origin rejected), false to proceed
 */
export function handleCors(req, res, { methods = 'POST, OPTIONS', headers = 'Content-Type', allowNoOrigin = false } = {}) {
  const origin = req.headers.origin;

  if (!origin) {
    // No Origin: same-origin navigation, server-to-server, cron, or webhook
    if (allowNoOrigin) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
      res.setHeader('Access-Control-Allow-Methods', methods);
      res.setHeader('Access-Control-Allow-Headers', headers);
      if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
      return false;
    }
    // For browser-only endpoints, still allow (same-origin requests don't send Origin)
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
    return false;
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
    return false;
  }

  // Unknown origin — reject
  console.warn('CORS rejected origin:', origin);
  res.status(403).json({ error: 'Origin not allowed' });
  return true;
}
