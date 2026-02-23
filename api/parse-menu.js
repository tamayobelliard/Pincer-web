export const config = { maxDuration: 60 };

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

// Reusable Claude API call
function callClaude(apiKey, imageContent, textPrompt) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [imageContent, { type: 'text', text: textPrompt }],
      }],
    }),
  });
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

  const { image, restaurant_slug, start_order } = req.body;

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

    const imageContent = {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: imageData },
    };

    const apiKey = process.env.ANTHROPIC_API_KEY;

    // Run item extraction + style detection in parallel
    const [itemsRes, styleRes] = await Promise.all([
      callClaude(apiKey, imageContent,
        'This is a photo of a restaurant menu. Extract all items and return ONLY a JSON array with no extra text. Use the EXACT section/category names visible on the menu (e.g. "Entradas", "Pita Sandwich", "Bebidas", "Shawramas Clásicos") as the category field. Format: [{"name": "Item Name", "price": 350, "category": "Section Name", "description": "Brief description"}]. Price must be an integer in DOP (Dominican Pesos). Description can be empty string if not visible.',
      ),
      callClaude(apiKey, imageContent,
        'Analyze this restaurant menu\'s visual design. Return ONLY a JSON object with no extra text: {"primary_color": "#hex", "secondary_color": "#hex", "background_color": "#hex", "font_style": "modern or classic or casual", "section_names": ["Section 1", "Section 2"]}. Colors should match the dominant colors in the menu design. section_names should list all menu section headings in the order they appear.',
      ),
    ]);

    const [itemsData, styleData] = await Promise.all([
      itemsRes.json(),
      styleRes.json(),
    ]);

    // Process items
    if (!itemsRes.ok) {
      console.error('Claude items API error:', itemsData);
      return res.status(502).json({ error: 'Failed to process image with AI' });
    }

    const rawItemsText = itemsData.content?.find(c => c.type === 'text')?.text || '';

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = rawItemsText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not extract menu items from image', raw: rawItemsText });
    }

    let items;
    try {
      items = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(422).json({ error: 'Invalid JSON from AI response', raw: rawItemsText });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(422).json({ error: 'No menu items detected in image' });
    }

    // Process style (non-critical — don't fail if style extraction fails)
    let menuStyle = null;
    if (styleRes.ok) {
      try {
        const rawStyleText = styleData.content?.find(c => c.type === 'text')?.text || '';
        const styleMatch = rawStyleText.match(/\{[\s\S]*\}/);
        if (styleMatch) menuStyle = JSON.parse(styleMatch[0]);
      } catch (e) {
        console.error('Style parsing error:', e.message);
      }
    }

    const offset = parseInt(start_order) || 0;

    // Build rows for bulk insert (use real categories from menu)
    const rows = items.map((item, i) => ({
      id: `${restaurant_slug}-${(item.name || 'item').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-${offset + i}`,
      name: String(item.name || '').slice(0, 100),
      price: Math.round(Number(item.price)) || 0,
      category: String(item.category || 'General').slice(0, 50),
      description: String(item.description || '').slice(0, 500),
      restaurant_slug,
      active: true,
      sold_out: false,
      display_order: offset + i,
    }));

    // Bulk insert items + save style in parallel
    const promises = [
      fetch(`${supabaseUrl}/rest/v1/products`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(rows),
      }),
    ];

    if (menuStyle) {
      promises.push(
        fetch(`${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ menu_style: menuStyle }),
        }).catch(e => console.error('Style save error:', e.message))
      );
    }

    const [insertRes] = await Promise.all(promises);

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
      menuStyle: menuStyle || null,
    });

  } catch (error) {
    console.error('parse-menu error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
