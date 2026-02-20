import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Read PEM certificates from project files
function getSSLAgent() {
  const cert = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-chain.pem'));
  const key = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-key.pem'));

  return new https.Agent({
    cert,
    key,
    rejectUnauthorized: true
  });
}

// Call Azul API using native https.request (fetch doesn't support mTLS agent)
function callAzul(url, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      agent,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Azul API base URL
// TEMP: hardcoded to pruebas for 3DS testing
function getBaseUrl() {
  return 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx';
}

// Supabase helper
async function supabasePost(table, data) {
  const url = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) console.error(`supabase POST ${table} error:`, await r.text());
  return r;
}

async function supabasePatch(table, matchCol, matchVal, data) {
  const url = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/rest/v1/${table}?${matchCol}=eq.${encodeURIComponent(matchVal)}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) console.error(`supabase PATCH ${table} error:`, await r.text());
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
        CardHolderName: customerName || "",
        CardHolderPhoneNumber: customerPhone || "",
      },
      ThreeDSAuth: {
        TermUrl: `${baseUrl}/api/3ds/callback?session=${sessionId}`,
        MethodNotificationUrl: `${baseUrl}/api/3ds/method-notify?session=${sessionId}`,
      },
      BrowserInfo: {
        AcceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        IPAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || '0.0.0.0',
        Language: browserInfo?.language || 'es-DO',
        ColorDepth: String(browserInfo?.colorDepth || 24),
        ScreenHeight: String(browserInfo?.screenHeight || 920),
        ScreenWidth: String(browserInfo?.screenWidth || 412),
        TimeZoneOffset: String(browserInfo?.timeZoneOffset || 240),
        UserAgent: req.headers['user-agent'] || '',
        JavaEnabled: "false",
        JavaScriptEnabled: "true",
      },
    };

    // TEMP: hardcoded for 3DS testing
    const auth1 = '3dsecure';
    const auth2 = '3dsecure';

    // Call Azul API with mTLS
    const agent = getSSLAgent();

    console.log('AZUL REQUEST:', JSON.stringify(azulRequest));

    const result = await callAzul(
      getBaseUrl(),
      { 'Auth1': auth1, 'Auth2': auth2 },
      azulRequest,
      agent
    );

    console.log('AZUL RAW RESPONSE:', JSON.stringify(result));

    // Save 3DS session in Supabase
    await supabasePost('sessions_3ds', {
      session_id: sessionId,
      azul_order_id: result.AzulOrderId || null,
      custom_order_id: customOrderId || null,
      status: 'initiated',
      method_notification_received: false,
      final_response: result,
    });

    // CASE 1: Direct approval (frictionless, no further action)
    if (result.IsoCode === '00') {
      await supabasePatch('sessions_3ds', 'session_id', sessionId, {
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
      await supabasePatch('sessions_3ds', 'session_id', sessionId, {
        status: '3ds_method',
        azul_order_id: result.AzulOrderId,
      });
      return res.status(200).json({
        success: true,
        approved: false,
        threeDSMethod: true,
        sessionId,
        azulOrderId: result.AzulOrderId,
        methodForm: result.ThreeDSMethodData || result.MethodForm || '',
        methodUrl: result.ThreeDSMethodURL || '',
      });
    }

    // CASE 3: Challenge required (user must authenticate with bank)
    if (result.ResponseMessage === '3D_SECURE_CHALLENGE' || result.ResponseMessage === '3D_SECURE_2_CHALLENGE') {
      await supabasePatch('sessions_3ds', 'session_id', sessionId, {
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
    if (result.ResponseCode === 'Error') {
      await supabasePatch('sessions_3ds', 'session_id', sessionId, {
        status: 'error',
        final_response: result,
      });
      return res.status(200).json({
        success: false,
        approved: false,
        error: result.ErrorDescription,
        message: 'Error del sistema',
      });
    }

    // Declined
    await supabasePatch('sessions_3ds', 'session_id', sessionId, {
      status: 'declined',
      final_response: result,
    });
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
