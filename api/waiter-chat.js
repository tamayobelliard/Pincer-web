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

// ── Compress large menus: category directory + active category items only ──
function formatMenuData(menuData) {
  if (!menuData) return '';
  // Pass through ALL items exactly as received — no compression, no omissions.
  // Frontend sends: "Category: [id:xxx] Name - RD$price - description [AGOTADO]"
  return menuData;
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

    const browserLang = (browserLanguage || 'es').toLowerCase().split('-')[0];
    const LANG_DISPLAY = { en: 'English', fr: 'français', ht: 'Kreyòl', pt: 'português', de: 'Deutsch', it: 'italiano', zh: '中文', ja: '日本語', ko: '한국어' };
    const browserLangName = LANG_DISPLAY[browserLang] || browserLang;

    // Language instruction for the system prompt
    let langLine;
    if (confirmedLang && !isSpanish) {
      langLine = `The customer chose ${LANG_DISPLAY[confirmedLang] || confirmedLang}. Respond in that language. Keep prices in RD$. Buttons text also in that language.`;
    } else if (!confirmedLang && browserLang !== 'es') {
      langLine = `Browser language: ${browserLangName}. In STEP 1 greeting, after the Spanish greeting, also offer: "I see your device is in ${browserLangName} — would you prefer I help you in ${browserLangName}?" Add that language as a button option.`;
    } else {
      langLine = 'Respond in Spanish.';
    }

    const systemPrompt = `You are the virtual waiter for ${rName}. You guide customers through ordering naturally, like a real waiter would.

${langLine}
${p.style}

CONVERSATION FLOW — follow this exact sequence:

STEP 1 — GREETING (only when first message is "__START__")
- Greet warmly in Spanish
- Ask if it's their first time
- End with: [BUTTONS: 👋 Primera vez | 🔄 Ya he venido antes]

STEP 2 — OFFER HELP
- If first time: brief warm welcome + one-line description of the restaurant
- If returning: welcome back warmly
- Ask what they'd like to do
- End with: [BUTTONS: 🛒 Ayúdame a ordenar | 📋 Prefiero ver el menú solo]

STEP 3a — CUSTOMER WANTS TO BROWSE ALONE
- Say something warm like "¡Claro! Estaré aquí si necesitas algo 😊"
- End with: [CLOSE_CHAT]

STEP 3b — CUSTOMER WANTS HELP ORDERING
- Guide them like a real waiter — ask what they're in the mood for
- Use the menu to suggest specific items, do upselling naturally
- End every message with [BUTTONS:] showing 2-4 relevant options

STEP 4 — ITEM SELECTED
- Describe the item briefly and enthusiastically
- Ask about modifications in the SAME message: "¿Lo quieres así o alguna observación? (sin tomate, extra salsa...)"
- End with: [BUTTONS: ✅ Así está bien | ❌ Sin tomate | ❌ Sin cebolla | ✏️ Otra cosa]
- NEVER include [ADD_TO_CART:] in this message

STEP 5 — CONFIRMATION RECEIVED
- Add to cart: [ADD_TO_CART: item_id] or [ADD_TO_CART: item_id | modification]
- Do natural upselling: suggest a drink, a side, or a complement
- End with: [BUTTONS: 🍽️ Pedir algo más | ✅ Eso es todo]

STEP 6 — ORDER COMPLETE
- When customer says they're done: warm closing message
- Include: [ORDER_COMPLETE]

RULES:
- Keep responses SHORT — max 3 sentences of text
- ALWAYS end with [BUTTONS:] except on [ORDER_COMPLETE] and [CLOSE_CHAT]
- NEVER mention items not in the menu below
- NEVER include [ADD_TO_CART:] and the observations question in the same message
- [BUTTONS:] must appear at the very end of the message, after all text
- Item IDs are in format [id:xxx] in the menu. Use those exact IDs for [ADD_TO_CART:]
- Without the [ADD_TO_CART:] tag, NOTHING gets added to the cart. Never say "added" without it.
- For photos: [SHOW_PHOTO: item_id]

${ !storeOpen ? (() => { const nxt = getNextOpenTime(restaurantHours); return `STATUS: CLOSED. Do NOT use [ADD_TO_CART:]. Tell the customer: "Estamos cerrados.${nxt ? ' ' + nxt + '.' : ''}${restaurantHours ? ' Horario: ' + restaurantHours : ''} Puedes ver el menú pero no procesar órdenes."\n\n`; })() : '' }${ insightsText ? insightsText.substring(0, 500) + '\n\n' : '' }MENU:
${formatMenuData(menuData)}`;

    // Trim messages to last 6 to prevent timeouts on long conversations
    const trimmedMessages = (messages || []).slice(-6);

    // Cap system prompt but NEVER truncate the menu section
    const menuMarker = '=== MENÚ COMPLETO ===';
    const menuIdx = systemPrompt.indexOf(menuMarker);
    const maxPromptChars = 16000;
    let cappedSystem;
    if (systemPrompt.length <= maxPromptChars) {
      cappedSystem = systemPrompt;
    } else if (menuIdx > 0) {
      // Truncate instructions before menu, keep full menu intact
      const menuSection = systemPrompt.substring(menuIdx);
      const available = maxPromptChars - menuSection.length;
      cappedSystem = systemPrompt.substring(0, Math.max(available, 2000)) + '\n...\n' + menuSection;
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

    // Safety net: if AI claims it added to cart but forgot the tag, strip the false claim
    const claimsCart = /agregado|agregué|añadido|added|listo.*carrito|en tu carrito/i.test(answer);
    const hasCartTag = /\[ADD_TO_CART:/i.test(answer);
    if (claimsCart && !hasCartTag) {
      console.warn('[waiter-chat] AI claimed cart add without [ADD_TO_CART:] tag — stripping false claim');
      answer = answer.replace(/[✅🛒]\s*(.*(?:agregado|agregué|añadido|added|listo.*carrito|en tu carrito).*?)([.!?\n]|$)/gi, '$2').trim();
      if (!answer) answer = '¿Qué te gustaría ordenar?';
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
