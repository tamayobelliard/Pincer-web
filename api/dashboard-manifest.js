export default function handler(req, res) {
  const slug = (req.query.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    name: 'Pincer Dashboard',
    short_name: 'Pincer',
    start_url: `/${slug}/dashboard`,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#E8191A',
    icons: [{ src: '/favicon.ico', sizes: '192x192', type: 'image/png' }]
  });
}
