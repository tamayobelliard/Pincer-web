import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

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

  const { name, business_type, address, phone, contact_name, email, hours, website, notes } = req.body;

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
          business_type: business_type || null,
          address: address || null,
          phone: phone || null,
          contact_name: contact_name || null,
          email: email || null,
          hours: hours || null,
          website: website || null,
          notes: notes || null,
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

  const { id, display_name, business_type, address, phone, contact_name, email, hours, website, notes } = req.body;

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
// ROUTER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
    default:
      return res.status(400).json({ error: 'Missing or invalid action parameter' });
  }
}
