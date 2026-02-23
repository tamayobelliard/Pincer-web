const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

// Verify admin session token against Supabase
async function verifyAdmin(token, supabaseUrl, supabaseKey) {
  if (!token) return false;
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&expires_at=gt.${new Date().toISOString()}&select=user_id`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return rows.length > 0;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token
  const isAdmin = await verifyAdmin(req.headers['x-admin-key'], supabaseUrl, supabaseKey);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { image, restaurant_slug } = req.body;

  if (!image || !restaurant_slug) {
    return res.status(400).json({ error: 'image (base64) and restaurant_slug are required' });
  }

  try {
    // Detect media type from base64 header or default to jpeg
    let mediaType = 'image/jpeg';
    let imageData = image;
    if (image.startsWith('data:')) {
      const match = image.match(/^data:(image\/\w+);base64,/);
      if (match) {
        mediaType = match[1];
        imageData = image.slice(match[0].length);
      }
    }

    // Send image to Claude Vision
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: imageData,
                },
              },
              {
                type: 'text',
                text: 'This is a photo of a restaurant menu. Extract all items and return ONLY a JSON array with no extra text, in this format: [{"name": "Item Name", "price": 350, "category": "food", "description": "Brief description"}]. Price must be an integer in DOP. Category must be one of: food, drinks, extras. Description can be empty string if not visible.',
              },
            ],
          },
        ],
      }),
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      console.error('Claude API error:', claudeData);
      return res.status(502).json({ error: 'Failed to process image with AI' });
    }

    const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not extract menu items from image', raw: rawText });
    }

    let items;
    try {
      items = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(422).json({ error: 'Invalid JSON from AI response', raw: rawText });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(422).json({ error: 'No menu items detected in image' });
    }

    // Build rows for bulk insert
    const validCategories = ['food', 'drinks', 'extras'];
    const rows = items.map((item, i) => ({
      id: `${restaurant_slug}-${(item.name || 'item').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-${i}`,
      name: String(item.name || '').slice(0, 100),
      price: Math.round(Number(item.price)) || 0,
      category: validCategories.includes(item.category) ? item.category : 'food',
      description: String(item.description || '').slice(0, 500),
      restaurant_slug,
      active: true,
      sold_out: false,
      display_order: i,
    }));

    // Bulk insert into products
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/products`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(rows),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Supabase bulk insert error:', errText);
      return res.status(500).json({ error: 'Failed to save menu items', details: errText });
    }

    const inserted = await insertRes.json();

    return res.status(200).json({
      success: true,
      count: inserted.length,
      items: inserted,
    });

  } catch (error) {
    console.error('parse-menu error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
