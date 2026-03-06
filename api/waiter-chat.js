import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

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

// ── Compress large menus: ALL items always included, active categories get full detail ──
function compressMenuData(menuData, messages) {
  if (!menuData) return '';
  const lines = menuData.split('\n').filter(l => l.trim());
  if (lines.length <= 40) return menuData; // small menu, send everything

  // Parse into categories: { "Bebidas - Agua": [line, line], ... }
  const categories = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const cat = line.substring(0, colonIdx).trim();
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(line);
  }

  const catNames = Object.keys(categories);

  // Find categories mentioned in recent messages (last 6 user+assistant turns)
  const recentText = (messages || []).slice(-6).map(m => (m.content || '').toLowerCase()).join(' ');
  const activeCats = new Set();
  for (const cat of catNames) {
    const catLower = cat.toLowerCase();
    if (recentText.includes(catLower)) {
      activeCats.add(cat);
    } else {
      const dash = cat.indexOf(' - ');
      if (dash !== -1) {
        const parent = cat.substring(0, dash).toLowerCase();
        const child = cat.substring(dash + 3).toLowerCase();
        if (recentText.includes(parent) || recentText.includes(child)) {
          activeCats.add(cat);
        }
      }
    }
  }

  const result = [];

  // Active categories: full detail (one item per line with descriptions)
  const activeList = [...activeCats].slice(0, 3);
  if (activeList.length > 0) {
    for (const cat of activeList) {
      result.push(...categories[cat]);
    }
    result.push('');
  }

  // ALL other categories: one compact line per category with every item name, ID, and price
  // Format: "CATEGORY: [id:xxx] Name RD$100 | [id:yyy] Name2 RD$200 | ..."
  const remainingCats = catNames.filter(c => !activeCats.has(c));
  for (const cat of remainingCats) {
    const items = categories[cat].map(line => {
      // Extract: [id:xxx] Name - RD$100
      const m = line.match(/\[id:[^\]]+\]\s*(.+?)\s*-\s*(RD\$\d+)/);
      if (m) {
        const idMatch = line.match(/(\[id:[^\]]+\])/);
        const agotado = line.includes('[AGOTADO]') ? ' AGOTADO' : '';
        return idMatch[1] + ' ' + m[1].trim() + ' ' + m[2] + agotado;
      }
      return null;
    }).filter(Boolean);
    if (items.length > 0) {
      result.push(cat + ': ' + items.join(' | '));
    }
  }

  return result.join('\n');
}

// ── Extract all known item names from menu data for validation ──
function extractMenuItemNames(menuData) {
  if (!menuData) return new Set();
  const names = new Set();
  const lines = menuData.split('\n');
  for (const line of lines) {
    // Match: [id:xxx] ItemName - RD$price
    const m = line.match(/\[id:[^\]]+\]\s*(.+?)\s*-\s*RD\$/);
    if (m) names.add(m[1].trim().toLowerCase());
  }
  return names;
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 20 chat requests per minute per IP
  if (rateLimit(req, res, { max: 20, windowMs: 60000, prefix: 'waiter-chat' })) return;

  const { messages, menuData, restaurant_slug, restaurant_name, browserLanguage, currentLanguage, insights: clientInsights, sessionId, storeClosed: clientStoreClosed } = req.body;

  try {
    const rName = restaurant_name || 'este restaurante';

    // Fetch chatbot personality, plan, and hours from restaurant_users
    let personality = 'casual';
    let plan = 'premium'; // default to premium (legacy restaurants predate plan field)
    let restaurantHours = '';
    let restaurantId = null;
    if (restaurant_slug) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const pRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&select=id,chatbot_personality,plan,hours`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
            },
            signal: AbortSignal.timeout(3000),
          }
        );
        if (pRes.ok) {
          const rows = await pRes.json();
          if (rows.length > 0) {
            restaurantId = rows[0].id || null;
            if (rows[0].chatbot_personality) {
              personality = rows[0].chatbot_personality;
            }
            if (rows[0].plan) {
              plan = rows[0].plan;
            }
            if (rows[0].hours) {
              restaurantHours = rows[0].hours;
            }
          }
        }
      } catch (e) { console.error('[waiter-chat] personality/plan fetch error:', e.message); }
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
      } catch (e) { console.error('[waiter-chat] store_settings fetch error:', e.message); }
    }
    // Client-side flag as fallback
    if (clientStoreClosed === true) storeOpen = false;

    // Fetch restaurant insights for smarter recommendations
    let insightsText = clientInsights || '';
    if (restaurantId && !insightsText) {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const iRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_insights?restaurant_id=eq.${encodeURIComponent(restaurantId)}&select=summary_text&limit=1`,
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
          if (iRows.length > 0 && iRows[0].summary_text) {
            insightsText = iRows[0].summary_text;
          }
        } else {
          console.warn('[waiter-chat] insights query returned', iRes.status, '- continuing without insights');
        }
      } catch (e) { console.error('[waiter-chat] insights fetch error:', e.message); }
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

    // Time-aware suggestions based on DR time (UTC-4)
    const drNow = getDRDate();
    const drHour = drNow.getHours();
    let timeHint = '';
    if (drHour >= 6 && drHour < 11) timeHint = 'Es la mañana, prioriza sugerir desayunos y cafés.';
    else if (drHour >= 11 && drHour < 15) timeHint = 'Es mediodía, prioriza sugerir almuerzos y platos del día.';
    else if (drHour >= 15 && drHour < 23) timeHint = 'Es la tarde/noche, prioriza sugerir cenas y platos principales.';
    else timeHint = 'Es tarde en la noche, sugiere opciones disponibles a esta hora.';

    const systemPrompt = `${langRule}

Eres el mesero virtual de ${rName}.
${langInstruction}
${timeHint}

ESTILO DE CONVERSACIÓN:
- NUNCA repitas el saludo de bienvenida. El cliente ya fue saludado al abrir el chat.
${personalityTone}
- Respuestas ULTRA CORTAS: máximo 1-2 oraciones por mensaje. Como WhatsApp, no como email.
- NUNCA sueltes todo el menú de golpe. Guía paso a paso.

CRÍTICO — ITEMS Y PRECIOS:
- NUNCA inventes platos, precios, descripciones ni información que no esté en el menú de abajo.
- SOLO puedes mencionar items que aparecen en el MENÚ ACTUAL proporcionado.
- Si el cliente pide algo que no está en el menú, dile: "Eso no lo tenemos en el menú, pero te puedo ofrecer [alternativa del menú]."
- Cada item del menú tiene un ID con formato [id:xxx]. SIEMPRE usa ese ID exacto en [ADD_TO_CART:] y [SHOW_PHOTO:].
- NUNCA uses el nombre del item en [ADD_TO_CART:]. SOLO el ID. Ejemplo correcto: [ADD_TO_CART: squareone_smash_burger], ejemplo INCORRECTO: [ADD_TO_CART: Smash Burger].

FORMATO DE RESPUESTA:
- SIEMPRE usa [BUTTONS: opción1 | opción2 | opción3] en UNA SOLA LÍNEA separado por | para dar opciones. NUNCA listes items como texto plano ni en líneas separadas.
- Formato CORRECTO: [BUTTONS: Pizza Pepperoni RD$480 | Pizza Meat Lovers RD$540 | Smash Burger RD$450 | Ver más opciones]
- Formato INCORRECTO: [BUTTONS:] seguido de líneas separadas con corchetes
- Máximo 4 opciones por [BUTTONS:]. Si hay más items, muestra los 4 más relevantes + "Ver más opciones".
- Al listar items incluye el precio: [BUTTONS: Cranberry RD$270 | Agua Perrier RD$110 | Red Bull RD$170 | Ver más bebidas]
- Foto de un item: [SHOW_PHOTO: item_id]
- Agregar al carrito: [ADD_TO_CART: item_id] o [ADD_TO_CART: item_id | 2] o [ADD_TO_CART: item_id | nota] o [ADD_TO_CART: item_id | 2 | nota]
- Si el cliente pide cantidad específica, SIEMPRE incluye el número: [ADD_TO_CART: item_id | 2]

FLUJO:
1. SALUDO: Ya fue saludado. Si primera vez: guía por menú. Si ya vino: muestra categorías.
2. CATEGORÍAS: Muestra como botones (nombres exactos del menú).
3. ITEMS: Al elegir categoría, muestra items como botones con precio. Si hay más de 4, muestra los 4 más relevantes + botón "Ver más".
4. DETALLE: Describe brevemente (1 oración) + [SHOW_PHOTO: item_id]
   ${isSpanish ? '[BUTTONS: 📸 Ver foto | ✅ Agregar | 👀 Otra opción | ⬅️ Categorías]' : '[BUTTONS: 📸 Photo | ✅ Add | 👀 Other | ⬅️ Categories]'}
5. NOTAS: Antes de agregar pregunta notas.
   - CRÍTICO: Cuando el cliente confirma (dice "normal", "sin cambios", "así está bien", o cualquier confirmación), DEBES incluir [ADD_TO_CART: item_id] en tu respuesta. NUNCA digas "listo en el carrito" sin el tag [ADD_TO_CART:].
   - Sin cambios → responde con [ADD_TO_CART: item_id] incluido en el mensaje
   - Con nota → responde con [ADD_TO_CART: item_id | la nota] incluido en el mensaje
   - Ejemplo correcto: "Perfecto, agregado [ADD_TO_CART: squareone_pierna] ¿Algo más?"
   - Ejemplo INCORRECTO: "Listo, está en el carrito" (sin [ADD_TO_CART:] → el item NO se agrega)
6. CIERRE: "Eso es todo" → despedida breve. ${isSpanish ? '[BUTTONS: 👋 Cerrar]' : '[BUTTONS: 👋 Close]'}

REGLAS:
- CONVERSACIONAL: intercambio real, no monólogo
- Solo recomienda del menú actual. Precios en RD$
- [AGOTADO] = agotado, sugiere alternativa
- Nunca confirmes plato libre de alérgenos. Si mencionan alergia → nota en la orden.

${ !storeOpen ? (() => { const nxt = getNextOpenTime(restaurantHours); return `ESTADO: CERRADO. NO uses [ADD_TO_CART:]. Responde: "Estamos cerrados.${nxt ? ' ' + nxt + '.' : ''}${restaurantHours ? ' Horario: ' + restaurantHours : ''} Puedes ver el menú pero no procesar órdenes."\n\n`; })() : '' }${ insightsText ? insightsText.substring(0, 500) + '\n\n' : '' }MENÚ COMPLETO — SOLO estos items existen. Si un plato NO aparece abajo, NO existe en el restaurante. NUNCA inventes items fuera de esta lista:
${compressMenuData(menuData, messages)}`;

    // Trim messages to last 6 to prevent timeouts on long conversations
    const trimmedMessages = (messages || []).slice(-6);

    // Cap system prompt — but never truncate the menu section
    const menuMarker = 'MENÚ COMPLETO';
    const menuIdx = systemPrompt.indexOf(menuMarker);
    const maxPromptChars = 16000;
    let cappedSystem;
    if (systemPrompt.length <= maxPromptChars) {
      cappedSystem = systemPrompt;
    } else if (menuIdx > 0) {
      // Truncate instructions before menu, keep full menu intact
      const menuSection = systemPrompt.substring(menuIdx);
      const available = maxPromptChars - menuSection.length;
      cappedSystem = systemPrompt.substring(0, Math.max(available, 1500)) + '\n...\n' + menuSection;
    } else {
      cappedSystem = systemPrompt.substring(0, maxPromptChars);
    }

    console.log('[waiter-chat] estimated prompt size:', JSON.stringify(trimmedMessages).length + cappedSystem.length, 'chars (system:', cappedSystem.length, '+ messages:', JSON.stringify(trimmedMessages).length, ') history:', trimmedMessages.length, 'msgs');

    const claudeBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: cappedSystem,
      messages: trimmedMessages
    });
    const claudeHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    };

    let response, data;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: claudeHeaders, body: claudeBody,
        signal: AbortSignal.timeout(20000),
      });
      data = await response.json();
    } catch (e1) {
      console.error('[waiter-chat] Claude API attempt 1 failed:', e1.message);
      console.log('[waiter-chat] retrying after error:', e1.message);
      await new Promise(r => setTimeout(r, 1500));
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: claudeHeaders, body: claudeBody,
          signal: AbortSignal.timeout(20000),
        });
        data = await response.json();
      } catch (e2) {
        console.error('[waiter-chat] Claude API attempt 2 failed:', e2.message);
        return res.status(200).json({ answer: p.error });
      }
    }

    if (!response.ok) {
      console.error('[waiter-chat] Claude API error:', response.status, JSON.stringify(data));
      // Retry once on 429 (rate limit) or 529 (overloaded)
      if (response.status === 429 || response.status === 529) {
        console.log('[waiter-chat] retrying after', response.status, '(overloaded/rate-limited)');
        await new Promise(r => setTimeout(r, 3000));
        try {
          const retryRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: claudeHeaders, body: claudeBody,
            signal: AbortSignal.timeout(20000),
          });
          const retryData = await retryRes.json();
          if (retryRes.ok) {
            const retryAnswer = retryData.content.find(c => c.type === 'text')?.text || p.error;
            res.status(200).json({ answer: retryAnswer });
            return;
          }
          console.error('[waiter-chat] Claude API retry failed:', retryRes.status);
        } catch (e) {
          console.error('[waiter-chat] Claude API retry error:', e.message);
        }
      }
      return res.status(200).json({ answer: p.error });
    }

    let answer = data.content.find(c => c.type === 'text')?.text || p.error;

    // Validate: strip ADD_TO_CART for item IDs not in menu data
    if (menuData && answer.includes('ADD_TO_CART')) {
      const knownIds = new Set();
      const idRegex = /\[id:([^\]]+)\]/g;
      let idm;
      while ((idm = idRegex.exec(menuData)) !== null) knownIds.add(idm[1].trim());
      answer = answer.replace(/\[ADD_TO_CART:\s*([^\]|]+)([^\]]*)\]/g, (full, rawId, rest) => {
        const id = rawId.trim();
        if (knownIds.has(id)) return full; // valid
        console.warn('[waiter-chat] blocked invented ADD_TO_CART:', id);
        return ''; // strip invented item
      });
    }

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
    console.error('[waiter-chat] unhandled error:', error.message, error.stack);
    const p = PERSONALITIES.casual;
    res.status(200).json({ answer: p.error });
  }
}

export const config = { maxDuration: 30 };
