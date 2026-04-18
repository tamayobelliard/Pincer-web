import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { logFailClosed } from './ai-failclosed-log.js';

const PERSONALITIES = {
  dominicano: {
    style: `- Hablas español dominicano auténtico: "klk", "manin", "tigre", "dime a ver", "ta to", "fuego"
- Eres carismático, cálido y seguro — como un anfitrión, NO como un vendedor
- Usas emojis con moderación (1-2 por mensaje)`,
    greeting_first: '¡Klk! Bienvenido',
    greeting_return: '¡Mi gente! ¿Qué te antoja hoy?',
    error: '¡Diablo, se me fue la señal! 😅 Intenta de nuevo, manin.',
  },
  habibi: {
    style: `- Hablas español con toque árabe caribeño: usas "habibi", "yalla", "mashallah", "ya habibi", mezclas calidez árabe con sabor dominicano
- Eres hospitalario como en la cultura árabe — el cliente es sagrado, ofreces con generosidad
- Referencia la cultura de la comida cuando sea natural: "esto es como en casa de la abuela"
- Usas emojis con moderación (1-2 por mensaje)`,
    greeting_first: '¡Ahlan habibi! Bienvenido',
    greeting_return: '¡Ya habibi! ¿Qué te provoca hoy?',
    error: '¡Ay habibi, se cayó la señal! 😅 Intenta de nuevo.',
  },
  casual: {
    style: `- Hablas español amigable y neutro, sin jerga regional marcada
- Eres cercano y relajado, como un amigo que te recomienda comida
- Usas emojis con moderación (1-2 por mensaje)`,
    greeting_first: '¡Hola! Bienvenido',
    greeting_return: '¡Hola de nuevo! ¿Qué te provoca hoy?',
    error: '¡Ups, algo falló! 😅 Intenta de nuevo.',
  },
  formal: {
    style: `- Hablas español profesional y elegante, usas "usted" en vez de "tú"
- Eres cortés, refinado y atento — como un maitre de restaurante fino
- Mínimo uso de emojis (máximo 1 por mensaje)`,
    greeting_first: 'Bienvenido',
    greeting_return: 'Es un placer tenerle de vuelta. ¿En qué puedo servirle hoy?',
    error: 'Disculpe, ocurrió un error. Por favor intente nuevamente.',
  },
  playful: {
    style: `- Hablas español divertido y entusiasta, usas expresiones como "¡BRUTAL!", "tremendo", "lo máximo"
- Eres súper energético y juguetón — cada plato es una aventura
- Usas emojis generosamente (2-3 por mensaje) 🎉🔥✨`,
    greeting_first: '¡Holaaaa! 🎉 Bienvenido',
    greeting_return: '¡Volviste! 🎉 ¿Qué aventura culinaria toca hoy?',
    error: '¡Nooo, se me cayó la señal! 😅 ¡Dale de nuevo!',
  },
};

// ── DR timezone (UTC-4, no DST) ──
function getDRDate() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (-4 * 3600000));
}

// ── Schedule parser ──
function isOpenBySchedule(hoursStr) {
  if (!hoursStr || hoursStr === 'Selecciona días y horario') return true;
  const DAY_MAP = { 'dom': 0, 'lun': 1, 'mar': 2, 'mie': 3, 'mié': 3, 'jue': 4, 'vie': 5, 'sab': 6, 'sáb': 6 };
  const DAY_ORDER = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
  const now = getDRDate();
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  function parseTime(str) {
    str = str.trim();
    const match = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return -1;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
    return h * 60 + m;
  }

  function expandDays(dayStr) {
    dayStr = dayStr.trim().toLowerCase();
    if (dayStr.includes('-')) {
      const parts = dayStr.split('-');
      const normalize = s => s.trim().replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u');
      const startIdx = DAY_ORDER.indexOf(normalize(parts[0]));
      const endIdx = DAY_ORDER.indexOf(normalize(parts[1]));
      if (startIdx === -1 || endIdx === -1) return [];
      const days = [];
      let i = startIdx;
      while (true) {
        days.push(DAY_MAP[DAY_ORDER[i]] !== undefined ? DAY_MAP[DAY_ORDER[i]] : i);
        if (i === endIdx) break;
        i = (i + 1) % 7;
      }
      return days;
    }
    const normalized = dayStr.replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u');
    const dayNum = DAY_MAP[normalized];
    return dayNum !== undefined ? [dayNum] : [];
  }

  const segments = hoursStr.split(',');
  for (const seg of segments) {
    const timeMatch = seg.trim().match(/^(.+?)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!timeMatch) continue;
    const days = expandDays(timeMatch[1]);
    const openMin = parseTime(timeMatch[2]);
    const closeMin = parseTime(timeMatch[3]);
    if (openMin === -1 || closeMin === -1) continue;

    if (closeMin <= openMin) {
      if (days.includes(currentDay) && currentMinutes >= openMin) return true;
      const yesterday = (currentDay + 6) % 7;
      if (days.includes(yesterday) && currentMinutes < closeMin) return true;
    } else {
      if (days.includes(currentDay) && currentMinutes >= openMin && currentMinutes < closeMin) return true;
    }
  }
  return false;
}

// ── Calculate next opening time from schedule ──
function getNextOpenTime(hoursStr) {
  if (!hoursStr || hoursStr === 'Selecciona días y horario') return null;
  const DAY_MAP = { 'dom': 0, 'lun': 1, 'mar': 2, 'mie': 3, 'mié': 3, 'jue': 4, 'vie': 5, 'sab': 6, 'sáb': 6 };
  const DAY_ORDER = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
  const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const now = getDRDate();
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  function parseTime(str) {
    str = str.trim();
    const match = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return -1;
    let h = parseInt(match[1]); const m = parseInt(match[2]); const ampm = match[3].toUpperCase();
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
    return h * 60 + m;
  }

  function expandDays(dayStr) {
    dayStr = dayStr.trim().toLowerCase();
    if (dayStr.includes('-')) {
      const parts = dayStr.split('-');
      const normalize = s => s.trim().replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u');
      const startIdx = DAY_ORDER.indexOf(normalize(parts[0]));
      const endIdx = DAY_ORDER.indexOf(normalize(parts[1]));
      if (startIdx === -1 || endIdx === -1) return [];
      const days = []; let i = startIdx;
      while (true) { days.push(DAY_MAP[DAY_ORDER[i]] !== undefined ? DAY_MAP[DAY_ORDER[i]] : i); if (i === endIdx) break; i = (i + 1) % 7; }
      return days;
    }
    const normalized = dayStr.replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u');
    const dayNum = DAY_MAP[normalized]; return dayNum !== undefined ? [dayNum] : [];
  }

  function formatMinutes(min) {
    const h = Math.floor(min / 60); const m = min % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  // Parse all schedule segments into (days[], openMinutes) pairs
  const parsed = [];
  const segments = hoursStr.split(',');
  for (const seg of segments) {
    const timeMatch = seg.trim().match(/^(.+?)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!timeMatch) continue;
    const days = expandDays(timeMatch[1]);
    const openMin = parseTime(timeMatch[2]);
    if (openMin === -1 || days.length === 0) continue;
    parsed.push({ days, openMin });
  }
  if (parsed.length === 0) return null;

  // Helper: get the earliest opening time for a given day number (0-6)
  function earliestOpenForDay(dayNum) {
    let earliest = -1;
    for (const p of parsed) {
      if (p.days.includes(dayNum) && (earliest === -1 || p.openMin < earliest)) {
        earliest = p.openMin;
      }
    }
    return earliest;
  }

  // Step 1: Check if today has any opening time still ahead
  for (const p of parsed) {
    if (p.days.includes(currentDay) && p.openMin > currentMinutes) {
      // Find the earliest one today that's still ahead
      let todayEarliest = -1;
      for (const q of parsed) {
        if (q.days.includes(currentDay) && q.openMin > currentMinutes) {
          if (todayEarliest === -1 || q.openMin < todayEarliest) todayEarliest = q.openMin;
        }
      }
      return 'Abrimos hoy a las ' + formatMinutes(todayEarliest);
    }
  }

  // Step 2: Iterate tomorrow through next 7 days to find next open day
  for (let offset = 1; offset <= 7; offset++) {
    const checkDay = (currentDay + offset) % 7;
    const earliest = earliestOpenForDay(checkDay);
    if (earliest !== -1) {
      return 'Abrimos el ' + DAY_NAMES[checkDay] + ' a las ' + formatMinutes(earliest);
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Rate limit: 20 chat requests per minute per IP
  if (rateLimit(req, res, { max: 20, windowMs: 60000, prefix: 'waiter-chat' })) return;

  const { messages, menuData, restaurant_slug, restaurant_name, browserLanguage, currentLanguage, insights: clientInsights, sessionId, storeClosed: clientStoreClosed } = req.body;

  // ─────────────────────────────────────────────────────────────
  // FAIL-CLOSED GUARDS (see docs/backlog/warm-standby-neon.md context,
  // incident kj2hm399j9cw on 2026-04-17). If we cannot trust the context,
  // refuse to call Claude — a bot with no menu hallucinates items and
  // that's worse than an error message.
  // ─────────────────────────────────────────────────────────────

  // Gate 1: menuData is client-provided, so validate strictly before we
  // inject it into the system prompt. Must be a non-trivial string that
  // looks like our buildMenuData() output (lines of "[id:xxx] name - RD$...").
  const menuDataValid =
    typeof menuData === 'string' &&
    menuData.length >= 20 &&
    menuData.includes('[id:');
  if (!menuDataValid) {
    const correlation_id = logFailClosed({
      endpoint: 'waiter-chat',
      restaurant_slug,
      reason: menuData == null || menuData === '' ? 'menu_empty' : 'context_invalid',
      extra: { menuData_type: typeof menuData, menuData_length: menuData?.length ?? 0 },
    });
    return res.status(503).json({
      error: 'context_unavailable',
      reason: 'menu_empty',
      message: 'En este momento no puedo ayudarte con el menú. Por favor intenta de nuevo en unos minutos.',
      correlation_id,
    });
  }

  try {
    const rName = restaurant_name || 'este restaurante';

    // Fetch chatbot personality, plan, and hours from restaurant_users.
    // This is the CRITICAL context query: without it we don't know whether
    // the restaurant is premium (chatbot-enabled) or what personality to use.
    // If this fetch fails in any way, we fail-closed.
    let personality = 'casual';
    let plan = null;
    let restaurantHours = '';
    let criticalFetchFailure = null;
    if (!restaurant_slug) {
      criticalFetchFailure = 'missing_slug';
    } else {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const pRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&select=chatbot_personality,plan,hours`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
            },
            signal: AbortSignal.timeout(3000),
          }
        );
        if (!pRes.ok) {
          criticalFetchFailure = 'supabase_unreachable';
        } else {
          const rows = await pRes.json();
          if (rows.length === 0) {
            criticalFetchFailure = 'restaurant_not_found';
          } else {
            if (rows[0].chatbot_personality) personality = rows[0].chatbot_personality;
            plan = rows[0].plan || 'premium'; // legacy rows without plan treated as premium
            if (rows[0].hours) restaurantHours = rows[0].hours;
          }
        }
      } catch (e) {
        criticalFetchFailure = 'supabase_unreachable';
      }
    }

    if (criticalFetchFailure) {
      const correlation_id = logFailClosed({
        endpoint: 'waiter-chat',
        restaurant_slug,
        reason: criticalFetchFailure,
      });
      return res.status(503).json({
        error: 'context_unavailable',
        reason: criticalFetchFailure,
        message: 'En este momento no puedo ayudarte con el menú. Por favor intenta de nuevo en unos minutos.',
        correlation_id,
      });
    }

    // Determine if restaurant is open (server-side check)
    let storeOpen = true;
    if (restaurant_slug) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const ssRes = await fetch(
          `${supabaseUrl}/rest/v1/store_settings?id=eq.${encodeURIComponent(restaurant_slug)}&select=*`,
          {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(3000),
          }
        );
        if (ssRes.ok) {
          const ssRows = await ssRes.json();
          if (ssRows.length > 0) {
            if (ssRows[0].is_open === false) {
              // DB says closed — always respect
              storeOpen = false;
            } else if (restaurantHours && !ssRows[0].schedule_override) {
              // DB says open + no manual override → check schedule
              storeOpen = isOpenBySchedule(restaurantHours);
            }
          }
        }
      } catch { /* default open */ }
    }
    // Client-side flag as fallback
    if (clientStoreClosed === true) storeOpen = false;

    // Fetch restaurant insights for smarter recommendations
    let insightsText = clientInsights || '';
    if (restaurant_slug && !insightsText) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const iRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_insights?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&select=top_items,ai_insights&order=week_start.desc&limit=1`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
            },
            signal: AbortSignal.timeout(3000),
          }
        );
        if (iRes.ok) {
          const iRows = await iRes.json();
          if (iRows.length > 0) {
            const row = iRows[0];
            const parts = [];
            if (row.top_items?.length > 0) {
              parts.push('Items mas populares: ' + row.top_items.slice(0, 5).map((t, i) => `${i + 1}. ${t.name} (${t.units} vendidos)`).join(', '));
            }
            if (row.ai_insights?.hero_insight) {
              parts.push('Insight de la semana: ' + row.ai_insights.hero_insight);
            }
            if (parts.length > 0) insightsText = parts.join('\n');
          }
        }
      } catch { /* no insights available — continue without */ }
    }

    // Block free-plan restaurants from using chatbot
    if (plan !== 'premium') {
      return res.status(403).json({ error: 'Plan Premium requerido' });
    }

    const lang = (browserLanguage || 'es').toLowerCase();
    const browserIsSpanish = lang.startsWith('es');
    // currentLanguage: null = not yet confirmed, 'es' = Spanish confirmed, 'en'/'fr'/'ht' = other confirmed
    const confirmedLang = currentLanguage || null;
    const activeLang = confirmedLang || 'es'; // default to Spanish until confirmed
    const isSpanish = activeLang.startsWith('es');

    console.log('waiter-chat personality:', restaurant_slug, '->', personality, '| browser:', lang, '| confirmed:', confirmedLang);
    console.log('browserLanguage received:', browserLanguage);

    const p = PERSONALITIES[personality] || PERSONALITIES.casual;

    // Language name mapping for the offer prompt
    const LANG_NAMES = { en: 'English', fr: 'français', ht: 'Kreyòl', pt: 'português', de: 'Deutsch', it: 'italiano', zh: '中文', ja: '日本語', ko: '한국어' };

    // Welcome-only request: return greeting without calling Claude (always in Spanish)
    if (req.body.welcome) {
      const rName = restaurant_name || 'nuestro restaurante';
      const emoji = { dominicano: '🔥', habibi: '✨', casual: '😊', formal: '', playful: '🎉' }[personality] || '😊';
      const question = personality === 'formal' ? '¿Es su primera visita?' : '¿Es tu primera vez por aquí?';
      const sep = emoji ? ' ' + emoji + ' ' : '. ';
      const greeting = `${p.greeting_first} a ${rName}${sep}${question}`;
      return res.status(200).json({ answer: greeting });
    }

    // Build language-specific prompt sections
    let langInstruction;
    if (confirmedLang && !isSpanish) {
      // Language already confirmed as non-Spanish — respond in that language
      const confirmedName = LANG_NAMES[confirmedLang] || confirmedLang;
      langInstruction = `
LANGUAGE RULES:
- The customer has chosen to be served in ${confirmedName}. You MUST respond in ${confirmedName}.
- NEVER switch languages unless the customer explicitly asks.
- Translate menu item names and descriptions naturally, keeping the original Spanish name in parentheses on first mention.
- Keep ALL prices in RD$ always.${confirmedLang === 'en' ? `
- Highlight Dominican dishes with brief cultural context (e.g. "Mangú — a beloved Dominican mashed plantain dish").` : ''}${confirmedLang === 'ht' ? `
- Use a warm, respectful tone in Kreyòl. If the customer mixes Spanish and Creole, follow their lead naturally.` : ''}
- For totals over RD$500, show USD equivalent in parentheses (use approximate rate: 1 USD = 60 RD$).
- Buttons text must also be in ${confirmedName}.
`;
    } else {
      // Spanish confirmed or browser is Spanish — no language rules needed
      langInstruction = '';
    }

    const personalityTone = {
      dominicano: isSpanish ? p.style : '- Warm, lively tone with Dominican flavor adapted to the customer\'s language. Friendly and confident like a great host.',
      habibi: isSpanish ? p.style : '- Warm, generous Middle Eastern hospitality adapted to the customer\'s language. The customer is sacred.',
      casual: isSpanish ? p.style : '- Friendly, relaxed neutral tone. Like a friend recommending food.',
      formal: isSpanish ? p.style : '- Professional, polished tone. Use formal register of the customer\'s language (e.g. "vous" in French, formal "you" in English).',
      playful: isSpanish ? p.style : '- Fun, enthusiastic, energetic tone. Every dish is an adventure! Use 2-3 emojis per message.',
    }[personality] || (isSpanish ? p.style : '- Friendly, relaxed neutral tone.');

    const browserLang = (browserLanguage || 'es').toLowerCase().split('-')[0];
    const LANG_DISPLAY = { en: 'English', fr: 'français', ht: 'Kreyòl', pt: 'português', de: 'Deutsch', it: 'italiano', zh: '中文', ja: '日本語', ko: '한국어' };
    const browserLangName = LANG_DISPLAY[browserLang] || browserLang;

    const langRule = browserLang !== 'es'
      ? `Idioma del browser del cliente: ${browserLangName}
Regla de idioma:
- Saluda siempre en español primero
- En el primer mensaje pregunta: "Veo que tu dispositivo esta en ${browserLangName}. ¿Prefieres que te hable en ${browserLangName}?"
- Si el cliente acepta, cambia a ese idioma para toda la conversacion
- Si el cliente prefiere español, continua en español`
      : 'Responde siempre en español.';

    const systemPrompt = `${langRule}

Eres el mesero virtual de ${rName}.
${langInstruction}
ESTILO DE CONVERSACIÓN:
- NUNCA repitas el saludo de bienvenida. El cliente ya fue saludado al abrir el chat. Si el cliente dice que es su primera vez o que ya ha venido, NO vuelvas a decir saludos. Ve directo al punto.
${personalityTone}
- Respuestas ULTRA CORTAS: máximo 1-2 oraciones por mensaje. Nada de párrafos. Piensa en cómo escribes por WhatsApp, no en un email.
- NUNCA sueltes todo el menú de golpe. Guía paso a paso como una conversación real.

FORMATO DE RESPUESTA:
- Al final de CADA mensaje, incluye opciones para el cliente en este formato exacto:
  [BUTTONS: opción1 | opción2 | opción3]
- Los botones deben ser relevantes al momento de la conversación
- Máximo 4 botones por mensaje. Si necesitas más, envía los primeros 4 y agrega "Y también tenemos:" con más botones en la misma respuesta.
- SIEMPRE incluye [BUTTONS:] al final de cada mensaje, sin excepción
- Para mostrar la foto de un item usa: [SHOW_PHOTO: item_id]
- Para agregar al carrito usa: [ADD_TO_CART: item_id] o con cantidad: [ADD_TO_CART: item_id | 2] o con nota: [ADD_TO_CART: item_id | nota] o ambos: [ADD_TO_CART: item_id | 2 | nota]
- IMPORTANTE: Si el cliente pide una cantidad específica (ej: "quiero 2 cervezas", "agrégame 3"), SIEMPRE incluye la cantidad como número después del item_id

FLUJO DE ORDERING (sigue este flujo natural):

1. SALUDO: El cliente ya fue saludado. Responde según lo que diga:
   Si dice primera vez: "${isSpanish ? p.greeting_first + ' 💪 ¿Quieres que te guíe por el menú o prefieres verlo tú directamente ahí arriba?' : 'Respond warmly and offer to guide them through the menu or let them browse.'}"
   ${isSpanish ? '[BUTTONS: 🍽️ Guíame tú | 👀 Voy a ver el menú]' : '[BUTTONS: 🍽️ Guide me | 👀 I\'ll browse the menu]'}
   Si ya ha venido: "${isSpanish ? p.greeting_return : 'Welcome them back warmly'}" y muestra las categorías del menú como botones.

2. CATEGORÍAS: Si el cliente quiere guía o elige una categoría, muestra las categorías disponibles del menú como botones (usa los nombres exactos de las categorías del menú).

3. ITEMS: Cuando elija categoría, muestra TODOS los items disponibles de esa categoría como botones. Nunca omitas items del menú. Si hay más de 4, usa múltiples líneas de botones.

4. DETALLE: Cuando elija un item, describe brevemente qué trae (1 oración) y ofrece ver la foto:
   [SHOW_PHOTO: item_id]
   ${isSpanish ? '[BUTTONS: 📸 Ver foto | ✅ Agregar al carrito | 👀 Ver otra opción | ⬅️ Volver a categorías]' : '[BUTTONS: 📸 See photo | ✅ Add to cart | 👀 See another option | ⬅️ Back to categories]'}

5. FOTO: Si el cliente pide ver la foto, responde breve y vuelve a ofrecer agregar:
   [SHOW_PHOTO: item_id]
   ${isSpanish ? '[BUTTONS: ✅ Agregar al carrito | 👀 Ver otra opción | ⬅️ Volver a categorías]' : '[BUTTONS: ✅ Add to cart | 👀 See another option | ⬅️ Back to categories]'}

6. NOTAS: Si el cliente dice "Agregar al carrito", ANTES de agregar pregunta por notas:
   ${isSpanish ? '"¿Alguna nota especial? Ej: sin vegetales, extra queso..."' : '"Any special notes? E.g. no veggies, extra cheese..."'}
   ${isSpanish ? '[BUTTONS: 👌 Sin cambios, así está bien | ✏️ Quiero hacer un cambio]' : '[BUTTONS: 👌 No changes, it\'s perfect | ✏️ I want to customize]'}
   - Si dice "Sin cambios": agrega sin notas [ADD_TO_CART: item_id] (o con cantidad: [ADD_TO_CART: item_id | 2])
   - Si dice "Quiero hacer un cambio": dile que escriba qué quiere cambiar
   - Cuando escriba su nota: [ADD_TO_CART: item_id | la nota que escribió] (o con cantidad: [ADD_TO_CART: item_id | 2 | la nota])
   Después de agregar, ofrece:
   ${isSpanish ? '[BUTTONS: 🍟 Agregar un extra | 🥤 Algo más | ✅ Eso es todo]' : '[BUTTONS: 🍟 Add a side | 🥤 Something else | ✅ That\'s all]'}

7. EXTRAS: Si pide extras, muestra los extras disponibles como botones.

8. CIERRE: Si dice "Eso es todo", despídete brevemente:
   ${isSpanish ? '[BUTTONS: 👋 Cerrar]' : '[BUTTONS: 👋 Close]'}

REGLAS IMPORTANTES:
- Los item_ids están en el menú con formato [id:xxx]. Usa EXACTAMENTE esos IDs en [ADD_TO_CART:]
- CONVERSACIONAL: Cada mensaje debe sentirse como un intercambio real, no un monólogo
- Si el cliente dice "no sé qué pedir", hazle UNA pregunta sobre sus preferencias
- Si el cliente muestra interés en algo, profundiza y sugiere complementos
- Solo recomienda items del menú actual
- Si un item está [AGOTADO], di que se acabó y sugiere alternativa
- Precios en RD$
- Si preguntan algo fuera del restaurante, redirige amablemente a la comida
- NUNCA inventes items o precios que no están en el menú
- NUNCA confirmes que un plato es libre de alérgenos sin datos. Si el cliente menciona alergia, inclúyelo como nota en la orden.

${ !storeOpen ? (() => { const nxt = getNextOpenTime(restaurantHours); return `ESTADO DEL RESTAURANTE: CERRADO
REGLA CRITICA: El restaurante esta cerrado. NO proceses ordenes ni uses [ADD_TO_CART:].
Si el cliente intenta ordenar, responde: "Estamos cerrados en este momento.${nxt ? ' ' + nxt + '.' : ''}${restaurantHours ? ' Nuestro horario es: ' + restaurantHours : ''} Puedes ver el menu pero no podemos procesar ordenes ahora."
Puedes mostrar el menu y fotos, pero NUNCA agregues items al carrito.\n\n`; })() : '' }${ insightsText ? insightsText + '\n\n' : '' }MENÚ ACTUAL (items disponibles):
${menuData}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages.slice(-10)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(200).json({ answer: p.error });
    }

    const answer = data.content.find(c => c.type === 'text')?.text || p.error;

    res.status(200).json({ answer });

    // Save chat messages async (fire and forget)
    if (sessionId && restaurant_slug) {
      const lastUserMsg = messages[messages.length - 1];
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const rows = [
        { session_id: sessionId, restaurant_slug, role: 'user', content: lastUserMsg?.content || '', browser_language: browserLanguage || null },
        { session_id: sessionId, restaurant_slug, role: 'assistant', content: answer, browser_language: browserLanguage || null },
      ];
      fetch(`${supabaseUrl}/rest/v1/chat_messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(5000),
      }).catch(e => console.error('chat_messages save error:', e.message));
    }

  } catch (error) {
    console.error('waiter-chat error:', error);
    const p = PERSONALITIES.casual;
    res.status(500).json({ answer: p.error });
  }
}

export const config = { maxDuration: 30 };
