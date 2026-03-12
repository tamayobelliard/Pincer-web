import { handleCors } from './cors.js';

export const config = { maxDuration: 60 };

const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Date helpers (DR timezone UTC-4) ──

function getDRDate(date) {
  const d = date || new Date();
  return new Date(d.getTime() - 4 * 60 * 60 * 1000);
}

function getWeekBounds(weekStartInput, weekEndInput) {
  let startDate, endDate;

  if (weekStartInput && weekEndInput) {
    // Both provided: use exact range
    startDate = new Date(weekStartInput + 'T00:00:00Z');
    endDate = new Date(weekEndInput + 'T00:00:00Z');
  } else if (weekStartInput) {
    // Only start: end = start + 6
    startDate = new Date(weekStartInput + 'T00:00:00Z');
    endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 6);
  } else {
    // Auto: trailing 7 complete days (yesterday - 6 → yesterday)
    const now = getDRDate();
    endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    endDate.setUTCDate(endDate.getUTCDate() - 1); // yesterday
    startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 6); // yesterday - 6
  }

  // Previous period: same length, immediately before
  const prevEnd = new Date(startDate);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - 6);

  return {
    weekStart: startDate.toISOString().split('T')[0],
    weekEnd: endDate.toISOString().split('T')[0],
    // DR midnight = UTC+4h
    weekStartISO: new Date(startDate.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    weekEndISO: new Date(endDate.getTime() + 28 * 60 * 60 * 1000).toISOString(),
    prevWeekStartISO: new Date(prevStart.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    prevWeekEndISO: new Date(prevEnd.getTime() + 28 * 60 * 60 * 1000).toISOString(),
  };
}

// ── Data fetchers ──

async function fetchOrders(slug, startISO, endISO) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?restaurant_slug=eq.${encodeURIComponent(slug)}&created_at=gte.${encodeURIComponent(startISO)}&created_at=lt.${encodeURIComponent(endISO)}&select=items,total,created_at,order_type,status&limit=5000`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  return await res.json();
}

async function fetchPageEvents(slug, startISO, endISO) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/page_events?restaurant_slug=eq.${encodeURIComponent(slug)}&created_at=gte.${encodeURIComponent(startISO)}&created_at=lt.${encodeURIComponent(endISO)}&select=event_type,event_data,browser_language&limit=20000`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  return await res.json();
}

async function fetchShifts(slug, startISO, endISO) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/shifts?restaurant_slug=eq.${encodeURIComponent(slug)}&status=eq.cerrado&closed_at=gte.${encodeURIComponent(startISO)}&closed_at=lt.${encodeURIComponent(endISO)}&select=opened_at,closed_at,total_ordenes,total_ventas,top_products&limit=50`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return [];
  return await res.json();
}

async function fetchRestaurantName(slug) {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=display_name&limit=1`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return slug;
    const rows = await res.json();
    return rows[0]?.display_name || slug;
  } catch { return slug; }
}

// ── Metrics computation ──

function computeOrderMetrics(orders) {
  let totalRevenue = 0;
  const itemCounts = {};
  const itemRevenue = {};
  const hourCounts = {};
  const typeCounts = {};

  for (const o of orders) {
    totalRevenue += o.total || 0;
    const ot = o.order_type || 'unknown';
    typeCounts[ot] = (typeCounts[ot] || 0) + 1;

    try {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
      if (Array.isArray(items)) {
        // If items lack price, estimate per-item from order total
        const hasPrice = items.some(i => i.price > 0);
        const mainItems = items.filter(i => !i.id?.startsWith('extra_') && !i.name?.toLowerCase().startsWith('extra '));
        const totalQty = mainItems.reduce((s, i) => s + (i.qty || 1), 0);
        const estimatedPrice = !hasPrice && totalQty > 0 ? Math.round((o.total || 0) / totalQty) : 0;

        for (const item of items) {
          if (item.id?.startsWith('extra_') || item.name?.toLowerCase().startsWith('extra ')) continue;
          const name = item.name || item.id || 'Unknown';
          const qty = item.qty || 1;
          itemCounts[name] = (itemCounts[name] || 0) + qty;
          const price = item.price || estimatedPrice;
          itemRevenue[name] = (itemRevenue[name] || 0) + price * qty;
        }
      }
    } catch { /* skip */ }

    if (o.created_at) {
      const hour = new Date(o.created_at).getUTCHours();
      const drHour = (hour - 4 + 24) % 24;
      hourCounts[drHour] = (hourCounts[drHour] || 0) + 1;
    }
  }

  const sortedItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);
  const topItems = sortedItems.slice(0, 10).map(([name, units]) => ({
    name, units, revenue: itemRevenue[name] || 0,
  }));
  const lowItems = sortedItems.filter(([, units]) => units <= 2).slice(0, 5).map(([name, units]) => ({
    name, units, reason: units === 0 ? 'sin_ventas' : 'muy_bajo',
  }));

  const peakHourEntry = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    totalOrders: orders.length,
    totalRevenue,
    avgTicket: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0,
    topItems,
    lowItems,
    peakHour: peakHourEntry ? parseInt(peakHourEntry[0]) : null,
    orderTypes: typeCounts,
  };
}

function computeEventMetrics(events) {
  const counts = {};
  const viewedItems = {};
  const cartItems = {};
  const languages = {};
  let chatOrderCount = 0;
  const sessions = new Set();

  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] || 0) + 1;

    if (e.event_type === 'menu_item_viewed' && e.event_data?.item_name) {
      viewedItems[e.event_data.item_name] = (viewedItems[e.event_data.item_name] || 0) + 1;
    }
    if (e.event_type === 'cart_add' && e.event_data?.item_name) {
      cartItems[e.event_data.item_name] = (cartItems[e.event_data.item_name] || 0) + 1;
    }
    if (e.event_type === 'chatbot_order_completed') {
      chatOrderCount++;
    }
    if (e.event_type === 'page_view') {
      sessions.add(e.event_data?.session_id || Math.random());
    }
    if (e.browser_language) {
      const lang = e.browser_language.split('-')[0].toLowerCase();
      languages[lang] = (languages[lang] || 0) + 1;
    }
  }

  const pageViews = counts.page_view || 0;
  const checkoutStarts = counts.checkout_start || 0;
  const ordersCompleted = counts.order_complete || 0;
  const conversionRate = pageViews > 0 ? Math.round(ordersCompleted / pageViews * 10000) / 100 : 0;

  // Normalize language breakdown to percentages
  const langTotal = Object.values(languages).reduce((s, v) => s + v, 0) || 1;
  const languageBreakdown = {};
  for (const [lang, count] of Object.entries(languages)) {
    const key = ['es', 'en', 'fr', 'ht'].includes(lang) ? lang : 'other';
    languageBreakdown[key] = (languageBreakdown[key] || 0) + Math.round(count / langTotal * 100);
  }

  // Items viewed per session
  const itemViewCount = counts.item_view || counts.menu_item_viewed || 0;
  const itemsPerSession = sessions.size > 0 ? Math.round(itemViewCount / sessions.size * 10) / 10 : 0;

  // Figure out abandonment section
  let abandonmentSection = null;
  if (checkoutStarts > ordersCompleted && checkoutStarts > 0) {
    abandonmentSection = 'checkout';
  } else if ((counts.cart_add || 0) > checkoutStarts && (counts.cart_add || 0) > 0) {
    abandonmentSection = 'cart';
  }

  return {
    conversionRate,
    behavior: {
      items_per_session: itemsPerSession,
      peak_viewed_item: Object.entries(viewedItems).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      abandonment_section: abandonmentSection,
    },
    chatbotStats: {
      conversations: counts.chat_open || 0,
      messages: counts.chatbot_message_sent || 0,
      orders: chatOrderCount,
      conversion_rate: (counts.chat_open || 0) > 0 ? Math.round(chatOrderCount / counts.chat_open * 100) : 0,
    },
    languageBreakdown,
    funnel: {
      page_views: pageViews,
      cart_adds: counts.cart_add || 0,
      checkout_starts: checkoutStarts,
      orders_completed: ordersCompleted,
      checkout_failed: counts.checkout_failed || 0,
    },
  };
}

// ── AI insights generation ──

async function generateAIInsights(restaurantName, orderMetrics, prevOrderMetrics, eventMetrics) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { hero_insight: 'AI insights no disponible (API key no configurada).', actions: [] };

  const prompt = `Eres un consultor de restaurantes analizando los datos semanales de "${restaurantName}".

DATOS DE ESTA SEMANA:
- Órdenes: ${orderMetrics.totalOrders}
- Ventas: RD$${orderMetrics.totalRevenue.toLocaleString()}
- Ticket promedio: RD$${orderMetrics.avgTicket.toLocaleString()}
- Top productos: ${orderMetrics.topItems.slice(0, 5).map(t => `${t.name} (${t.units} uds, RD$${t.revenue.toLocaleString()})`).join(', ')}
- Productos con pocas ventas: ${orderMetrics.lowItems.map(t => `${t.name} (${t.units} uds)`).join(', ') || 'ninguno'}
- Hora pico: ${orderMetrics.peakHour !== null ? orderMetrics.peakHour + ':00' : 'N/A'}

SEMANA ANTERIOR:
- Órdenes: ${prevOrderMetrics.totalOrders}
- Ventas: RD$${prevOrderMetrics.totalRevenue.toLocaleString()}

CONVERSIÓN:
- Tasa: ${eventMetrics.conversionRate}%
- Funnel: ${eventMetrics.funnel.page_views} visitas → ${eventMetrics.funnel.cart_adds} al carrito → ${eventMetrics.funnel.checkout_starts} checkout → ${eventMetrics.funnel.orders_completed} completadas
- Abandonos en: ${eventMetrics.behavior.abandonment_section || 'ninguno significativo'}

CHATBOT:
- ${eventMetrics.chatbotStats.conversations} conversaciones, ${eventMetrics.chatbotStats.orders} órdenes por chatbot

IDIOMAS de visitantes: ${JSON.stringify(eventMetrics.languageBreakdown)}

Responde en JSON exacto:
{
  "hero_insight": "1 párrafo (3-4 oraciones) con el insight MÁS IMPORTANTE de la semana. Incluye números concretos. Tono directo, como hablándole al dueño.",
  "actions": [
    {"priority": 1, "title": "Título corto", "description": "Descripción accionable de 1-2 oraciones"},
    {"priority": 2, "title": "Título corto", "description": "Descripción accionable de 1-2 oraciones"},
    {"priority": 3, "title": "Título corto", "description": "Descripción accionable de 1-2 oraciones"}
  ]
}

SOLO JSON, sin markdown, sin backticks.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[generate-insights] Claude API error:', JSON.stringify(data));
      return { hero_insight: `No se pudo generar el análisis AI (HTTP ${response.status}: ${data.error?.message || 'unknown'}).`, actions: [] };
    }

    const rawText = data.content.find(c => c.type === 'text')?.text || '';
    console.log('[generate-insights] Claude raw response:', rawText.substring(0, 500));

    // Strip markdown code fences if present
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[generate-insights] JSON parse failed:', parseErr.message, '| Raw text:', rawText.substring(0, 300));
      return { hero_insight: rawText.substring(0, 500), actions: [] };
    }
  } catch (e) {
    console.error('[generate-insights] AI fetch error:', e.message, e.stack);
    return { hero_insight: `Error generando insights AI: ${e.message}`, actions: [] };
  }
}

// ── Handler ──

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  // Support both GET (cron) and POST (manual)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: cron secret or webhook secret
  const authHeader = req.headers['authorization'];
  const webhookSecret = req.headers['x-webhook-secret'];
  const cronSecret = process.env.CRON_SECRET;
  const expectedWebhookSecret = process.env.SUPABASE_WEBHOOK_SECRET;

  const isAuthedCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isAuthedWebhook = expectedWebhookSecret && webhookSecret === expectedWebhookSecret;

  if (!isAuthedCron && !isAuthedWebhook) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  try {
    // If POST with specific slug, process just that restaurant
    // If GET (cron), process all active restaurants
    let slugs = [];

    if (req.method === 'POST' && req.body?.restaurant_slug) {
      slugs = [req.body.restaurant_slug];
    } else {
      // Fetch all active restaurants
      const rRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?status=eq.active&role=eq.restaurant&select=restaurant_slug`,
        { headers: sbHeaders(), signal: AbortSignal.timeout(5000) }
      );
      if (!rRes.ok) return res.status(500).json({ error: 'Failed to fetch restaurants' });
      const restaurants = await rRes.json();
      slugs = restaurants.map(r => r.restaurant_slug).filter(Boolean);
    }

    console.log(`[generate-insights] Processing ${slugs.length} restaurant(s)`);

    const weekStartInput = req.body?.week_start || null;
    const weekEndInput = req.body?.week_end || null;
    const bounds = getWeekBounds(weekStartInput, weekEndInput);
    const results = [];

    for (const slug of slugs) {
      try {
        const result = await processRestaurant(slug, bounds);
        results.push({ slug, success: true, ...result });
      } catch (e) {
        console.error(`[generate-insights] Error for ${slug}:`, e.message);
        results.push({ slug, success: false, error: e.message });
      }
    }

    return res.status(200).json({
      processed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      week: `${bounds.weekStart} → ${bounds.weekEnd}`,
      results,
    });

  } catch (error) {
    console.error('[generate-insights] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processRestaurant(slug, bounds) {
  // Fetch all data in parallel
  const [thisWeekOrders, prevWeekOrders, events, shifts, restaurantName] = await Promise.all([
    fetchOrders(slug, bounds.weekStartISO, bounds.weekEndISO),
    fetchOrders(slug, bounds.prevWeekStartISO, bounds.prevWeekEndISO),
    fetchPageEvents(slug, bounds.weekStartISO, bounds.weekEndISO),
    fetchShifts(slug, bounds.weekStartISO, bounds.weekEndISO),
    fetchRestaurantName(slug),
  ]);

  const orderMetrics = computeOrderMetrics(thisWeekOrders);
  const prevOrderMetrics = computeOrderMetrics(prevWeekOrders);
  const eventMetrics = computeEventMetrics(events);

  // Generate AI insights
  const aiInsights = await generateAIInsights(restaurantName, orderMetrics, prevOrderMetrics, eventMetrics);

  // Build the row to upsert
  const row = {
    restaurant_slug: slug,
    week_start: bounds.weekStart,
    week_end: bounds.weekEnd,
    total_orders: orderMetrics.totalOrders,
    total_revenue: orderMetrics.totalRevenue,
    avg_ticket: orderMetrics.avgTicket,
    conversion_rate: eventMetrics.conversionRate,
    top_items: orderMetrics.topItems,
    low_items: orderMetrics.lowItems,
    behavior: { ...eventMetrics.behavior, funnel: eventMetrics.funnel },
    chatbot_stats: eventMetrics.chatbotStats,
    language_breakdown: eventMetrics.languageBreakdown,
    ai_insights: aiInsights,
    prev_week_orders: prevOrderMetrics.totalOrders,
    prev_week_revenue: prevOrderMetrics.totalRevenue,
  };

  // Upsert by (restaurant_slug, week_start)
  const upsertRes = await fetch(
    `${supabaseUrl}/rest/v1/restaurant_insights?on_conflict=restaurant_slug,week_start`,
    {
      method: 'POST',
      headers: {
        ...sbHeaders(),
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(row),
    }
  );

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    throw new Error(`Upsert failed: ${errText}`);
  }

  console.log(`[generate-insights] ${slug}: ${orderMetrics.totalOrders} orders, RD$${orderMetrics.totalRevenue}, conversion ${eventMetrics.conversionRate}%`);

  return {
    total_orders: orderMetrics.totalOrders,
    total_revenue: orderMetrics.totalRevenue,
    conversion_rate: eventMetrics.conversionRate,
    hero_insight: aiInsights.hero_insight,
  };
}
