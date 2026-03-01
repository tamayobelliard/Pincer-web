import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY not set — skipping email to', to); return; }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Pincer <info@pincerweb.com>', to: [to], subject, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) console.error('Resend API error:', resp.status, await resp.text());
    else console.log('Resend: sent OK to', to);
  } catch (e) { console.error('Resend email error:', e.message); }
}

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

// ══════════════════════════════════════════════════════════════
// ACTION: restaurants — list + toggle status
// ══════════════════════════════════════════════════════════════
async function handleRestaurants(req, res, supabaseUrl, supabaseKey) {
  // GET — list restaurant users
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?role=eq.restaurant&select=*&order=created_at.desc`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        }
      );
      if (!r.ok) {
        console.error('Supabase GET error:', await r.text());
        return res.status(r.status).json({ error: 'Failed to load restaurants' });
      }
      const raw = await r.json();
      const data = raw.map(({ password_hash, ...rest }) => rest);
      return res.status(200).json(data);
    } catch (error) {
      console.error('restaurants GET error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // PATCH — toggle status
  if (req.method === 'PATCH') {
    const { id, status } = req.body;
    if (!id || !status || !['active', 'pending', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'Valid id and status required' });
    }
    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status }),
        }
      );
      if (!r.ok) {
        console.error('Supabase PATCH error:', await r.text());
        return res.status(r.status).json({ error: 'Failed to update' });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('restaurants PATCH error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ══════════════════════════════════════════════════════════════
// ACTION: create — create new restaurant user
// ══════════════════════════════════════════════════════════════
async function handleCreate(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, business_type, address, phone, contact_name, email, hours, website, notes, chatbot_personality, logo_url, order_types, delivery_fee } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: 'El nombre es requerido' });
  }

  try {
    // Generate username from name (slugify)
    const username = name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 20);

    // Cryptographically secure password generation
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }

    const password_hash = await bcrypt.hash(temp_password, 10);

    // Trial expiry: 30 days from now
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Insert into restaurant_users
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          username,
          password_hash,
          restaurant_slug: username,
          display_name: name,
          role: 'restaurant',
          status: 'pending',
          plan: 'premium',
          trial_expires_at: trialExpires,
          menu_style: { primary_color: '#E8191A', secondary_color: '#C41415', accent_color: '#f4e4c1', font_style: 'modern' },
          business_type: business_type || null,
          address: address || null,
          phone: phone || null,
          contact_name: contact_name || null,
          email: email || null,
          hours: hours || null,
          website: website || null,
          notes: notes || null,
          chatbot_personality: chatbot_personality || 'casual',
          logo_url: logo_url || null,
          order_types: order_types || ["dine_in"],
          delivery_fee: delivery_fee || 0,
        }),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Failed to create restaurant user:', errText);
      if (errText.includes('duplicate') || errText.includes('unique')) {
        return res.status(409).json({ success: false, error: 'Ya existe un usuario con ese nombre' });
      }
      return res.status(500).json({ success: false, error: 'Error al crear usuario' });
    }

    // Send welcome email if email was provided (fire and forget)
    if (email) {
      const dashboardUrl = `https://www.pincerweb.com/${username}/dashboard`;
      const menuUrl = `https://www.pincerweb.com/${username}`;
      const expiryDate = new Date(trialExpires).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });
      sendEmail(
        email,
        `Bienvenido a Pincer — ${name}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;">
          <div style="text-align:center;margin-bottom:20px;">
            <img src="https://i.imgur.com/FaOdU4D.png" alt="Pincer" style="width:48px;height:48px;">
          </div>
          <h1 style="color:#E8191A;text-align:center;margin-bottom:8px;">Bienvenido a Pincer!</h1>
          <p style="text-align:center;color:#64748B;">Tu menu digital esta listo</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#64748B;">Restaurante</td><td style="padding:8px 0;font-weight:bold;">${name}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Email de acceso</td><td style="padding:8px 0;font-weight:bold;">${email}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Contrasena</td><td style="padding:8px 0;font-weight:bold;font-family:monospace;font-size:16px;letter-spacing:1px;">${temp_password}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Dashboard</td><td style="padding:8px 0;"><a href="${dashboardUrl}" style="color:#E8191A;font-weight:bold;">${dashboardUrl}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Tu menu</td><td style="padding:8px 0;"><a href="${menuUrl}" style="color:#E8191A;font-weight:bold;">${menuUrl}</a></td></tr>
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <div style="background:#FFF3F3;padding:14px;border-radius:8px;text-align:center;">
            <p style="color:#E8191A;font-weight:bold;margin:0;">Prueba gratuita de 30 dias</p>
            <p style="color:#64748B;font-size:13px;margin:4px 0 0;">Vence el ${expiryDate}</p>
          </div>
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;text-align:center;">— El equipo de Pincer</p>
        </div>`
      ).catch(e => console.error('Welcome email error:', e.message));
    }

    return res.status(200).json({
      success: true,
      username,
      temp_password,
      display_name: name,
    });

  } catch (error) {
    console.error('create-restaurant error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION: update — update restaurant fields
// ══════════════════════════════════════════════════════════════
async function handleUpdate(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const { id, display_name, business_type, address, phone, contact_name, email, hours, website, notes, chatbot_personality, logo_url, order_types, delivery_fee } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  // Build partial update object from provided fields only
  const update = {};
  if (display_name !== undefined) update.display_name = display_name || null;
  if (business_type !== undefined) update.business_type = business_type || null;
  if (address !== undefined) update.address = address || null;
  if (phone !== undefined) update.phone = phone || null;
  if (contact_name !== undefined) update.contact_name = contact_name || null;
  if (email !== undefined) update.email = email || null;
  if (hours !== undefined) update.hours = hours || null;
  if (website !== undefined) update.website = website || null;
  if (notes !== undefined) update.notes = notes || null;
  if (chatbot_personality !== undefined) update.chatbot_personality = chatbot_personality || 'casual';
  if (logo_url !== undefined) update.logo_url = logo_url || null;
  if (order_types !== undefined) update.order_types = order_types;
  if (delivery_fee !== undefined) update.delivery_fee = delivery_fee;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(update),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      console.error('Supabase PATCH error:', errText);
      return res.status(r.status).json({ error: 'Failed to update restaurant' });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('update-restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION: reset-password — generate new password for restaurant
// ══════════════════════════════════════════════════════════════
async function handleResetPassword(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }

    const password_hash = await bcrypt.hash(temp_password, 10);

    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password_hash }),
      }
    );

    if (!patchRes.ok) {
      console.error('reset-password PATCH error:', await patchRes.text());
      return res.status(500).json({ error: 'Failed to update password' });
    }

    return res.status(200).json({ success: true, temp_password });
  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION: delete — delete restaurant and all associated data
// ══════════════════════════════════════════════════════════════
async function handleDelete(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const { id, restaurant_slug } = req.body;
  if (!id || !restaurant_slug) return res.status(400).json({ error: 'id and restaurant_slug required' });

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  const errors = [];

  // 1. Delete all products for this restaurant
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/products?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, { method: 'DELETE', headers });
    if (!r.ok) errors.push('products: ' + await r.text());
  } catch (e) { errors.push('products: ' + e.message); }

  // 2. Delete all orders for this restaurant
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/orders?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, { method: 'DELETE', headers });
    if (!r.ok) errors.push('orders: ' + await r.text());
  } catch (e) { errors.push('orders: ' + e.message); }

  // 3. Delete restaurant insights
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/restaurant_insights?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}`, { method: 'DELETE', headers });
    if (!r.ok) errors.push('insights: ' + await r.text());
  } catch (e) { errors.push('insights: ' + e.message); }

  // 4. Delete the restaurant user record
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    if (!r.ok) {
      const errText = await r.text();
      errors.push('restaurant_users: ' + errText);
      console.error('delete restaurant_users failed:', errText);
      return res.status(500).json({ error: 'Failed to delete restaurant' });
    }
  } catch (e) {
    errors.push('restaurant_users: ' + e.message);
    return res.status(500).json({ error: 'Failed to delete restaurant' });
  }

  if (errors.length > 0) {
    console.warn('delete restaurant partial errors:', errors);
  }

  return res.status(200).json({ success: true });
}

// ══════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token
  const isAdmin = await verifyAdmin(req.headers['x-admin-key'], supabaseUrl, supabaseKey);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const action = req.query.action;

  switch (action) {
    case 'restaurants':     return handleRestaurants(req, res, supabaseUrl, supabaseKey);
    case 'create':          return handleCreate(req, res, supabaseUrl, supabaseKey);
    case 'update':          return handleUpdate(req, res, supabaseUrl, supabaseKey);
    case 'reset-password':  return handleResetPassword(req, res, supabaseUrl, supabaseKey);
    case 'delete':          return handleDelete(req, res, supabaseUrl, supabaseKey);
    default:
      return res.status(400).json({ error: 'Missing or invalid action parameter' });
  }
}
