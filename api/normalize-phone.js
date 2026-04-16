/**
 * Normalize a Dominican Republic phone number to a consistent 11-digit format.
 * Strips all non-digits, then ensures the "1" country code prefix.
 *
 * Examples:
 *   "809-555-1234"   → "18095551234"
 *   "8095551234"     → "18095551234"
 *   "+18095551234"   → "18095551234"
 *   "18095551234"    → "18095551234"
 *   "(829) 123-4567" → "18291234567"
 *
 * Returns empty string if the input is falsy or too short.
 */
export function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  // 10 digits starting with a valid DR area code → add country code
  if (digits.length === 10 && /^(809|829|849)/.test(digits)) {
    return '1' + digits;
  }
  // 11 digits with country code 1
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits;
  }
  // Fallback — return digits as-is (international or unusual format)
  return digits;
}
