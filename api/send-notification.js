import admin from 'firebase-admin';
import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

// Parse the private key — handles multiple formats from env vars
function parsePrivateKey(raw) {
  if (!raw) throw new Error('FIREBASE_PRIVATE_KEY is not set');
  // If wrapped in quotes (JSON-stringified), unwrap it
  let key = raw;
  if (key.startsWith('"') && key.endsWith('"')) {
    try { key = JSON.parse(key); } catch (e) { /* use as-is */ }
  }
  // Replace literal two-char sequence \n with actual newlines
  key = key.replace(/\\n/g, '\n');
  return key;
}

// Initialize Firebase Admin SDK (once per cold start)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: parsePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    }),
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res, { allowNoOrigin: true })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 30 notifications per minute per IP
  if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: 'notify' })) return;

  // Validate required environment variables
  const requiredEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missingEnv = requiredEnv.filter(k => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error('[send-notification] Missing env vars:', missingEnv.join(', '));
    return res.status(500).json({ error: 'Server misconfigured', missing: missingEnv });
  }

  // Verify webhook secret (allow 'test-from-dashboard' for manual test pushes)
  const webhookSecret = req.headers['x-webhook-secret'];
  const isTest = webhookSecret === 'test-from-dashboard';
  if (!isTest && webhookSecret !== process.env.SUPABASE_WEBHOOK_SECRET) {
    console.error('Invalid webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { type, table, record } = req.body;

    if (type !== 'INSERT' || table !== 'orders') {
      return res.status(200).json({ message: 'Ignored: not an order INSERT' });
    }

    const order = record;
    const orderId = order.id;
    const total = order.total || 0;

    // Parse items for notification body
    let itemsSummary = '';
    try {
      const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
      if (Array.isArray(items)) {
        itemsSummary = items
          .filter(i => !i.id?.startsWith('extra_') && !i.name?.toLowerCase().startsWith('extra '))
          .map(i => `${i.qty}x ${i.name}`)
          .join(', ');
      }
    } catch (e) {
      itemsSummary = 'Ver detalles en el dashboard';
    }

    const restaurantSlug = order.restaurant_slug || 'mrsandwich';
    const orderDisplayNum = order.order_number || orderId;
    const notificationTitle = `Nueva Orden #${orderDisplayNum}`;
    const notificationBody = `RD$${total.toLocaleString('es-DO')} - ${itemsSummary}`;

    // Fetch active FCM tokens for this restaurant from Supabase
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const tokensRes = await fetch(
      `${supabaseUrl}/rest/v1/fcm_tokens?select=token,device_info,updated_at&active=eq.true&restaurant_slug=eq.${encodeURIComponent(restaurantSlug)}`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!tokensRes.ok) {
      console.error('[send-notification] Failed to fetch FCM tokens:', tokensRes.status);
      return res.status(500).json({ error: 'Failed to fetch tokens' });
    }

    const tokenRows = await tokensRes.json();

    // Deactivate zombie tokens (not updated in 30+ days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const zombieTokens = tokenRows.filter(r => r.updated_at < thirtyDaysAgo);
    const freshRows = tokenRows.filter(r => r.updated_at >= thirtyDaysAgo);

    if (zombieTokens.length > 0) {
      console.log(`[send-notification] Deactivating ${zombieTokens.length} zombie token(s) (>30 days stale)`);
      for (const z of zombieTokens) {
        await fetch(
          `${supabaseUrl}/rest/v1/fcm_tokens?token=eq.${encodeURIComponent(z.token)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ active: false }),
          }
        );
      }
    }

    // Build token-to-device map for logging
    const tokenDeviceMap = {};
    freshRows.forEach(r => {
      const info = r.device_info || 'unknown';
      tokenDeviceMap[r.token] = info.length > 50 ? info.substring(0, 50) + '...' : info;
    });

    const tokens = freshRows.map(r => r.token).filter(Boolean);

    console.log(`[send-notification] ${restaurantSlug} order #${orderDisplayNum}: ${tokens.length} device(s), ${zombieTokens.length} zombie(s) cleaned`);

    if (tokens.length === 0) {
      console.warn(`[send-notification] No active FCM tokens for ${restaurantSlug}`);
      return res.status(200).json({ message: 'No devices registered' });
    }

    // Send data-only push (SW's push event handler controls display + sound)
    const dashboardUrl = `/${restaurantSlug}/dashboard/`;
    const message = {
      data: {
        title: notificationTitle,
        body: notificationBody,
        orderId: String(orderId),
        total: String(total),
        restaurantSlug: restaurantSlug,
        url: dashboardUrl,
      },
      tokens: tokens,
      android: {
        priority: 'high',
        ttl: 4 * 60 * 60 * 1000, // 4 hours
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        fcmOptions: {
          link: dashboardUrl,
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    // Log result per token
    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      const device = tokenDeviceMap[tokens[idx]] || 'unknown';
      if (resp.success) {
        console.log(`[send-notification]   OK -> ${device} (${tokens[idx].substring(0, 12)}...)`);
      } else {
        const errorCode = resp.error?.code || 'unknown';
        const errorMsg = resp.error?.message || '';
        console.error(`[send-notification]   FAIL -> ${device} (${tokens[idx].substring(0, 12)}...) ${errorCode}: ${errorMsg}`);
        if (
          errorCode === 'messaging/invalid-registration-token' ||
          errorCode === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    // Deactivate invalid tokens
    if (invalidTokens.length > 0) {
      console.log(`[send-notification] Deactivating ${invalidTokens.length} invalid token(s)`);
      for (const token of invalidTokens) {
        await fetch(
          `${supabaseUrl}/rest/v1/fcm_tokens?token=eq.${encodeURIComponent(token)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ active: false }),
          }
        );
      }
    }

    console.log(`[send-notification] Result: ${response.successCount} sent, ${response.failureCount} failed`);

    return res.status(200).json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
      zombiesCleaned: zombieTokens.length,
    });

  } catch (error) {
    console.error('send-notification error:', error);
    return res.status(500).json({ error: error.message });
  }
}
