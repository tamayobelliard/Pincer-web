import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { generateQRPdf } from './generate-qr-pdf.js';
import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { getAdminToken, hashToken } from './verify-session.js';
import { sanitizeRestaurant } from './sanitize.js';
import { stripExif } from './strip-exif.js';
import { checkEnvSafety } from './env-check.js';

async function sendEmail(to, subject, html, attachments = []) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY not set — skipping email to', to); return; }
  try {
    const body = { from: 'Pincer <info@pincerweb.com>', to: [to], subject, html };
    if (attachments.length) body.attachments = attachments;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) console.error('Resend API error:', resp.status, await resp.text());
    else console.log('Resend: sent OK to', to);
  } catch (e) { console.error('Resend email error:', e.message); }
}

// Verify admin session token against Supabase
async function verifyAdmin(token, supabaseUrl, supabaseKey) {
  if (!token) return false;
  try {
    const tokenH = hashToken(token);
    const r = await fetch(
      `${supabaseUrl}/rest/v1/admin_sessions?token_hash=eq.${encodeURIComponent(tokenH)}&expires_at=gt.${new Date().toISOString()}&select=user_id`,
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

// Verify admin + return user_id so the handler can use it for impersonation.
async function verifyAdminWithUserId(token, supabaseUrl, supabaseKey) {
  if (!token) return null;
  try {
    const tokenH = hashToken(token);
    const r = await fetch(
      `${supabaseUrl}/rest/v1/admin_sessions?token_hash=eq.${encodeURIComponent(tokenH)}&expires_at=gt.${new Date().toISOString()}&select=user_id`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (rows.length === 0) return null;
    return rows[0].user_id;
  } catch { return null; }
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
      const data = raw.map(sanitizeRestaurant);
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

  const { name, business_type, address, phone, contact_name, email, hours, website, notes, chatbot_personality, logo_url, logo_base64, order_types, delivery_fee, azul_merchant_id } = req.body;

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

    const password_hash = await bcrypt.hash(temp_password, 12);

    // Upload logo from base64 if provided
    let finalLogoUrl = logo_url || null;
    if (logo_base64) {
      try {
        const match = logo_base64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          const contentType = match[1];
          const rawBuffer = Buffer.from(match[2], 'base64');
          const buffer = stripExif(rawBuffer);
          const storagePath = `logos/${username}.jpg`;
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
          if (uploadRes.ok) {
            finalLogoUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}?t=${Date.now()}`;
          } else {
            console.error('Logo upload failed:', uploadRes.status);
          }
        }
      } catch (e) {
        console.error('Logo upload error:', e.message);
      }
    }

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
          // Creates with email → 'active' directly (supply-chain admin con creds del cliente).
          // Creates without email → 'demo' (Tamayo arma antes de cerrar venta; transfer endpoint
          // lo mueve a 'active' cuando hay email real). RLS anon permite ambos en menu público.
          status: email ? 'active' : 'demo',
          plan: 'premium',
          trial_expires_at: trialExpires,
          menu_style: { theme: 'rojo-clasico', bg: '#1a1a1a', primary: '#E8191A', text: '#ffffff', accent: '#ffffff' },
          business_type: business_type || null,
          address: address || null,
          phone: phone || null,
          contact_name: contact_name || null,
          email: email || null,
          hours: hours || null,
          website: website || null,
          notes: notes || null,
          chatbot_personality: chatbot_personality || 'casual',
          logo_url: finalLogoUrl,
          order_types: order_types || ["dine_in"],
          delivery_fee: delivery_fee || 0,
          azul_merchant_id: azul_merchant_id || null,
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

    // Create store_settings row (default open) — fire and forget
    fetch(`${supabaseUrl}/rest/v1/store_settings`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ id: username, is_open: true }),
    }).catch(() => {});

    // Generate QR PDF and send welcome email if email was provided (fire and forget)
    if (email) {
      let qrAttachments = [];
      try {
        const qrPdfBase64 = await generateQRPdf(username, name, logo_url || null);
        qrAttachments = [{ filename: `QR-${username}.pdf`, content: qrPdfBase64 }];
      } catch (e) {
        console.error('QR PDF generation error:', e.message);
      }

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
        </div>`,
        qrAttachments
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

  const { id, display_name, business_type, address, phone, contact_name, email, hours, website, notes, chatbot_personality, logo_url, logo_base64, order_types, delivery_fee, azul_merchant_id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  // Upload logo from base64 if provided
  let resolvedLogoUrl = logo_url;
  if (logo_base64) {
    try {
      const match = logo_base64.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        // Look up restaurant_slug for the storage path
        const slugRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}&select=restaurant_slug&limit=1`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const slugRows = slugRes.ok ? await slugRes.json() : [];
        const slug = slugRows.length > 0 ? slugRows[0].restaurant_slug : id;

        const contentType = match[1];
        const rawBuffer = Buffer.from(match[2], 'base64');
        const buffer = stripExif(rawBuffer);
        const storagePath = `logos/${slug}.jpg`;
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
        if (uploadRes.ok) {
          resolvedLogoUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}?t=${Date.now()}`;
        } else {
          console.error('Logo upload failed:', uploadRes.status);
        }
      }
    } catch (e) {
      console.error('Logo upload error:', e.message);
    }
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
  if (resolvedLogoUrl !== undefined) update.logo_url = resolvedLogoUrl || null;
  if (order_types !== undefined) update.order_types = order_types;
  if (delivery_fee !== undefined) update.delivery_fee = delivery_fee;
  if (azul_merchant_id !== undefined) update.azul_merchant_id = azul_merchant_id || null;

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
// ACTION: transfer — move a demo restaurant to production
// Expects: id (restaurant_users row), email (cliente real), phone (opcional),
//          + cualquier otro campo editable para ajustar antes de transfer.
// Requiere: email no vacío (la transferencia no puede ocurrir sin destinatario).
// Efecto: status → 'active', genera password temporal nuevo, envía welcome email
//         con credenciales al email del cliente.
// ══════════════════════════════════════════════════════════════
async function handleTransferToProd(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, email, phone, contact_name } = req.body;

  if (!id) return res.status(400).json({ success: false, error: 'id requerido' });
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ success: false, error: 'email del cliente requerido (válido)' });
  }

  try {
    // Verify current state: debe ser un demo para poder transferir
    const currentRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}&select=username,restaurant_slug,display_name,logo_url,trial_expires_at,status&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    if (!currentRes.ok) return res.status(500).json({ success: false, error: 'DB lookup error' });
    const rows = await currentRes.json();
    if (!rows.length) return res.status(404).json({ success: false, error: 'Restaurante no encontrado' });

    const current = rows[0];
    if (current.status !== 'demo') {
      return res.status(400).json({
        success: false,
        error: `Solo restaurantes en estado 'demo' pueden transferirse (actual: ${current.status})`,
      });
    }

    // Generate new temp password (el password original del demo se descarta)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }
    const password_hash = await bcrypt.hash(temp_password, 12);

    // Update: status→active, guardar email + password nuevo + phone/contact opcionales
    const update = {
      status: 'active',
      email,
      password_hash,
      must_change_password: true,
    };
    if (phone !== undefined) update.phone = phone || null;
    if (contact_name !== undefined) update.contact_name = contact_name || null;

    const patchRes = await fetch(
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
    if (!patchRes.ok) {
      console.error('transfer PATCH error:', await patchRes.text());
      return res.status(500).json({ success: false, error: 'Error actualizando el restaurante' });
    }

    // Welcome email con credenciales (reusa el helper sendEmail de este archivo)
    const username = current.username;
    const name = current.display_name;
    const dashboardUrl = `https://www.pincerweb.com/${username}/dashboard`;
    const menuUrl = `https://www.pincerweb.com/${username}`;
    const expiryDate = current.trial_expires_at
      ? new Date(current.trial_expires_at).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';

    // QR PDF (opcional)
    let qrAttachments = [];
    try {
      const qrPdfBase64 = await generateQRPdf(username, name, current.logo_url || null);
      qrAttachments = [{ filename: `QR-${username}.pdf`, content: qrPdfBase64 }];
    } catch (e) {
      console.error('transfer: QR PDF generation error:', e.message);
    }

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
        ${expiryDate ? `<div style="background:#FFF3F3;padding:14px;border-radius:8px;text-align:center;">
          <p style="color:#E8191A;font-weight:bold;margin:0;">Prueba gratuita de 30 dias</p>
          <p style="color:#64748B;font-size:13px;margin:4px 0 0;">Vence el ${expiryDate}</p>
        </div>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:24px;text-align:center;">— El equipo de Pincer</p>
      </div>`,
      qrAttachments
    ).catch(e => console.error('transfer welcome email error:', e.message));

    return res.status(200).json({
      success: true,
      username,
      restaurant_slug: current.restaurant_slug,
      email,
    });
  } catch (error) {
    console.error('transfer error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
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

    const password_hash = await bcrypt.hash(temp_password, 12);

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
// ACTION: impersonate — create a restaurant_sessions row under
// the target slug on behalf of the admin user. Requires the admin
// user to have is_pincer_staff=true on their restaurant_users row.
// Sets the pincer_session cookie and responds with { redirect }.
// The frontend navigates the browser to that URL, arriving at the
// dashboard already authenticated for the target restaurant.
// ══════════════════════════════════════════════════════════════
async function handleImpersonate(req, res, supabaseUrl, supabaseKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug } = req.body;
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9_-]{2,50}$/.test(slug)) {
    return res.status(400).json({ error: 'slug requerido (slug válido)' });
  }

  // Re-verify admin session AND fetch admin's user_id (we need it for the new session row).
  // Note: handler() already verified via verifyAdmin at the top; we re-query here to get the user_id.
  const adminUserId = await verifyAdminWithUserId(getAdminToken(req), supabaseUrl, supabaseKey);
  if (!adminUserId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Gate crítico: el admin user debe tener is_pincer_staff=true.
  // Sin este flag, la impersonación está prohibida aunque sea admin.
  try {
    const staffRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(adminUserId)}&select=is_pincer_staff,username&limit=1`,
      {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!staffRes.ok) return res.status(500).json({ error: 'DB error verifying staff flag' });
    const rows = await staffRes.json();
    if (!rows.length || rows[0].is_pincer_staff !== true) {
      return res.status(403).json({ error: 'Impersonation requires is_pincer_staff' });
    }
  } catch {
    return res.status(500).json({ error: 'DB error' });
  }

  // Verify target slug exists (any status — incluso suspended se puede impersonar para soporte)
  try {
    const targetRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!targetRes.ok) return res.status(500).json({ error: 'DB error verifying target' });
    const rows = await targetRes.json();
    if (!rows.length) return res.status(404).json({ error: 'Target restaurant not found' });
  } catch {
    return res.status(500).json({ error: 'DB error' });
  }

  // Create restaurant_sessions row. user_id = admin's user_id (Tamayo). restaurant_slug = target.
  // token_hash = SHA-256 del token aleatorio que vamos a set en el cookie.
  const rawToken = randomBytes(32).toString('hex');
  const tokenH = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  try {
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_sessions`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          token_hash: tokenH,
          user_id: adminUserId,
          restaurant_slug: slug,
          expires_at: expiresAt,
        }),
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!insertRes.ok) {
      console.error('impersonate session insert error:', await insertRes.text());
      return res.status(500).json({ error: 'Failed to create session' });
    }
  } catch (e) {
    console.error('impersonate session insert exception:', e.message);
    return res.status(500).json({ error: 'DB error' });
  }

  // Set pincer_session cookie + return redirect URL. Frontend navigates.
  const maxAge = 24 * 60 * 60;
  res.setHeader('Set-Cookie', `pincer_session=${rawToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
  return res.status(200).json({
    success: true,
    redirect: `/${slug}/dashboard`,
  });
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
  checkEnvSafety();
  if (handleCors(req, res, { methods: 'GET, POST, PATCH, DELETE, OPTIONS', headers: 'Content-Type, x-admin-key' })) return;

  if (requireJson(req, res)) return;

  // Rate limit: 30 admin requests per minute per IP
  if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: 'admin' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token
  const isAdmin = await verifyAdmin(getAdminToken(req), supabaseUrl, supabaseKey);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const action = req.query.action;

  switch (action) {
    case 'restaurants':     return handleRestaurants(req, res, supabaseUrl, supabaseKey);
    case 'create':          return handleCreate(req, res, supabaseUrl, supabaseKey);
    case 'update':          return handleUpdate(req, res, supabaseUrl, supabaseKey);
    case 'transfer':        return handleTransferToProd(req, res, supabaseUrl, supabaseKey);
    case 'impersonate':     return handleImpersonate(req, res, supabaseUrl, supabaseKey);
    case 'reset-password':  return handleResetPassword(req, res, supabaseUrl, supabaseKey);
    case 'delete':          return handleDelete(req, res, supabaseUrl, supabaseKey);
    default:
      return res.status(400).json({ error: 'Missing or invalid action parameter' });
  }
}
