import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';

export const config = { maxDuration: 30 };

const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Data fetchers (all server-side with service role) ──

async function fetchWeeklyOrders(slug) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch this week + last week for comparison
  const res = await fetch(
    `${supabaseUrl}/rest/v1/orders?restaurant_slug=eq.${encodeURIComponent(slug)}&created_at=gte.${encodeURIComponent(fourteenDaysAgo)}&select=items,total,created_at,order_type,status&order=created_at.desc&limit=5000`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return { thisWeek: [], lastWeek: [] };
  const orders = await res.json();

  const thisWeek = [];
  const lastWeek = [];
  for (const o of orders) {
    if (o.created_at >= sevenDaysAgo) thisWeek.push(o);
    else lastWeek.push(o);
  }
  return { thisWeek, lastWeek };
}

function computeOrderMetrics(orders) {
  if (!orders.length) return { totalOrders: 0, totalSales: 0, avgTicket: 0, topItems: [], peakHours: [], orderTypes: {} };

  let totalSales = 0;
  const itemCounts = {};
  const hourCounts = {};
  const typeCounts = {};

  for (const o of orders) {
    totalSales += o.total || 0;

    // Count order types
    const ot = o.order_type || 'unknown';
    typeCounts[ot] = (typeCounts[ot] || 0) + 1;

    // Count items
    try {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.id?.startsWith('extra_') || item.name?.toLowerCase().startsWith('extra ')) continue;
          const name = item.name || item.id || 'Unknown';
          const qty = item.qty || 1;
          itemCounts[name] = (itemCounts[name] || 0) + qty;
        }
      }
    } catch { /* skip */ }

    // Count hours (DR timezone UTC-4)
    if (o.created_at) {
      const hour = new Date(o.created_at).getUTCHours();
      const drHour = (hour - 4 + 24) % 24;
      hourCounts[drHour] = (hourCounts[drHour] || 0) + 1;
    }
  }

  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const peakHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour, count]) => ({ hour: parseInt(hour), count }));

  return {
    totalOrders: orders.length,
    totalSales,
    avgTicket: orders.length > 0 ? Math.round(totalSales / orders.length) : 0,
    topItems,
    peakHours,
    orderTypes: typeCounts,
  };
}

async function fetchInsights(slug) {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_insights?restaurant_slug=eq.${encodeURIComponent(slug)}&select=week_start,week_end,total_orders,total_revenue,avg_ticket,conversion_rate,top_items,low_items,behavior,chatbot_stats,language_breakdown,ai_insights,prev_week_orders,prev_week_revenue&order=week_start.desc&limit=1`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
}

async function fetchConversionData(slug) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/page_events?restaurant_slug=eq.${encodeURIComponent(slug)}&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=event_type,event_data&limit=10000`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const events = await res.json();

    const counts = {};
    const viewedItems = {};
    const cartItems = {};

    for (const e of events) {
      counts[e.event_type] = (counts[e.event_type] || 0) + 1;

      if (e.event_type === 'menu_item_viewed' && e.event_data?.item_name) {
        const name = e.event_data.item_name;
        viewedItems[name] = (viewedItems[name] || 0) + 1;
      }
      if (e.event_type === 'cart_add' && e.event_data?.item_name) {
        const name = e.event_data.item_name;
        cartItems[name] = (cartItems[name] || 0) + 1;
      }
    }

    const topViewed = Object.entries(viewedItems)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const topCarted = Object.entries(cartItems)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      pageViews: counts.page_view || 0,
      itemViews: counts.item_view || 0,
      cartAdds: counts.cart_add || 0,
      checkoutStarts: counts.checkout_start || 0,
      ordersCompleted: counts.order_complete || 0,
      checkoutFailed: counts.checkout_failed || 0,
      chatOpens: counts.chat_open || 0,
      chatMessages: counts.chatbot_message_sent || 0,
      topViewed,
      topCarted,
    };
  } catch { return null; }
}

async function fetchLastShift(slug) {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/shifts?restaurant_slug=eq.${encodeURIComponent(slug)}&status=eq.cerrado&select=opened_at,closed_at,total_ordenes,total_ventas,top_products&order=closed_at.desc&limit=1`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
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

// ── System prompt builder ──

function formatHour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${suffix}`;
}

function buildSystemPrompt(restaurantName, thisWeekMetrics, lastWeekMetrics, insights, conversion, lastShift) {
  const lines = [];

  lines.push(`Eres el asistente de ventas de ${restaurantName}. Tienes acceso a data real del restaurante.`);
  lines.push('');

  // Weekly sales
  lines.push('## VENTAS ÚLTIMOS 7 DÍAS');
  lines.push(`- Total órdenes: ${thisWeekMetrics.totalOrders}`);
  lines.push(`- Total ventas: RD$${thisWeekMetrics.totalSales.toLocaleString()}`);
  lines.push(`- Ticket promedio: RD$${thisWeekMetrics.avgTicket.toLocaleString()}`);

  if (thisWeekMetrics.topItems.length > 0) {
    lines.push('- Top productos: ' + thisWeekMetrics.topItems.map((t, i) => `${i + 1}. ${t.name} (${t.count})`).join(', '));
  }

  if (thisWeekMetrics.peakHours.length > 0) {
    lines.push('- Horas pico: ' + thisWeekMetrics.peakHours.map(p => `${formatHour(p.hour)} (${p.count} órdenes)`).join(', '));
  }

  const types = thisWeekMetrics.orderTypes;
  const typeTotal = Object.values(types).reduce((s, v) => s + v, 0) || 1;
  if (Object.keys(types).length > 0) {
    const typeParts = Object.entries(types).map(([t, c]) => `${t}: ${Math.round(c / typeTotal * 100)}%`);
    lines.push('- Por tipo de orden: ' + typeParts.join(', '));
  }

  // Week-over-week comparison
  lines.push('');
  lines.push('## COMPARACIÓN SEMANAL');
  lines.push(`- Esta semana: ${thisWeekMetrics.totalOrders} órdenes, RD$${thisWeekMetrics.totalSales.toLocaleString()}`);
  lines.push(`- Semana anterior: ${lastWeekMetrics.totalOrders} órdenes, RD$${lastWeekMetrics.totalSales.toLocaleString()}`);
  if (lastWeekMetrics.totalOrders > 0) {
    const orderChange = Math.round((thisWeekMetrics.totalOrders - lastWeekMetrics.totalOrders) / lastWeekMetrics.totalOrders * 100);
    const salesChange = Math.round((thisWeekMetrics.totalSales - lastWeekMetrics.totalSales) / lastWeekMetrics.totalSales * 100);
    lines.push(`- Cambio: ${orderChange >= 0 ? '+' : ''}${orderChange}% órdenes, ${salesChange >= 0 ? '+' : ''}${salesChange}% ventas`);
  }

  // Conversion funnel
  if (conversion) {
    lines.push('');
    lines.push('## CONVERSIÓN (últimos 7 días)');
    lines.push(`- Visitas al menú: ${conversion.pageViews}`);
    lines.push(`- Agregaron al carrito: ${conversion.cartAdds}${conversion.pageViews > 0 ? ` (${Math.round(conversion.cartAdds / conversion.pageViews * 100)}%)` : ''}`);
    lines.push(`- Iniciaron checkout: ${conversion.checkoutStarts}`);
    lines.push(`- Completaron orden: ${conversion.ordersCompleted}${conversion.pageViews > 0 ? ` (tasa: ${Math.round(conversion.ordersCompleted / conversion.pageViews * 100)}%)` : ''}`);
    if (conversion.checkoutStarts > conversion.ordersCompleted) {
      lines.push(`- Abandonos en checkout: ${conversion.checkoutStarts - conversion.ordersCompleted}`);
    }
    if (conversion.checkoutFailed > 0) {
      lines.push(`- Errores de checkout: ${conversion.checkoutFailed}`);
    }

    if (conversion.topViewed.length > 0) {
      lines.push('');
      lines.push('## COMPORTAMIENTO DEL MENÚ');
      lines.push('- Items más vistos: ' + conversion.topViewed.map(t => `${t.name} (${t.count} vistas)`).join(', '));
    }
    if (conversion.topCarted.length > 0) {
      lines.push('- Items más agregados al carrito: ' + conversion.topCarted.map(t => `${t.name} (${t.count})`).join(', '));
    }
    if (conversion.chatOpens > 0 || conversion.chatMessages > 0) {
      lines.push(`- Chatbot: ${conversion.chatOpens} conversaciones, ${conversion.chatMessages} mensajes enviados`);
    }
  }

  // Last shift
  if (lastShift) {
    lines.push('');
    lines.push('## ÚLTIMO TURNO CERRADO');
    if (lastShift.closed_at) {
      const d = new Date(lastShift.closed_at);
      lines.push(`- Cerrado: ${d.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' })}`);
    }
    lines.push(`- Órdenes: ${lastShift.total_ordenes || 0}`);
    lines.push(`- Ventas: RD$${(lastShift.total_ventas || 0).toLocaleString()}`);
    if (lastShift.top_products && Array.isArray(lastShift.top_products)) {
      lines.push('- Top productos: ' + lastShift.top_products.slice(0, 3).map(p => `${p.name} (${p.qty})`).join(', '));
    }
  }

  // Weekly report insights
  if (insights) {
    lines.push('');
    lines.push(`## REPORTE SEMANAL (${insights.week_start || '?'} a ${insights.week_end || '?'})`);
    if (insights.ai_insights?.hero_insight) {
      lines.push('Insight principal: ' + insights.ai_insights.hero_insight);
    }
    if (insights.ai_insights?.actions?.length > 0) {
      lines.push('Acciones recomendadas:');
      for (const a of insights.ai_insights.actions) {
        lines.push(`  ${a.priority}. ${a.title}: ${a.description}`);
      }
    }
    if (insights.low_items?.length > 0) {
      lines.push('Productos con pocas ventas: ' + insights.low_items.map(i => `${i.name} (${i.units} uds)`).join(', '));
    }
    if (insights.chatbot_stats) {
      lines.push(`Chatbot: ${insights.chatbot_stats.conversations} conversaciones, ${insights.chatbot_stats.orders} órdenes, tasa ${insights.chatbot_stats.conversion_rate}%`);
    }
    if (insights.language_breakdown) {
      const langs = Object.entries(insights.language_breakdown).map(([k, v]) => `${k}: ${v}%`).join(', ');
      lines.push('Idiomas de visitantes: ' + langs);
    }
  }

  // Rules
  lines.push('');
  lines.push('## REGLAS');
  lines.push('1. SIEMPRE responde en español');
  lines.push('2. Tono amigable y conversacional (como hablando con el dueño del restaurante)');
  lines.push('3. Formatea números con comas: RD$1,500');
  lines.push('4. Usa emojis para engagement: 📊💰🎉📈📉🔥⭐');
  lines.push('5. Máximo 2-3 párrafos por respuesta');
  lines.push('6. Siempre termina con un insight accionable o sugerencia');
  lines.push('7. Si no hay data suficiente, sé honesto');
  lines.push('8. Compara períodos cuando sea relevante');
  lines.push('9. Cuando muestres fechas usa: "Lunes 5 de Febrero"');
  lines.push('10. Si te preguntan algo que no está en los datos, dilo claramente');

  return lines.join('\n');
}

// ── Handler ──

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 20, windowMs: 60000, prefix: 'chat' })) return;

  if (!supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { question, restaurant_slug, messages } = req.body;
  if (!question || !restaurant_slug) {
    return res.status(400).json({ error: 'question and restaurant_slug required' });
  }

  try {
    // Fetch all data in parallel
    const [orderData, insights, conversion, lastShift, restaurantName] = await Promise.all([
      fetchWeeklyOrders(restaurant_slug),
      fetchInsights(restaurant_slug),
      fetchConversionData(restaurant_slug),
      fetchLastShift(restaurant_slug),
      fetchRestaurantName(restaurant_slug),
    ]);

    const thisWeekMetrics = computeOrderMetrics(orderData.thisWeek);
    const lastWeekMetrics = computeOrderMetrics(orderData.lastWeek);

    const systemPrompt = buildSystemPrompt(
      restaurantName, thisWeekMetrics, lastWeekMetrics,
      insights, conversion, lastShift
    );

    // Build messages array (support multi-turn)
    const chatMessages = [];
    if (Array.isArray(messages) && messages.length > 0) {
      for (const m of messages) {
        chatMessages.push({ role: m.role, content: m.content });
      }
    }
    chatMessages.push({ role: 'user', content: question });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: chatMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[chat] Claude API error:', data);
      return res.status(response.status).json({
        error: `Claude API error: ${data.error?.message || 'Unknown error'}`,
      });
    }

    const answer = data.content.find(c => c.type === 'text')?.text || 'No pude generar una respuesta.';

    res.status(200).json({ answer });

  } catch (error) {
    console.error('[chat] Server error:', error);
    res.status(500).json({ error: error.message });
  }
}
