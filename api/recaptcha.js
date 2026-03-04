/**
 * Verify a reCAPTCHA token with Google's API.
 * Supports both v2 (checkbox) and v3 (invisible/score-based).
 * v2: only checks success field.
 * v3: also checks action match and score >= 0.5.
 * If RECAPTCHA_SECRET_KEY is not set, skips verification (allows dev/staging).
 */
export async function verifyRecaptcha(token, expectedAction) {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey) {
    console.warn('RECAPTCHA_SECRET_KEY not set — skipping verification');
    return true;
  }
  if (!token) {
    // Allow requests without token (e.g. dashboard PWA where reCAPTCHA can't load)
    // Rate limiting on endpoints provides brute-force protection as fallback
    return true;
  }
  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (!data.success) {
      console.warn('reCAPTCHA verification failed:', data['error-codes']);
      return false;
    }
    // v3-only checks (v2 responses don't include score or action)
    if (typeof data.score === 'number') {
      if (expectedAction && data.action !== expectedAction) {
        console.warn('reCAPTCHA action mismatch:', data.action, '!==', expectedAction);
        return false;
      }
      if (data.score < 0.5) {
        console.warn('reCAPTCHA score too low:', data.score);
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error('reCAPTCHA verify error:', e.message);
    return true; // Allow on network error to avoid blocking legitimate users
  }
}
