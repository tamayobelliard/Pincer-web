import bcrypt from 'bcryptjs';

export const config = { maxDuration: 60 };

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  console.log('Resend: sending to', to, '| subject:', subject.slice(0, 50));
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Pincer <info@pincerweb.com>',
        to: [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const respBody = await resp.text();
    if (!resp.ok) {
      console.error('Resend API error:', resp.status, respBody);
    } else {
      console.log('Resend: sent OK to', to, '| response:', respBody);
    }
  } catch (e) {
    console.error('Resend email error:', e.message);
  }
}

// Background: extract menu products from uploaded images using Claude Vision
async function extractMenuFromImages(restaurant_slug, menu_files) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseKey || !anthropicKey) {
    console.error('extractMenu: missing SUPABASE_SERVICE_ROLE_KEY or ANTHROPIC_API_KEY');
    return;
  }

  const imageFiles = menu_files.filter(f => f.type === 'image');
  if (imageFiles.length === 0) return;

  console.log(`extractMenu: processing ${imageFiles.length} image(s) for ${restaurant_slug}`);

  let allItems = [];

  for (const file of imageFiles) {
    try {
      // Fetch image and convert to base64
      const imgRes = await fetch(file.url, { signal: AbortSignal.timeout(15000) });
      if (!imgRes.ok) { console.error('extractMenu: failed to fetch image', file.url); continue; }
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = Buffer.from(imgBuffer).toString('base64');
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

      // Call Claude Haiku with vision
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
              { type: 'text', text: 'Extract all menu items from this image. Return ONLY a JSON array with no extra text. Format: [{"name": "Item Name", "price": 350, "category": "Section Name", "description": "Brief description"}]. Price must be an integer in DOP (Dominican Pesos). If no price visible, use 0.' },
            ],
          }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!claudeRes.ok) { console.error('extractMenu: Claude API error', claudeRes.status); continue; }
      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.find(c => c.type === 'text')?.text || '';

      // Parse JSON array from response
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { console.error('extractMenu: no JSON array in response'); continue; }
      const items = JSON.parse(jsonMatch[0]);
      if (Array.isArray(items)) allItems.push(...items);
    } catch (e) {
      console.error('extractMenu: error processing image:', e.message);
    }
  }

  if (allItems.length === 0) { console.log('extractMenu: no items extracted'); return; }

  // Build product rows (same format as parse-menu.js)
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
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // PATCH: update file URLs after signup
  if (req.method === 'PATCH') {
    const { restaurant_slug, logo_url, menu_files } = req.body || {};
    if (!restaurant_slug) return res.status(400).json({ error: 'Missing restaurant_slug' });

    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseKey) return res.status(500).json({ error: 'Server error' });

    const updates = {};
    if (logo_url) updates.logo_url = logo_url;
    if (menu_files) updates.menu_files = menu_files;

    if (Object.keys(updates).length === 0) return res.status(200).json({ success: true });

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
        console.error('File URL update error:', await patchRes.text());
        return res.status(500).json({ error: 'Error updating files' });
      }

      // Extract menu products from uploaded images (must await to prevent Vercel from killing the function)
      if (Array.isArray(menu_files) && menu_files.some(f => f.type === 'image')) {
        try {
          await extractMenuFromImages(restaurant_slug, menu_files);
        } catch (e) {
          console.error('extractMenu error:', e.message);
          // Don't fail the PATCH — file URLs are already saved
        }
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('File URL PATCH error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    restaurant_name, owner_name, email, phone, password, confirm_password,
    business_type, address, hours, website, logo_url, chatbot_personality,
    order_types, delivery_fee, notes,
    city, // backwards compat
  } = req.body || {};

  // Validate required fields
  if (!restaurant_name || !owner_name || !email || !phone || !password || !confirm_password) {
    return res.status(400).json({ success: false, error: 'Los campos marcados con * son requeridos' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Email no valido' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'La contrasena debe tener al menos 6 caracteres' });
  }
  if (password !== confirm_password) {
    return res.status(400).json({ success: false, error: 'Las contrasenas no coinciden' });
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

    // Generate slug
    let slug = slugify(restaurant_name);
    if (!slug) slug = 'restaurant';

    // Check if slug is taken
    const slugCheck = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: sbHeaders }
    );
    if (slugCheck.ok) {
      const slugRows = await slugCheck.json();
      if (slugRows.length > 0) {
        // Append random digits
        slug = slug.slice(0, 27) + String(Math.floor(Math.random() * 900) + 100);
      }
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Trial expiry: 30 days from now
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Insert into restaurant_users
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
          contact_name: owner_name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          address: (address || city || '').trim() || null,
          business_type: business_type || null,
          hours: hours || null,
          website: website || null,
          logo_url: logo_url || null,
          notes: notes || null,
          role: 'restaurant',
          status: 'active',
          plan: 'premium',
          trial_expires_at: trialExpires,
          chatbot_personality: chatbot_personality || 'casual',
          order_types: Array.isArray(order_types) && order_types.length > 0 ? order_types : ['dine_in'],
          delivery_fee: parseInt(delivery_fee) || 0,
        }),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Insert error:', errText);
      if (errText.includes('duplicate') || errText.includes('unique')) {
        return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este nombre o email' });
      }
      return res.status(500).json({ success: false, error: 'Error al crear la cuenta' });
    }

    // Send welcome email + admin notification (must await to prevent Vercel from killing the function)
    const dashboardUrl = `https://www.pincerweb.com/${slug}/dashboard`;
    await Promise.allSettled([
      sendEmail(
        email,
        'Bienvenido a Pincer — Tu prueba gratuita ha comenzado',
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h1 style="color:#E8191A">Bienvenido a Pincer!</h1>
          <p>Hola <strong>${owner_name}</strong>,</p>
          <p>Tu restaurante <strong>${restaurant_name}</strong> ha sido registrado exitosamente.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p><strong>Tu usuario:</strong> ${slug}</p>
          <p><strong>Dashboard:</strong> <a href="${dashboardUrl}">${dashboardUrl}</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="background:#FFF3F3;padding:12px;border-radius:8px;color:#E8191A;font-weight:bold">
            Tu prueba gratuita de 30 dias ha comenzado. Disfruta de todas las funciones premium!
          </p>
          <p style="color:#888;font-size:12px;margin-top:20px">— El equipo de Pincer</p>
        </div>`
      ),
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
            <li><strong>Direccion:</strong> ${address || city || 'N/A'}</li>
            <li><strong>Website:</strong> ${website || 'N/A'}</li>
            <li><strong>Slug:</strong> ${slug}</li>
          </ul>
        </div>`
      ),
    ]);

    return res.status(200).json({
      success: true,
      restaurant_slug: slug,
      display_name: restaurant_name.trim(),
    });

  } catch (error) {
    console.error('signup error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
