/**
 * Shared email sending via Resend API.
 * Used by signup.js and verify-email.js.
 */
export async function sendEmail(to, subject, html, attachments = []) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  console.log('Resend: sending to', to, '| subject:', subject.slice(0, 50));
  try {
    const body = { from: 'Pincer <info@pincerweb.com>', to: [to], subject, html };
    if (attachments.length) body.attachments = attachments;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const respBody = await resp.text();
    if (!resp.ok) {
      console.error('Resend API error:', resp.status, respBody);
    } else {
      console.log('Resend: sent OK to', to, '| response:', respBody);
    }
  } catch (e) {
    console.error('Resend email error:', e.message);
  }
}
