export default async function handler(req, res) {
  const slug = req.query.slug;
  if (!slug) return res.status(400).send('Missing slug');

  // Fetch restaurant data
  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let displayName = 'Menú Digital';
  let logoUrl = 'https://pincerweb.com/og-default.png';
  let description = 'Ordena desde tu mesa';

  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=display_name,logo_url&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows.length > 0) {
        displayName = rows[0].display_name || displayName;
        if (rows[0].logo_url) logoUrl = rows[0].logo_url;
        description = `Pide en ${displayName} desde tu mesa`;
      }
    }
  } catch (e) {
    // Use defaults on error
  }

  const title = `${displayName} — Menú Digital`;
  const pageUrl = `https://www.pincerweb.com/${encodeURIComponent(slug)}`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(logoUrl)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(logoUrl)}">
<meta http-equiv="refresh" content="0;url=${esc(pageUrl)}">
</head>
<body></body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).send(html);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
