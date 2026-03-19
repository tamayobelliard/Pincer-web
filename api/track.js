import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';

export const config = { maxDuration: 5 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Rate limit: 60 tracking events per minute per IP
  if (rateLimit(req, res, { max: 60, windowMs: 60000, prefix: 'track' })) return;

  const { session_id, restaurant_slug, event_type, event_data, browser_language, device_type } = req.body;

  if (!session_id || !restaurant_slug || !event_type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ ok: true });
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/page_events`, {
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
    });
  } catch (e) {
    console.error('page_events save error:', e.message);
  }

  return res.status(200).json({ ok: true });
}
