/**
 * Strip sensitive fields from a restaurant_users row before returning to clients.
 * Apply this to every API response that includes restaurant data.
 *
 * @param {object} row - A restaurant_users record from Supabase
 * @returns {object} - Sanitized copy with sensitive fields removed
 */
export function sanitizeRestaurant(row) {
  if (!row || typeof row !== 'object') return row;
  const {
    password_hash,
    email_verification_token,
    azul_merchant_id,
    azul_merchant_name,
    azul_auth_hash,
    ...safe
  } = row;
  return safe;
}
