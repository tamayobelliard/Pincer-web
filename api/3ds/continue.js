import https from 'https';
import fs from 'fs';
import path from 'path';

// Cache SSL agent at module level (reused across warm invocations)
let cachedAgent = null;
function getSSLAgent() {
  if (cachedAgent) return cachedAgent;
  const cert = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-chain.pem'));
  const key = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-key.pem'));
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

const AZUL_URL = process.env.AZUL_URL || 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx?processthreedsmethod';

// Fire-and-forget Supabase PATCH (don't block response)
function patchSession(supabaseUrl, supabaseKey, sessionId, data) {
  fetch(
    `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
    }
  ).catch(e => console.error('Session patch error:', e.message));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId, azulOrderId } = req.body;

  if (!sessionId || !azulOrderId) {
    return res.status(400).json({ error: 'Missing sessionId or azulOrderId' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const auth1 = process.env.AZUL_AUTH1 || '3dsecure';
    const auth2 = process.env.AZUL_AUTH2 || '3dsecure';

    // Parallel: get SSL agent + check method notification
    const agentPromise = Promise.resolve(getSSLAgent());
    const sessPromise = fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=method_notification_received`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    ).then(r => r.json()).catch(() => []);

    const [agent, sessRows] = await Promise.all([agentPromise, sessPromise]);
    const methodReceived = sessRows[0]?.method_notification_received === true;

    const requestBody = {
      Channel: "EC",
      Store: process.env.AZUL_MERCHANT_ID,
      AzulOrderId: azulOrderId,
      MethodNotificationStatus: methodReceived ? "RECEIVED" : "EXPECTED_BUT_NOT_RECEIVED",
    };

    const result = await callAzul(AZUL_URL, { 'Auth1': auth1, 'Auth2': auth2 }, requestBody, agent);

    // CASE 1: Approved (frictionless after method)
    if (result.IsoCode === '00') {
      patchSession(supabaseUrl, supabaseKey, sessionId, { status: 'approved', final_response: result });

      return res.status(200).json({
        approved: true,
        authorizationCode: result.AuthorizationCode,
        azulOrderId: result.AzulOrderId,
        customOrderId: result.CustomOrderId,
        message: result.ResponseMessage,
        rrn: result.RRN,
        ticket: result.Ticket,
      });
    }

    // CASE 2: Challenge required
    if (result.ResponseMessage === '3D_SECURE_CHALLENGE' || result.ResponseMessage === '3D_SECURE_2_CHALLENGE') {
      patchSession(supabaseUrl, supabaseKey, sessionId, { status: 'challenge' });

      return res.status(200).json({
        approved: false,
        challengeRequired: true,
        sessionId,
        azulOrderId: result.AzulOrderId || azulOrderId,
        redirectUrl: result.RedirectUrl || '',
        redirectPostData: result.RedirectPostData || '',
      });
    }

    // CASE 3: Declined or error
    patchSession(supabaseUrl, supabaseKey, sessionId, {
      status: result.ResponseCode === 'Error' ? 'error' : 'declined',
      final_response: result,
    });

    return res.status(200).json({
      approved: false,
      isoCode: result.IsoCode,
      message: result.ResponseMessage || result.ErrorDescription || 'Pago rechazado',
    });

  } catch (error) {
    console.error('3ds continue error:', error);
    return res.status(500).json({ error: error.message });
  }
}
