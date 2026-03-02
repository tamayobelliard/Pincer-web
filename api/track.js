export const config = { maxDuration: 5 };

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id, restaurant_slug, event_type, event_data, browser_language, device_type } = req.body;

  if (!session_id || !restaurant_slug || !event_type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Respond immediately — save async
  res.status(200).json({ ok: true });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  fetch(`${supabaseUrl}/rest/v1/page_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      session_id,
      restaurant_slug,
      event_type,
      event_data: event_data || {},
      browser_language: browser_language || null,
      device_type: device_type || null,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(e => console.error('page_events save error:', e.message));
}
