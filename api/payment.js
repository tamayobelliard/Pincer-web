import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Cache SSL agent at module level (reused across warm invocations)
let cachedAgent = null;
function getSSLAgent() {
  if (cachedAgent) return cachedAgent;
  const cert = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-chain.pem'));
  const key = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-key.pem'));
  cachedAgent = new https.Agent({ cert, key, rejectUnauthorized: true, keepAlive: true });
  return cachedAgent;
}

// Call Azul API using native https.request (fetch doesn't support mTLS agent)
function callAzul(url, headers, body, agent, timeoutMs = 8000) {
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

// TEMP: hardcoded to pruebas for 3DS testing
const AZUL_URL = 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx';

// Fire-and-forget Supabase helpers (don't block response to client)
const sbUrl = () => process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = (key) => ({ 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });

function supabasePostFire(table, data) {
  const key = sbKey();
  fetch(`${sbUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(key), 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(4000),
  }).catch(e => console.error(`supabase POST ${table} error:`, e.message));
}

function supabasePatchFire(table, matchCol, matchVal, data) {
  const key = sbKey();
  fetch(`${sbUrl()}/rest/v1/${table}?${matchCol}=eq.${encodeURIComponent(matchVal)}`, {
    method: 'PATCH',
    headers: sbHeaders(key),
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(4000),
  }).catch(e => console.error(`supabase PATCH ${table} error:`, e.message));
}

// Awaited version only when we need the result before responding
async function supabasePostAwait(table, data) {
  const key = sbKey();
  const r = await fetch(`${sbUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(key), 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) console.error(`supabase POST ${table} error:`, await r.text());
  return r;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      cardNumber,
      expiration,
      cvc,
      amount,
      itbis,
      customOrderId,
      customerName,
      customerPhone,
      browserInfo,
    } = req.body;

    // Validate required fields
    if (!cardNumber || !expiration || !cvc || !amount) {
      return res.status(400).json({ error: 'Missing required fields: cardNumber, expiration, cvc, amount' });
    }

    // Generate unique session ID for 3DS tracking
    const sessionId = crypto.randomUUID();

    // Cleanup stale sessions (fire and forget)
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const supabaseUrl = sbUrl();
    const supabaseKey = sbKey();
    fetch(`${supabaseUrl}/rest/v1/sessions_3ds?created_at=lt.${cutoff}&status=neq.approved`, {
      method: 'DELETE',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
    }).catch(() => {});

    // Base URL for callbacks
    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';

    // Build Azul request with 3DS
    const azulRequest = {
      Channel: "EC",
      Store: process.env.AZUL_MERCHANT_ID,
      CardNumber: cardNumber.replace(/\s/g, ''),
      Expiration: expiration,
      CVC: cvc,
      PosInputMode: "E-Commerce",
      TrxType: "Sale",
      Amount: String(amount),
      Itbis: String(itbis || "000"),
      CurrencyPosCode: "$",
      Payments: "1",
      Plan: "0",
      AcquirerRefData: "1",
      RRN: null,
      CustomerServicePhone: "",
      OrderNumber: "",
      ECommerceUrl: baseUrl,
      CustomOrderId: customOrderId || "",
      DataVaultToken: "",
      SaveToDataVault: "0",
      ForceNo3DS: "",
      AltMerchantName: "",
      CardHolderInfo: {
        Name: customerName || "",
        PhoneMobile: customerPhone || "",
      },
      ThreeDSAuth: {
        TermUrl: `${baseUrl}/api/3ds/callback?session=${sessionId}`,
        MethodNotificationUrl: `${baseUrl}/api/3ds/method-notify?session=${sessionId}`,
        RequestorChallengeIndicator: "01",
      },
      BrowserInfo: {
        AcceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        IPAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || '0.0.0.0',
        Language: browserInfo?.language || 'es-DO',
        ColorDepth: String(browserInfo?.colorDepth || 24),
        ScreenHeight: String(browserInfo?.screenHeight || 920),
        ScreenWidth: String(browserInfo?.screenWidth || 412),
        TimeZone: String(browserInfo?.timeZoneOffset || 240),
        UserAgent: req.headers['user-agent'] || '',
        JavaEnabled: "false",
        JavaScriptEnabled: "true",
      },
    };

    // TEMP: hardcoded for 3DS testing
    const auth1 = '3dsecure';
    const auth2 = '3dsecure';

    const agent = getSSLAgent();

    console.log('AZUL REQUEST:', JSON.stringify(azulRequest));

    const result = await callAzul(AZUL_URL, { 'Auth1': auth1, 'Auth2': auth2 }, azulRequest, agent);

    console.log('AZUL RAW RESPONSE:', JSON.stringify(result));

    // Save 3DS session (awaited — we need it created before continue/callback reference it)
    await supabasePostAwait('sessions_3ds', {
      session_id: sessionId,
      azul_order_id: result.AzulOrderId || null,
      custom_order_id: customOrderId || null,
      status: 'initiated',
      method_notification_received: false,
      final_response: result,
    });

    // CASE 1: Direct approval (frictionless)
    if (result.IsoCode === '00') {
      supabasePatchFire('sessions_3ds', 'session_id', sessionId, {
        status: 'approved',
        final_response: result,
      });
      return res.status(200).json({
        success: true,
        approved: true,
        authorizationCode: result.AuthorizationCode,
        azulOrderId: result.AzulOrderId,
        customOrderId: result.CustomOrderId,
        message: result.ResponseMessage,
        rrn: result.RRN,
        ticket: result.Ticket,
      });
    }

    // CASE 2: 3DS Method required (hidden iframe)
    if (result.ResponseMessage === '3D_SECURE_2_METHOD') {
      supabasePatchFire('sessions_3ds', 'session_id', sessionId, {
        status: '3ds_method',
        azul_order_id: result.AzulOrderId,
      });
      return res.status(200).json({
        success: true,
        approved: false,
        threeDSMethod: true,
        sessionId,
        azulOrderId: result.AzulOrderId,
        methodForm: result.ThreeDSMethod?.MethodForm || '',
      });
    }

    // CASE 3: Challenge required
    if (result.ResponseMessage === '3D_SECURE_CHALLENGE' || result.ResponseMessage === '3D_SECURE_2_CHALLENGE') {
      supabasePatchFire('sessions_3ds', 'session_id', sessionId, {
        status: 'challenge',
        azul_order_id: result.AzulOrderId,
      });
      return res.status(200).json({
        success: true,
        approved: false,
        challengeRequired: true,
        sessionId,
        azulOrderId: result.AzulOrderId,
        redirectUrl: result.RedirectUrl || '',
        redirectPostData: result.RedirectPostData || '',
      });
    }

    // CASE 4: Error or declined
    const status = result.ResponseCode === 'Error' ? 'error' : 'declined';
    supabasePatchFire('sessions_3ds', 'session_id', sessionId, {
      status,
      final_response: result,
    });

    if (result.ResponseCode === 'Error') {
      return res.status(200).json({
        success: false,
        approved: false,
        error: result.ErrorDescription,
        message: 'Error del sistema',
      });
    }

    return res.status(200).json({
      success: false,
      approved: false,
      isoCode: result.IsoCode,
      message: result.ResponseMessage || 'Tarjeta declinada',
    });

  } catch (error) {
    console.error('payment error:', error);
    return res.status(500).json({ error: error.message });
  }
}
