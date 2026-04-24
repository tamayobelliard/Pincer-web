// Token generator para QR de mesa.
//
// 32 chars base62 = log2(62^32) ≈ 190 bits de entropía. Inadivinable
// por fuerza bruta (más seguro que UUIDv4). Base62 (solo [0-9A-Za-z])
// es URL-safe sin encoding y no genera ambigüedad por símbolos como
// '-' o '_' en screenshots/impresiones del QR.
//
// Módulo-bias: 62 divide 256 con residuo 8, así que hay un ligero sesgo
// hacia los primeros 8 valores del alfabeto (~0.4% más probables). A
// 190 bits de entropía, irrelevante para el threat model.
//
// Archivos con prefijo `_` no se deployan como endpoint en Vercel —
// puro helper importable desde api/tables/*.js.

import { randomBytes } from 'crypto';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateQrToken(length = 32) {
  const bytes = randomBytes(length);
  let token = '';
  for (let i = 0; i < length; i++) {
    token += B62[bytes[i] % 62];
  }
  return token;
}
