import https from 'https';
import fs from 'fs';
import path from 'path';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

// Cache SSL agent at module level
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

// Fire-and-forget Supabase PATCH
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

// Escape for safe JS string interpolation in HTML script blocks
function escJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const sessionId = req.query.session;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return res.status(400).send('Invalid session');
  }

  const cRes = req.body?.cRes || req.body?.cres || req.body?.CRes || '';

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // Parallel: get agent + fetch session
    const [agent, sessRows] = await Promise.all([
      Promise.resolve(getSSLAgent()),
      fetch(
        `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=azul_order_id`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
          signal: AbortSignal.timeout(3000),
        }
      ).then(r => r.json()),
    ]);

    if (!sessRows.length) {
      return res.status(404).send('Session not found');
    }
    const azulOrderId = sessRows[0].azul_order_id;

    const auth1 = process.env.AZUL_AUTH1 || '3dsecure';
    const auth2 = process.env.AZUL_AUTH2 || '3dsecure';

    const result = await callAzul(
      AZUL_URL,
      { 'Auth1': auth1, 'Auth2': auth2 },
      {
        Channel: "EC",
        Store: process.env.AZUL_MERCHANT_ID,
        AzulOrderId: azulOrderId,
        CRes: cRes,
      },
      agent
    );

    const approved = result.IsoCode === '00';

    // Fire-and-forget session update
    patchSession(supabaseUrl, supabaseKey, sessionId, {
      status: approved ? 'approved' : 'declined',
      cres: cRes,
      final_response: result,
    });

    const safeSession = escJs(sessionId);
    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';
    const redirectUrl = `${baseUrl}/mrsandwich?3ds_session=${encodeURIComponent(sessionId)}&3ds_result=${approved ? 'approved' : 'declined'}`;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Procesando...</title></head>
<body>
<p>Procesando resultado del pago...</p>
<script>
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: '3ds_challenge_complete',
      session: '${safeSession}',
      approved: ${approved},
      result: ${JSON.stringify({
        authorizationCode: result.AuthorizationCode || '',
        azulOrderId: result.AzulOrderId || '',
        customOrderId: result.CustomOrderId || '',
        message: result.ResponseMessage || '',
        rrn: result.RRN || '',
        ticket: result.Ticket || '',
        isoCode: result.IsoCode || '',
      })}
    }, '${escJs(ALLOWED_ORIGIN)}');
  } else {
    window.location.href = '${escJs(redirectUrl)}';
  }
</script>
</body></html>`);

  } catch (error) {
    console.error('3ds callback error:', error);

    patchSession(supabaseUrl, supabaseKey, sessionId, {
      status: 'error',
      final_response: { error: error.message },
    });

    const safeSession = escJs(sessionId);
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html>
<html><body>
<p>Error procesando el pago. Puedes cerrar esta ventana.</p>
<script>
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: '3ds_challenge_complete', session: '${safeSession}', approved: false }, '${escJs(ALLOWED_ORIGIN)}');
  }
</script>
</body></html>`);
  }
}
