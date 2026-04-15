import https from 'https';
import fs from 'fs';
import path from 'path';
import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { getRestaurantToken, verifyRestaurantSession } from './verify-session.js';

// Reuse the same mTLS agent as payment.js / 3ds.js
let cachedAgent = null;
function getSSLAgent() {
  if (cachedAgent) return cachedAgent;
  const cert = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-chain.pem'));
  const key = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-key-prod.pem'));
  cachedAgent = new https.Agent({ cert, key, rejectUnauthorized: true, keepAlive: true });
  return cachedAgent;
}

function callAzul(url, headers, body, agent, timeoutMs = 9500) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      agent,
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Azul timeout')); });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const AZUL_URL = process.env.AZUL_URL || 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx';
const AZUL_VOID_URL = AZUL_URL + (AZUL_URL.includes('?') ? '&' : '?') + 'ProcessVoid';

const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'void-payment' })) return;

  try {
    // Authenticate restaurant session
    const token = getRestaurantToken(req);
    const supabaseUrl = sbUrl();
    const supabaseKey = sbKey();
    const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
    if (!session.valid) {
      return res.status(401).json({ error: 'Sesión inválida' });
    }

    const { orderId, voidedItems } = req.body;
    if (!orderId || !Number.isInteger(Number(orderId))) {
      return res.status(400).json({ error: 'orderId requerido' });
    }
    const voidedItemsText = typeof voidedItems === 'string' ? voidedItems.substring(0, 500) : null;

    // Fetch the order — must belong to this restaurant, be in 'accepted' status, and have azul_order_id
    const orderRes = await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&restaurant_slug=eq.${encodeURIComponent(session.restaurant_slug)}&select=id,status,azul_order_id,restaurant_slug`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!orderRes.ok) {
      return res.status(500).json({ error: 'Error consultando la orden' });
    }
    const orders = await orderRes.json();
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const order = orders[0];
    const voidableStatuses = ['pending', 'paid', 'accepted'];
    if (!voidableStatuses.includes(order.status)) {
      return res.status(400).json({ error: 'Esta orden ya no puede ser anulada' });
    }
    if (!order.azul_order_id) {
      return res.status(400).json({ error: 'Esta orden no tiene pago con tarjeta' });
    }

    // Look up merchant ID for this restaurant (same pattern as payment.js)
    let merchantId = process.env.AZUL_MERCHANT_ID || null;
    try {
      const mRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(session.restaurant_slug)}&status=eq.active&select=azul_merchant_id&limit=1`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }, signal: AbortSignal.timeout(3000) }
      );
      if (mRes.ok) {
        const rows = await mRes.json();
        if (rows.length > 0 && rows[0].azul_merchant_id) {
          merchantId = rows[0].azul_merchant_id;
        }
      }
    } catch (e) {
      console.error('Merchant ID lookup error:', e.message);
    }

    if (!merchantId) {
      return res.status(400).json({ error: 'Pagos no configurados para este restaurante' });
    }

    // TEST MODE: simulate successful void
    if (merchantId === 'SQUAREONE_TEST') {
      console.log(`[void] TEST MODE for ${session.restaurant_slug}: orderId=${orderId}`);
      await fetch(
        `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&restaurant_slug=eq.${encodeURIComponent(session.restaurant_slug)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(supabaseKey),
          body: JSON.stringify({ status: 'voided', voided_at: new Date().toISOString(), voided_items: voidedItemsText }),
        }
      );
      return res.status(200).json({ success: true, testMode: true });
    }

    // Call Azul ProcessVoid
    const auth1 = process.env.AZUL_AUTH1 || '3dsecure';
    const auth2 = process.env.AZUL_AUTH2 || '3dsecure';
    const agent = getSSLAgent();

    const result = await callAzul(
      AZUL_VOID_URL,
      { 'Auth1': auth1, 'Auth2': auth2 },
      {
        Channel: 'EC',
        Store: merchantId,
        AzulOrderId: order.azul_order_id,
      },
      agent
    );

    console.log(`[void] orderId=${orderId} azulOrderId=${order.azul_order_id} result:`, JSON.stringify(result));

    if (result.IsoCode === '00') {
      // Void successful — update order status
      await fetch(
        `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&restaurant_slug=eq.${encodeURIComponent(session.restaurant_slug)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(supabaseKey),
          body: JSON.stringify({ status: 'voided', voided_at: new Date().toISOString(), voided_items: voidedItemsText }),
        }
      );
      return res.status(200).json({ success: true });
    }

    // Void failed
    console.error(`[void] FAILED orderId=${orderId}:`, result.ErrorDescription || result.ResponseMessage || 'Unknown error');
    return res.status(200).json({
      success: false,
      error: result.ErrorDescription || result.ResponseMessage || 'No se pudo anular el pago. Intenta de nuevo.',
    });

  } catch (error) {
    console.error('void-payment error:', error);
    return res.status(500).json({ error: 'Error procesando la anulación.' });
  }
}
