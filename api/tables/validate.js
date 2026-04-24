import { rateLimit } from '../rate-limit.js';
import { handleCors } from '../cors.js';

export const config = { maxDuration: 5 };

// Endpoint público (sin auth) — el menú cliente lo llama al cargar con
// ?slug=X&token=Y para validar que el qr_token es de una mesa activa de
// ese restaurante. Devuelve el table_number canónico desde DB, así el
// menú puede comparar contra el ?table=N del URL y detectar mismatch.
//
// Rate limit moderado — el menú lo llama una vez por page load. Token
// es 32 chars base62 (~190 bits), enumeración por fuerza bruta imposible,
// pero el rate limit previene abuse genérico.
export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type' })) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (rateLimit(req, res, { max: 60, windowMs: 60000, prefix: 'tables-validate' })) return;

  const slug = (req.query && req.query.slug) || '';
  const token = (req.query && req.query.token) || '';

  // Validación rápida antes de tocar DB: slug y token con shape razonable.
  if (typeof slug !== 'string' || !/^[a-z0-9_-]{2,50}$/.test(slug)) {
    return res.status(200).json({ valid: false });
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
    return res.status(200).json({ valid: false });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) return res.status(500).json({ valid: false, error: 'Error del servidor' });

  try {
    // Lookup por qr_token (único global). El slug es parte del filtro para
    // rechazar el caso "token válido de otro restaurante presentado con slug
    // ajeno". active=eq.true ya lo garantiza la RLS sobre anon, pero lo
    // dejamos explícito en la query para ser claros.
    const res2 = await fetch(
      `${supabaseUrl}/rest/v1/tables?qr_token=eq.${encodeURIComponent(token)}&restaurant_slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,table_number&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!res2.ok) {
      console.error('tables/validate: fetch error', res2.status);
      return res.status(200).json({ valid: false });
    }
    const rows = await res2.json();
    if (rows.length === 0) {
      return res.status(200).json({ valid: false });
    }

    // Sprint-3 Etapa 2 follow-up: también devolvemos id para que el menú
    // cliente lo incluya en el payload de la orden (table_id). Sin table_id
    // la RLS de orders deja la validación de mesa en null, anulando el
    // scoping. El id es público-safe (cualquier scan válido ya tiene acceso).
    return res.status(200).json({
      valid: true,
      table_id: rows[0].id,
      table_number: rows[0].table_number,
    });
  } catch (e) {
    console.error('tables/validate error:', e.message);
    return res.status(200).json({ valid: false });
  }
}
