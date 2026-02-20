import https from 'https';
import fs from 'fs';
import path from 'path';

function getSSLAgent() {
  const cert = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-chain.pem'));
  const key = fs.readFileSync(path.join(process.cwd(), 'certs', 'azul-key.pem'));
  return new https.Agent({ cert, key, rejectUnauthorized: true });
}

function callAzul(url, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      agent,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// TEMP: hardcoded to pruebas for 3DS testing
function getBaseUrl() {
  return 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx?processthreedsmethod';
}

export default async function handler(req, res) {
  // This endpoint receives POST from the ACS after the 3DS challenge.
  // The bank redirects the user here with cRes data.

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).send('Missing session');
  }

  // cRes comes in the POST body (form-urlencoded or JSON)
  const cRes = req.body?.cRes || req.body?.cres || req.body?.CRes || '';

  console.log('3DS callback received for session:', sessionId, 'cRes length:', cRes.length);

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // Get session from DB to find the AzulOrderId
    const sessRes = await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=azul_order_id`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );
    const sessions = await sessRes.json();
    if (!sessions.length) {
      return res.status(404).send('Session not found');
    }
    const azulOrderId = sessions[0].azul_order_id;

    // Call Azul ProcessThreeDSChallenge
    // TEMP: hardcoded for 3DS testing
    const auth1 = '3dsecure';
    const auth2 = '3dsecure';

    const agent = getSSLAgent();
    const result = await callAzul(
      getBaseUrl(),
      { 'Auth1': auth1, 'Auth2': auth2 },
      {
        Channel: "EC",
        Store: process.env.AZUL_MERCHANT_ID,
        AzulOrderId: azulOrderId,
        CRes: cRes,
      },
      agent
    );

    console.log('Azul challenge result:', JSON.stringify(result).substring(0, 500));

    // Update session in DB
    const approved = result.IsoCode === '00';
    await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: approved ? 'approved' : 'declined',
          cres: cRes,
          final_response: result,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    // Redirect user back to the menu with result
    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';
    const redirectUrl = `${baseUrl}/mrsandwich?3ds_session=${sessionId}&3ds_result=${approved ? 'approved' : 'declined'}`;

    // Return an HTML page that posts the result to the parent window, then redirects
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Procesando...</title></head>
<body>
<p>Procesando resultado del pago...</p>
<script>
  // Notify parent window if in iframe
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: '3ds_challenge_complete',
      session: '${sessionId}',
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
    }, '*');
  } else {
    window.location.href = '${redirectUrl}';
  }
</script>
</body></html>`);

  } catch (error) {
    console.error('3ds callback error:', error);

    // Update session as error
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'error',
            final_response: { error: error.message },
            updated_at: new Date().toISOString(),
          }),
        }
      );
    } catch (e) { /* ignore */ }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html>
<html><body>
<p>Error procesando el pago. Puedes cerrar esta ventana.</p>
<script>
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: '3ds_challenge_complete', session: '${sessionId}', approved: false }, '*');
  }
</script>
</body></html>`);
  }
}
