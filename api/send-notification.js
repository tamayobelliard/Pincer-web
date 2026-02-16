import admin from 'firebase-admin';

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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify webhook secret
  const webhookSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (webhookSecret !== process.env.SUPABASE_WEBHOOK_SECRET) {
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

    const notificationTitle = `Nueva Orden #${orderId}`;
    const notificationBody = `RD$${total.toLocaleString('es-DO')} - ${itemsSummary}`;

    // Fetch active FCM tokens from Supabase
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const tokensRes = await fetch(
      `${supabaseUrl}/rest/v1/fcm_tokens?select=token&active=eq.true`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!tokensRes.ok) {
      console.error('Failed to fetch FCM tokens:', tokensRes.status);
      return res.status(500).json({ error: 'Failed to fetch tokens' });
    }

    const tokenRows = await tokensRes.json();
    const tokens = tokenRows.map(r => r.token).filter(Boolean);

    if (tokens.length === 0) {
      console.log('No FCM tokens registered');
      return res.status(200).json({ message: 'No devices registered' });
    }

    // Send data-only push (SW always controls display)
    const message = {
      data: {
        title: notificationTitle,
        body: notificationBody,
        orderId: String(orderId),
        total: String(total),
      },
      tokens: tokens,
      android: {
        priority: 'high',
        ttl: 60 * 1000,
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        fcmOptions: {
          link: '/restaurant.html',
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`Sent to ${response.successCount}/${tokens.length} devices`);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokens[idx]);
          }
        }
      });

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
      if (invalidTokens.length > 0) {
        console.log(`Deactivated ${invalidTokens.length} invalid tokens`);
      }
    }

    return res.status(200).json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
    });

  } catch (error) {
    console.error('send-notification error:', error);
    return res.status(500).json({ error: error.message });
  }
}
