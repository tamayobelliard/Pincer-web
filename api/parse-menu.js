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

// Verify signup token: restaurant must have been created within the last 2 hours
async function verifySignupAccess(slug, supabaseUrl, supabaseKey) {
  if (!slug) return false;
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&created_at=gt.${twoHoursAgo}&select=id`,
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
  const content = imageContent
    ? [imageContent, { type: 'text', text: textPrompt }]
    : [{ type: 'text', text: textPrompt }];
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
      messages: [{ role: 'user', content }],
    }),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-signup-slug');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token OR signup access (recently-created restaurant)
  const isAdmin = await verifyAdmin(req.headers['x-admin-key'], supabaseUrl, supabaseKey);
  const signupSlug = req.headers['x-signup-slug'] || '';
  const isSignup = !isAdmin && signupSlug ? await verifySignupAccess(signupSlug, supabaseUrl, supabaseKey) : false;
  if (!isAdmin && !isSignup) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { image, restaurant_slug, start_order, mode, menu_group, url } = req.body;
  const effectiveMode = mode || 'photo';

  if (effectiveMode === 'url') {
    if (!url || !restaurant_slug) {
      return res.status(400).json({ error: 'url and restaurant_slug are required for URL mode' });
    }
  } else {
    if (!image || !restaurant_slug) {
      return res.status(400).json({ error: 'image (base64) and restaurant_slug are required' });
    }
  }

  try {
    // ══════════════════════════════════════════════════════════
    // URL MODE — fetch HTML, extract with Claude text-only
    // ══════════════════════════════════════════════════════════
    if (effectiveMode === 'url') {
      console.log('[parse-menu] URL mode: fetching ' + url);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'Server configuration error: missing API key' });
      }

      let htmlText;
      try {
        const urlRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PincerBot/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        if (!urlRes.ok) {
          return res.status(502).json({ error: 'Failed to fetch URL', details: 'HTTP ' + urlRes.status });
        }
        htmlText = await urlRes.text();
      } catch (fetchErr) {
        return res.status(502).json({ error: 'Failed to fetch URL', details: fetchErr.message });
      }

      if (htmlText.length > 100000) {
        htmlText = htmlText.substring(0, 100000);
        console.log('[parse-menu] HTML truncated to 100KB');
      }
      console.log('[parse-menu] HTML length: ' + htmlText.length);

      const urlPrompt = 'This is the HTML of a restaurant menu page. Extract ALL menu items and return ONLY a JSON object with no extra text: {"items": [{"name": "...", "price": 350, "category": "Section Name", "menu_group": "Menu Name or null", "description": "..."}], "menu_groups": [{"key": "slug", "label": "Original Name", "hours": "if visible or null"}]}. Price must be an integer (remove currency symbols, convert to DOP if needed). menu_group is the top-level menu name if multiple menus exist, or null for single menu. category is the section within that menu. menu_groups lists all distinct menus found. If only one menu, menu_groups should be null.\n\nHTML:\n' + htmlText;

      let claudeRes;
      try {
        claudeRes = await callClaude(apiKey, null, urlPrompt);
      } catch (err) {
        return res.status(502).json({ error: 'Claude API request failed', details: err.message });
      }

      if (!claudeRes.ok) {
        const errData = await claudeRes.json().catch(() => ({}));
        return res.status(502).json({ error: 'Claude API error', details: errData.error?.message || 'Unknown' });
      }

      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';

      const objMatch = rawText.match(/\{[\s\S]*\}/);
      if (!objMatch) {
        return res.status(422).json({ error: 'Could not extract menu data from URL', raw: rawText.substring(0, 500) });
      }

      let parsed;
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch (e) {
        return res.status(422).json({ error: 'Invalid JSON from AI response', raw: rawText.substring(0, 500) });
      }

      const items = parsed.items;
      const menuGroupsConfig = parsed.menu_groups || null;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(422).json({ error: 'No menu items detected from URL' });
      }

      console.log(`[parse-menu] URL mode: ${items.length} items, ${menuGroupsConfig ? menuGroupsConfig.length : 0} menu groups`);

      const rows = items.map((item, i) => ({
        id: `${restaurant_slug}-${(item.name || 'item').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-${i}`,
        name: String(item.name || '').slice(0, 100),
        price: Math.round(Number(item.price)) || 0,
        category: String(item.category || 'General').slice(0, 50),
        description: String(item.description || '').slice(0, 500),
        menu_group: item.menu_group ? String(item.menu_group).slice(0, 50) : null,
        restaurant_slug,
        active: true,
        sold_out: false,
        display_order: i,
      }));

      // Delete ALL existing products for this restaurant
      try {
        await fetch(
          `${supabaseUrl}/rest/v1/products?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`,
          { method: 'DELETE', headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
      } catch (e) {
        console.error('[parse-menu] Delete error:', e.message);
      }

      const insertRes = await fetch(`${supabaseUrl}/rest/v1/products`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation,resolution=merge-duplicates',
        },
        body: JSON.stringify(rows),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return res.status(500).json({ error: 'Failed to save menu items', details: errText });
      }

      const inserted = await insertRes.json();

      // Save menu_groups to restaurant_users
      if (menuGroupsConfig) {
        fetch(`${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ menu_groups: menuGroupsConfig }),
        }).catch(e => console.error('[parse-menu] menu_groups save error:', e.message));
      }

      return res.status(200).json({
        success: true,
        count: inserted.length,
        items: inserted,
        menuGroups: menuGroupsConfig,
      });
    }

    // ══════════════════════════════════════════════════════════
    // PHOTO / MULTI-PHOTO MODE
    // ══════════════════════════════════════════════════════════

    // ── Step 1: Parse base64 image ──
    console.log('[parse-menu] Step 1: parsing base64 image');
    let mediaType = 'image/jpeg';
    let imageData = image;
    if (image.startsWith('data:')) {
      const match = image.match(/^data:(image\/\w+);base64,/);
      if (match) {
        mediaType = match[1];
        imageData = image.slice(match[0].length);
      }
    }
    console.log(`[parse-menu] Image: ${mediaType}, base64 length: ${imageData.length}`);

    const imageContent = {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: imageData },
    };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[parse-menu] ANTHROPIC_API_KEY is not set');
      return res.status(500).json({ error: 'Server configuration error: missing API key' });
    }

    // ── Step 2: Call Claude API (items + style in parallel) ──
    console.log('[parse-menu] Step 2: calling Claude API (2 parallel requests)');
    let itemsRes, styleRes;
    try {
      [itemsRes, styleRes] = await Promise.all([
        callClaude(apiKey, imageContent,
          'This is a photo of a restaurant menu. Extract all items and return ONLY a JSON array with no extra text. Use the EXACT section/category names visible on the menu (e.g. "Entradas", "Pita Sandwich", "Bebidas", "Shawramas Clásicos") as the category field. Format: [{"name": "Item Name", "price": 350, "category": "Section Name", "description": "Brief description"}]. Price must be an integer in DOP (Dominican Pesos). Description can be empty string if not visible.',
        ),
        callClaude(apiKey, imageContent,
          'Analyze this restaurant menu\'s visual design. Return ONLY a JSON object with no extra text: {"primary_color": "#hex", "secondary_color": "#hex", "background_color": "#hex", "font_style": "modern or classic or casual", "section_names": ["Section 1", "Section 2"]}. Colors should match the dominant colors in the menu design. section_names should list all menu section headings in the order they appear.',
        ),
      ]);
    } catch (claudeErr) {
      console.error('[parse-menu] Claude API fetch error:', claudeErr.message);
      return res.status(502).json({ error: 'Claude API request failed', details: claudeErr.message });
    }

    console.log(`[parse-menu] Claude items response status: ${itemsRes.status}`);
    console.log(`[parse-menu] Claude style response status: ${styleRes.status}`);

    // ── Step 3: Parse Claude responses ──
    console.log('[parse-menu] Step 3: parsing Claude responses');
    let itemsData, styleData;
    try {
      [itemsData, styleData] = await Promise.all([
        itemsRes.json(),
        styleRes.json(),
      ]);
    } catch (jsonErr) {
      console.error('[parse-menu] Claude response JSON parse error:', jsonErr.message);
      return res.status(502).json({ error: 'Invalid response from Claude API', details: jsonErr.message });
    }

    if (!itemsRes.ok) {
      console.error('[parse-menu] Claude items API error:', JSON.stringify(itemsData));
      return res.status(502).json({ error: 'Failed to process image with AI', details: itemsData.error?.message || JSON.stringify(itemsData) });
    }

    // ── Step 4: Extract items from Claude text ──
    console.log('[parse-menu] Step 4: extracting items JSON');
    const rawItemsText = itemsData.content?.find(c => c.type === 'text')?.text || '';

    const jsonMatch = rawItemsText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[parse-menu] No JSON array found in response:', rawItemsText.substring(0, 300));
      return res.status(422).json({ error: 'Could not extract menu items from image', raw: rawItemsText });
    }

    let items;
    try {
      items = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[parse-menu] JSON parse error:', e.message, 'raw:', jsonMatch[0].substring(0, 300));
      return res.status(422).json({ error: 'Invalid JSON from AI response', raw: rawItemsText });
    }

    if (!Array.isArray(items) || items.length === 0) {
      console.error('[parse-menu] Empty or non-array items result');
      return res.status(422).json({ error: 'No menu items detected in image' });
    }

    console.log(`[parse-menu] Extracted ${items.length} items`);

    // ── Step 5: Parse style (non-critical) ──
    let menuStyle = null;
    if (styleRes.ok) {
      try {
        const rawStyleText = styleData.content?.find(c => c.type === 'text')?.text || '';
        const styleMatch = rawStyleText.match(/\{[\s\S]*\}/);
        if (styleMatch) {
          menuStyle = JSON.parse(styleMatch[0]);
          console.log('[parse-menu] Style extracted:', JSON.stringify(menuStyle));
        }
      } catch (e) {
        console.error('[parse-menu] Style parsing error:', e.message);
      }
    } else {
      console.error('[parse-menu] Style API failed with status:', styleRes.status);
    }

    // ── Step 6: Build product rows ──
    const offset = parseInt(start_order) || 0;
    console.log(`[parse-menu] Step 6: building rows with offset=${offset}`);

    const rows = items.map((item, i) => ({
      id: `${restaurant_slug}-${(item.name || 'item').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-${offset + i}`,
      name: String(item.name || '').slice(0, 100),
      price: Math.round(Number(item.price)) || 0,
      category: String(item.category || 'General').slice(0, 50),
      description: String(item.description || '').slice(0, 500),
      menu_group: (effectiveMode === 'multi-photo' && menu_group) ? String(menu_group).slice(0, 50) : null,
      restaurant_slug,
      active: true,
      sold_out: false,
      display_order: offset + i,
    }));

    console.log(`[parse-menu] Sample row:`, JSON.stringify(rows[0]));

    // ── Step 7: Delete existing products on first upload, then upsert ──
    if (offset === 0) {
      const deleteUrl = (effectiveMode === 'multi-photo' && menu_group)
        ? `${supabaseUrl}/rest/v1/products?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&menu_group=eq.${encodeURIComponent(menu_group)}`
        : `${supabaseUrl}/rest/v1/products?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`;
      console.log(`[parse-menu] Step 7a: deleting products — mode=${effectiveMode}, menu_group=${menu_group || 'ALL'}`);
      try {
        const delRes = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
            },
          }
        );
        if (!delRes.ok) {
          const delErr = await delRes.text();
          console.error('[parse-menu] Delete existing products failed:', delErr);
        } else {
          console.log('[parse-menu] Existing products deleted');
        }
      } catch (delErr) {
        console.error('[parse-menu] Delete fetch error:', delErr.message);
      }
    }

    console.log('[parse-menu] Step 7b: upserting into Supabase');
    let insertRes;
    try {
      insertRes = await fetch(`${supabaseUrl}/rest/v1/products`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation,resolution=merge-duplicates',
        },
        body: JSON.stringify(rows),
      });
    } catch (fetchErr) {
      console.error('[parse-menu] Supabase products upsert fetch error:', fetchErr.message);
      return res.status(500).json({ error: 'Supabase request failed', details: fetchErr.message });
    }

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error(`[parse-menu] Supabase upsert failed (${insertRes.status}):`, errText);
      return res.status(500).json({ error: 'Failed to save menu items', details: errText });
    }

    const inserted = await insertRes.json();
    console.log(`[parse-menu] Inserted ${inserted.length} products`);

    // Save style to restaurant_users (fire and forget)
    if (menuStyle) {
      console.log('[parse-menu] Saving menu_style to restaurant_users');
      fetch(`${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ menu_style: menuStyle }),
      }).then(r => {
        if (!r.ok) r.text().then(t => console.error('[parse-menu] Style save failed:', t));
        else console.log('[parse-menu] Style saved successfully');
      }).catch(e => console.error('[parse-menu] Style save error:', e.message));
    }

    console.log('[parse-menu] Done — returning success');
    return res.status(200).json({
      success: true,
      count: inserted.length,
      items: inserted,
      menuStyle: menuStyle || null,
    });

  } catch (error) {
    console.error('[parse-menu] UNCAUGHT ERROR:', error.message, error.stack);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
