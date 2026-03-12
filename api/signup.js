import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { verifyRecaptcha } from './recaptcha.js';
import { sendEmail } from './send-email.js';
import { handleCors, requireJson } from './cors.js';

export const config = { maxDuration: 60 };

// ── Predefined themes (same as parse-menu.js) ──
const THEMES = {
  'rojo-clasico':      { theme: 'rojo-clasico',      bg: '#1a1a1a', primary: '#E8191A', text: '#ffffff', accent: '#ffffff' },
  'negro-elegante':    { theme: 'negro-elegante',    bg: '#0d0d0d', primary: '#E8191A', text: '#ffffff', accent: '#f5f5f5' },
  'cafe-moderno':      { theme: 'cafe-moderno',      bg: '#faf6f1', primary: '#8B4513', text: '#2c1810', accent: '#d4a574' },
  'verde-fresco':      { theme: 'verde-fresco',      bg: '#f8fffe', primary: '#2d7a4f', text: '#1a3d2b', accent: '#4caf50' },
  'azul-profesional':  { theme: 'azul-profesional',  bg: '#f8faff', primary: '#1a4fa0', text: '#0d2748', accent: '#2196f3' },
};
const DEFAULT_THEME = THEMES['rojo-clasico'];

// Helper: call Claude API
function callClaude(apiKey, imageContent, textPrompt, maxTokens) {
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 2000,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(30000),
  });
}

// Extract menu products + style from uploaded images/PDFs using Claude Vision
async function extractMenuFromImages(restaurant_slug, menu_files) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseKey || !anthropicKey) {
    console.error('extractMenu: missing SUPABASE_SERVICE_ROLE_KEY or ANTHROPIC_API_KEY');
    return;
  }

  const supportedFiles = menu_files.filter(f => f.type === 'image' || f.type === 'pdf');
  if (supportedFiles.length === 0) return;

  console.log(`extractMenu: processing ${supportedFiles.length} file(s) for ${restaurant_slug} (images: ${supportedFiles.filter(f=>f.type==='image').length}, PDFs: ${supportedFiles.filter(f=>f.type==='pdf').length})`);

  let allItems = [];
  let menuStyle = null;

  for (const file of supportedFiles) {
    try {
      let claudeContent; // The content block to send to Claude (image or document)

      if (file.type === 'pdf') {
        // Handle PDF files
        let base64;
        if (file.url && file.url.startsWith('data:')) {
          const match = file.url.match(/^data:application\/pdf;base64,(.+)$/);
          if (!match) { console.error('extractMenu: invalid PDF data URI'); continue; }
          base64 = match[1];
          console.log('extractMenu: parsed PDF data URI, base64 length:', base64.length);
        } else {
          console.log('extractMenu: fetching PDF:', file.url);
          const pdfRes = await fetch(file.url, { signal: AbortSignal.timeout(15000) });
          if (!pdfRes.ok) { console.error('extractMenu: failed to fetch PDF', file.url, 'status:', pdfRes.status); continue; }
          const pdfBuffer = await pdfRes.arrayBuffer();
          base64 = Buffer.from(pdfBuffer).toString('base64');
          console.log('extractMenu: PDF fetched, base64 length:', base64.length);
        }
        claudeContent = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
      } else {
        // Handle image files
        let base64, contentType;
        if (file.url && file.url.startsWith('data:')) {
          const match = file.url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (!match) { console.error('extractMenu: invalid image data URI'); continue; }
          contentType = match[1];
          base64 = match[2];
          console.log('extractMenu: parsed image data URI, base64 length:', base64.length);
        } else {
          console.log('extractMenu: fetching image:', file.url);
          const imgRes = await fetch(file.url, { signal: AbortSignal.timeout(15000) });
          if (!imgRes.ok) { console.error('extractMenu: failed to fetch image', file.url, 'status:', imgRes.status); continue; }
          const imgBuffer = await imgRes.arrayBuffer();
          base64 = Buffer.from(imgBuffer).toString('base64');
          contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          console.log('extractMenu: image fetched, base64 length:', base64.length);
        }
        claudeContent = { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } };
      }

      // Items extraction + theme picking in parallel (theme only for first image, skip for PDFs)
      const requests = [
        callClaude(anthropicKey, claudeContent,
          'Extract all menu items from this ' + (file.type === 'pdf' ? 'PDF document' : 'image') + '. Return ONLY a JSON array with no extra text. Format: [{"name": "Item Name", "price": 350, "category": "Section Name", "description": "Brief description"}]. Price must be an integer in DOP (Dominican Pesos). If no price visible, use 0.',
          2000,
        ),
      ];

      if (!menuStyle && file.type === 'image') {
        requests.push(
          callClaude(anthropicKey, claudeContent,
            'Look at the dominant colors in this restaurant menu image. Choose the BEST matching theme from this list:\n- rojo-clasico (red/dark, bold restaurant)\n- negro-elegante (black/dark, upscale)\n- cafe-moderno (warm browns, coffee/bakery)\n- verde-fresco (greens, healthy/fresh)\n- azul-profesional (blues, professional/corporate)\nReturn ONLY the theme name, nothing else.',
            100,
          ),
        );
      }

      const results = await Promise.all(requests);

      // Parse items response
      const claudeRes = results[0];
      if (!claudeRes.ok) { console.error('extractMenu: Claude items API error', claudeRes.status); continue; }
      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';

      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { console.error('extractMenu: no JSON array in response'); continue; }
      const items = JSON.parse(jsonMatch[0]);
      if (Array.isArray(items)) {
        allItems.push(...items);
        console.log(`extractMenu: extracted ${items.length} items from ${file.type}`);
      }

      // Parse theme response (only for images)
      if (results[1] && !menuStyle) {
        try {
          if (results[1].ok) {
            const themeData = await results[1].json();
            const themeText = themeData.content?.find(c => c.type === 'text')?.text || '';
            const themeName = themeText.trim().toLowerCase().replace(/[^a-z-]/g, '');
            if (THEMES[themeName]) {
              menuStyle = THEMES[themeName];
              console.log('extractMenu: theme picked:', themeName);
            } else {
              menuStyle = DEFAULT_THEME;
              console.log('extractMenu: theme not recognized:', themeText.trim(), '— using default');
            }
          } else {
            console.error('extractMenu: theme API error', results[1].status);
            menuStyle = DEFAULT_THEME;
          }
        } catch (e) {
          console.error('extractMenu: theme parse error:', e.message);
          menuStyle = DEFAULT_THEME;
        }
      }
    } catch (e) {
      console.error('extractMenu: error processing file:', e.message);
    }
  }

  // Save menu_style to restaurant_users (overrides default Pincer red)
  if (menuStyle) {
    console.log('extractMenu: saving menu_style for', restaurant_slug);
    try {
      const styleRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ menu_style: menuStyle }),
        }
      );
      if (!styleRes.ok) {
        console.error('extractMenu: style save failed:', await styleRes.text());
      } else {
        console.log('extractMenu: menu_style saved successfully');
      }
    } catch (e) {
      console.error('extractMenu: style save error:', e.message);
    }
  }

  if (allItems.length === 0) { console.log('extractMenu: no items extracted'); return; }

  const rows = allItems.map((item, i) => ({
    id: `${restaurant_slug}-${(item.name || 'item').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-${i}`,
    name: String(item.name || '').slice(0, 100),
    price: Math.round(Number(item.price)) || 0,
    category: String(item.category || 'General').slice(0, 50),
    description: String(item.description || '').slice(0, 500),
    restaurant_slug,
    active: true,
    sold_out: false,
    display_order: i,
  }));

  console.log(`extractMenu: inserting ${rows.length} products for ${restaurant_slug}`);

  try {
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
      console.error('extractMenu: insert error', await insertRes.text());
    } else {
      const inserted = await insertRes.json();
      console.log(`extractMenu: inserted ${inserted.length} products`);
    }
  } catch (e) {
    console.error('extractMenu: insert fetch error', e.message);
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'POST, PATCH, OPTIONS' })) return;

  if (requireJson(req, res)) return;

  // Rate limit: 5 signup attempts per minute per IP
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'signup' })) return;

  // ── PATCH: update logo (base64) or file URLs after signup ──
  if (req.method === 'PATCH') {
    const { restaurant_slug, logo_base64, logo_url, menu_files } = req.body || {};
    if (!restaurant_slug) return res.status(400).json({ error: 'Missing restaurant_slug' });

    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseKey) return res.status(500).json({ error: 'Server error' });

    console.log('PATCH signup:', restaurant_slug, '| logo_base64:', !!logo_base64, '| logo_url:', !!logo_url, '| menu_files:', Array.isArray(menu_files) ? menu_files.length : 0);

    const updates = {};

    // Upload logo base64 to Supabase Storage using service role key
    if (logo_base64) {
      try {
        const match = logo_base64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) {
          console.error('PATCH: invalid logo_base64 format');
          return res.status(400).json({ error: 'Invalid logo format' });
        }
        const contentType = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        const storagePath = `logos/${restaurant_slug}.jpg`;

        console.log('PATCH: uploading logo to Storage, size:', buffer.length);
        const uploadRes = await fetch(
          `${supabaseUrl}/storage/v1/object/product-images/${storagePath}`,
          {
            method: 'PUT',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': contentType,
              'x-upsert': 'true',
            },
            body: buffer,
          }
        );
        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          console.error('PATCH: Storage upload failed:', uploadRes.status, errText);
        } else {
          updates.logo_url = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}?t=${Date.now()}`;
          console.log('PATCH: logo uploaded, URL:', updates.logo_url);
        }
      } catch (e) {
        console.error('PATCH: logo upload error:', e.message);
      }
    } else if (logo_url) {
      updates.logo_url = logo_url;
    }

    if (menu_files) updates.menu_files = menu_files;

    if (Object.keys(updates).length === 0) { console.log('PATCH: no updates to apply'); return res.status(200).json({ success: true }); }

    try {
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(updates),
        }
      );
      if (!patchRes.ok) {
        const errBody = await patchRes.text();
        console.error('PATCH update error:', patchRes.status, errBody);
        return res.status(500).json({ error: 'Error updating files' });
      }
      console.log('PATCH: successfully updated', restaurant_slug, '| fields:', Object.keys(updates).join(', '));

      // Extract menu products + style from uploaded images/PDFs
      if (Array.isArray(menu_files) && menu_files.some(f => f.type === 'image' || f.type === 'pdf')) {
        try {
          await extractMenuFromImages(restaurant_slug, menu_files);
        } catch (e) {
          console.error('extractMenu error:', e.message);
        }
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('File URL PATCH error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  // ── POST: create restaurant (mirrors admin handleCreate logic) ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    restaurant_name, owner_name, email, phone,
    business_type, address, hours, website, logo_url, chatbot_personality,
    order_types, delivery_fee, notes, recaptchaToken,
  } = req.body || {};

  // Verify reCAPTCHA v3 (skipped if secret key not configured)
  if (!await verifyRecaptcha(recaptchaToken, 'signup')) {
    return res.status(403).json({ success: false, error: 'Verificación de seguridad fallida. Intenta de nuevo.' });
  }

  // Validate required fields
  if (!restaurant_name) {
    return res.status(400).json({ success: false, error: 'El nombre del negocio es requerido' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Un email valido es requerido' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Check if email already exists
    const emailCheck = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      { headers: sbHeaders }
    );
    if (!emailCheck.ok) {
      console.error('Email check error:', emailCheck.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    const existing = await emailCheck.json();
    if (existing.length > 0) {
      return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este email' });
    }

    // Generate username from name (same slugify as admin handleCreate)
    const username = restaurant_name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 20);

    let slug = username || 'restaurant';

    // Check if slug is taken — append random digits if so
    const slugCheck = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: sbHeaders }
    );
    if (slugCheck.ok) {
      const slugRows = await slugCheck.json();
      if (slugRows.length > 0) {
        slug = slug.slice(0, 17) + String(Math.floor(Math.random() * 900) + 100);
      }
    }

    // Auto-generate secure password (same pattern as admin.js handleCreate)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }
    const password_hash = await bcrypt.hash(temp_password, 12);

    // Email verification token
    const emailVerificationToken = randomBytes(32).toString('hex');

    // Trial expiry: 30 days from now
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Insert into restaurant_users (same structure as admin handleCreate + signup extras)
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users`,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          username: slug,
          password_hash,
          restaurant_slug: slug,
          display_name: restaurant_name.trim(),
          role: 'restaurant',
          status: 'active',
          plan: 'premium',
          trial_expires_at: trialExpires,
          business_type: business_type || null,
          address: address || null,
          phone: (phone || '').trim() || null,
          contact_name: (owner_name || '').trim() || null,
          email: email.trim().toLowerCase(),
          hours: hours || null,
          website: website || null,
          notes: notes || null,
          chatbot_personality: chatbot_personality || 'casual',
          logo_url: logo_url || null,
          menu_style: DEFAULT_THEME,
          order_types: Array.isArray(order_types) && order_types.length > 0 ? order_types : ['dine_in'],
          delivery_fee: parseInt(delivery_fee) || 0,
          email_verified: false,
          email_verification_token: emailVerificationToken,
          must_change_password: true,
          welcome_email_sent: false,
        }),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Failed to create restaurant user:', errText);
      if (errText.includes('duplicate') || errText.includes('unique')) {
        return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este nombre o email' });
      }
      return res.status(500).json({ success: false, error: 'Error al crear la cuenta' });
    }

    // Create store_settings row (default open)
    fetch(`${supabaseUrl}/rest/v1/store_settings`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ id: slug, is_open: true }),
    }).catch(() => {});

    // Send admin notification only (confirmation email sent by client after menu upload)
    const dashboardUrl = `https://www.pincerweb.com/${slug}/dashboard`;
    const menuUrl = `https://www.pincerweb.com/${slug}`;
    sendEmail(
      'info@pincerweb.com',
      `Nuevo restaurante registrado: ${restaurant_name}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2>Nuevo registro</h2>
        <ul>
          <li><strong>Restaurante:</strong> ${restaurant_name}</li>
          <li><strong>Tipo:</strong> ${business_type || 'N/A'}</li>
          <li><strong>Contacto:</strong> ${owner_name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Telefono:</strong> ${phone}</li>
          <li><strong>Direccion:</strong> ${address || 'N/A'}</li>
          <li><strong>Website:</strong> ${website || 'N/A'}</li>
          <li><strong>Slug:</strong> ${slug}</li>
          <li><strong>Menu:</strong> <a href="${menuUrl}">${menuUrl}</a></li>
          <li><strong>Dashboard:</strong> <a href="${dashboardUrl}">${dashboardUrl}</a></li>
        </ul>
      </div>`
    ).catch(e => console.error('Admin notification error:', e.message));

    return res.status(200).json({
      success: true,
      restaurant_slug: slug,
      display_name: restaurant_name.trim(),
      email_verification_token: emailVerificationToken,
    });

  } catch (error) {
    console.error('signup error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
