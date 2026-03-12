/**
 * Parse a specific cookie value from the Cookie header.
 * @param {string} cookieHeader - Raw Cookie header string
 * @param {string} name - Cookie name to find
 * @returns {string|null}
 */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Extract restaurant session token from request.
 * Checks x-restaurant-token header first, then pincer_session cookie.
 */
export function getRestaurantToken(req) {
  return req.headers['x-restaurant-token'] || parseCookie(req.headers.cookie, 'pincer_session') || null;
}

/**
 * Extract admin session token from request.
 * Checks x-admin-key header first, then pincer_admin cookie.
 */
export function getAdminToken(req) {
  return req.headers['x-admin-key'] || parseCookie(req.headers.cookie, 'pincer_admin') || null;
}

/**
 * Verify a restaurant session token against the restaurant_sessions table.
 * Mirrors the verifyAdmin() pattern in api/admin.js.
 *
 * @param {string} token - Session token from header or cookie
 * @param {string} supabaseUrl
 * @param {string} supabaseKey - Service role key
 * @returns {Promise<{valid: boolean, restaurant_slug: string|null, user_id: string|null}>}
 */
export async function verifyRestaurantSession(token, supabaseUrl, supabaseKey) {
  if (!token) return { valid: false, restaurant_slug: null, user_id: null };
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_sessions?token=eq.${encodeURIComponent(token)}&expires_at=gt.${new Date().toISOString()}&select=user_id,restaurant_slug`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!r.ok) return { valid: false, restaurant_slug: null, user_id: null };
    const rows = await r.json();
    if (rows.length === 0) return { valid: false, restaurant_slug: null, user_id: null };
    return { valid: true, restaurant_slug: rows[0].restaurant_slug, user_id: rows[0].user_id };
  } catch {
    return { valid: false, restaurant_slug: null, user_id: null };
  }
}
