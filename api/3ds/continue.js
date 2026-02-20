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

function getBaseUrl() {
  const isDev = process.env.AZUL_ENV === 'development';
  return isDev
    ? 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx'
    : 'https://pagos.azul.com.do/WebServices/JSON/default.aspx';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';

  try {
    const isDev = process.env.AZUL_ENV === 'development';
    const auth1 = isDev ? '3dsecure' : process.env.AZUL_AUTH1;
    const auth2 = isDev ? '3dsecure' : process.env.AZUL_AUTH2;

    const agent = getSSLAgent();

    // Second call to Azul after 3DS Method completed
    const result = await callAzul(
      getBaseUrl(),
      { 'Auth1': auth1, 'Auth2': auth2 },
      {
        Channel: "EC",
        Store: process.env.AZUL_MERCHANT_ID,
        AzulOrderId: azulOrderId,
        TermUrl: `${baseUrl}/api/3ds/callback?session=${sessionId}`,
        TrxType: "Sale",
      },
      agent
    );

    console.log('Azul 3DS continue response:', JSON.stringify(result).substring(0, 500));

    // CASE 1: Approved (frictionless after method)
    if (result.IsoCode === '00') {
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
            status: 'approved',
            final_response: result,
            updated_at: new Date().toISOString(),
          }),
        }
      );

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
            status: 'challenge',
            updated_at: new Date().toISOString(),
          }),
        }
      );

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
          status: result.ResponseCode === 'Error' ? 'error' : 'declined',
          final_response: result,
          updated_at: new Date().toISOString(),
        }),
      }
    );

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
