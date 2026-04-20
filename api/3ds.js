import https from 'https';
import fs from 'fs';
import path from 'path';
import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

// Cache SSL agent at module level (reused across warm invocations)
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

const AZUL_BASE = process.env.AZUL_URL || 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx';
const AZUL_URL_3DS_METHOD = AZUL_BASE + (AZUL_BASE.includes('?') ? '&' : '?') + 'processthreedsmethod';
// Azul uses two distinct operations in its 3DS 2.0 flow, each appended as a
// query param: ?processthreedsmethod for the post-fingerprinting step, and
// ?processthreedschallenge for the post-SMS Challenge completion. Posting the
// CRes to the base URL without this marker makes Azul treat it as a brand-new
// payment request and reject with VALIDATION_ERROR:CVC because CardNumber/CVC
// aren't present. Reference: indexa-git/pyazul (pyazul/services/secure.py uses
// operation="processthreedschallenge" for its process_challenge call).
const AZUL_URL_3DS_CHALLENGE = AZUL_BASE + (AZUL_BASE.includes('?') ? '&' : '?') + 'processthreedschallenge';

// Awaited Supabase PATCH. Previously this was fire-and-forget, but Vercel
// serverless functions may suspend the event loop once the response is sent,
// cancelling in-flight fetches. During the 2026-04-20 Azul ?processthreedschallenge
// test the DB row never moved past 'status=3ds_method' even though Azul approved
// the payment with auth_code 022684 — Vercel logs showed "Session patch error:
// fetch failed", confirming the fetch was aborted after the response.
//
// Awaiting here adds ~200ms before the response is flushed, which is invisible
// to the user (they're watching the "Procesando..." page). In exchange the
// sessions_3ds row reliably reflects the true state for reporting / auditoría
// / conciliación with Azul.
async function patchSession(supabaseUrl, supabaseKey, sessionId, data) {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('Session patch failed:', r.status, body, 'session_id:', sessionId);
    }
  } catch (e) {
    console.error('Session patch error:', e.message, 'session_id:', sessionId);
  }
}

// Escape for safe JS string interpolation in HTML script blocks
function escJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}

// ══════════════════════════════════════════════════════════════
// ACTION: callback
// ══════════════════════════════════════════════════════════════
async function handleCallback(req, res) {
  const sessionId = req.query.session;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return res.status(400).send('Invalid session');
  }

  const cRes = req.body?.cRes || req.body?.cres || req.body?.CRes || '';

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const [agent, sessRows] = await Promise.all([
      Promise.resolve(getSSLAgent()),
      fetch(
        `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=azul_order_id,azul_merchant_id`,
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
    const azulMerchantId = sessRows[0].azul_merchant_id;

    // Fail loud if the session was created without a merchant (should never happen
    // post-fix; can only happen for legacy rows created before the Apr 17 fix).
    if (!azulMerchantId) {
      console.error('3ds callback: missing azul_merchant_id', {
        ts: new Date().toISOString(),
        session_id: sessionId,
        azul_order_id: azulOrderId,
      });
      return res.status(500).send('Session missing merchant — contact support');
    }

    const auth1 = process.env.AZUL_AUTH1 || '3dsecure';
    const auth2 = process.env.AZUL_AUTH2 || '3dsecure';

    const result = await callAzul(
      AZUL_URL_3DS_CHALLENGE,
      { 'Auth1': auth1, 'Auth2': auth2 },
      {
        Channel: "EC",
        Store: azulMerchantId,
        AzulOrderId: azulOrderId,
        CRes: cRes,
      },
      agent
    );

    const approved = result.IsoCode === '00';

    await patchSession(supabaseUrl, supabaseKey, sessionId, {
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
        errorDescription: result.ErrorDescription || '',
        responseCode: result.ResponseCode || '',
      })}
    }, '${escJs(ALLOWED_ORIGIN)}');
  } else {
    window.location.href = '${escJs(redirectUrl)}';
  }
</script>
</body></html>`);

  } catch (error) {
    console.error('3ds callback error:', error);

    await patchSession(supabaseUrl, supabaseKey, sessionId, {
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

// ══════════════════════════════════════════════════════════════
// ACTION: continue
// ══════════════════════════════════════════════════════════════
async function handleContinue(req, res) {
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

    const [agent, sessRows] = await Promise.all([
      Promise.resolve(getSSLAgent()),
      fetch(
        `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=method_notification_received,azul_merchant_id`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
          signal: AbortSignal.timeout(3000),
        }
      ).then(r => r.json()).catch(() => []),
    ]);
    const methodReceived = sessRows[0]?.method_notification_received === true;
    const azulMerchantId = sessRows[0]?.azul_merchant_id;

    // Fail loud if merchant is missing on the session (legacy row or schema mismatch).
    if (!azulMerchantId) {
      console.error('3ds continue: missing azul_merchant_id', {
        ts: new Date().toISOString(),
        session_id: sessionId,
        azul_order_id: azulOrderId,
      });
      return res.status(500).json({ error: 'Session missing merchant. Restart payment.' });
    }

    const requestBody = {
      Channel: "EC",
      Store: azulMerchantId,
      AzulOrderId: azulOrderId,
      MethodNotificationStatus: methodReceived ? "RECEIVED" : "EXPECTED_BUT_NOT_RECEIVED",
    };

    const result = await callAzul(AZUL_URL_3DS_METHOD, { 'Auth1': auth1, 'Auth2': auth2 }, requestBody, agent);

    // CASE 1: Approved (frictionless after method)
    if (result.IsoCode === '00') {
      await patchSession(supabaseUrl, supabaseKey, sessionId, { status: 'approved', final_response: result });

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
      await patchSession(supabaseUrl, supabaseKey, sessionId, { status: 'challenge' });

      // 3DS 2.0 uses ThreeDSChallenge object, 3DS 1.0 uses top-level RedirectUrl
      const challenge = result.ThreeDSChallenge || {};
      return res.status(200).json({
        approved: false,
        challengeRequired: true,
        sessionId,
        azulOrderId: result.AzulOrderId || azulOrderId,
        redirectUrl: challenge.RedirectPostUrl || result.RedirectUrl || '',
        redirectPostData: challenge.CReq || result.RedirectPostData || '',
      });
    }

    // CASE 3: Declined or error
    await patchSession(supabaseUrl, supabaseKey, sessionId, {
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
    return res.status(500).json({ error: 'Error procesando el pago. Intenta de nuevo.' });
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION: method-notify
// ══════════════════════════════════════════════════════════════
async function handleMethodNotify(req, res) {
  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).send('Missing session');
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const r = await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method_notification_received: true,
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!r.ok) {
      console.error('method-notify patch failed:', r.status, 'session_id:', sessionId);
    }
  } catch (err) {
    console.error('method-notify supabase error:', err.message, 'session_id:', sessionId);
  }

  // Return minimal HTML — the ACS expects a 200 response
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send('<html><body>OK</body></html>');
}

// ══════════════════════════════════════════════════════════════
// ACTION: status
// ══════════════════════════════════════════════════════════════
async function handleStatus(req, res) {
  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing session' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const r = await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=status,method_notification_received,final_response`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!r.ok) {
      console.error('3ds status supabase error:', r.status);
      return res.status(500).json({ error: 'DB error' });
    }

    const rows = await r.json();
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = rows[0];
    const fr = session.final_response;

    // Return only non-sensitive fields (no auth codes, tickets, RRN)
    const safeResponse = (session.status === 'approved' || session.status === 'declined' || session.status === 'error') && fr
      ? { isoCode: fr.IsoCode, message: fr.ResponseMessage, responseCode: fr.ResponseCode }
      : null;

    return res.status(200).json({
      status: session.status,
      methodReceived: session.method_notification_received,
      finalResponse: safeResponse,
    });

  } catch (error) {
    console.error('3ds status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ══════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════

// 3DS ACS providers that POST back to our method-notify and callback endpoints.
// Visa (vcas.visa.com) runs device fingerprinting and posts the method notification;
// Cardinal Commerce (cardinalcommerce.com) hosts the challenge page and posts CRes back.
// Azul subdomains are included defensively in case they ever post server-to-server
// with an Origin header to our callbacks.
const THREEDS_ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.vcas\.visa\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*cardinalcommerce\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*azul\.com\.do$/i,
];

export default async function handler(req, res) {
  if (handleCors(req, res, {
    methods: 'GET, POST, OPTIONS',
    allowNoOrigin: true,
    extraAllowedOriginPatterns: THREEDS_ALLOWED_ORIGIN_PATTERNS,
  })) return;

  const action = req.query.action;

  // Split rate limits per action. method-notify is a webhook from Visa ACS
  // (methodurl.vcas.visa.com) — rate-limiting it by IP caused a 429 during
  // the 2026-04-20 Azul 3DS test, which left method_notification_received=false
  // and degraded the 3DS risk signal sent to the issuer. Webhooks from known
  // ACS origins should not share a bucket with user-facing actions.
  //
  // callback is ALSO a browser redirect from Cardinal Commerce (challenge page),
  // but it's safer to keep some limit on it to guard against replay attempts.
  // continue and status are invoked by the customer's browser during the flow
  // (status is polled), so they deserve separate, higher buckets.
  if (action === 'continue' || action === 'status') {
    if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: '3ds-' + action })) return;
  } else if (action === 'callback') {
    if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: '3ds-callback' })) return;
  }
  // action === 'method-notify' passes without rate limit — it's a webhook.

  switch (action) {
    case 'callback':      return handleCallback(req, res);
    case 'continue':      return handleContinue(req, res);
    case 'method-notify': return handleMethodNotify(req, res);
    case 'status':        return handleStatus(req, res);
    default:
      return res.status(400).json({ error: 'Missing or invalid action parameter' });
  }
}
