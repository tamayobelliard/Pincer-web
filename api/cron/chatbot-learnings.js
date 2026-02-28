export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify cron secret
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server config error' });
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Fetch orders from the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const ordersRes = await fetch(
      `${supabaseUrl}/rest/v1/orders?created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=restaurant_slug,items,total,created_at&order=created_at.desc&limit=5000`,
      { headers: sbHeaders, signal: AbortSignal.timeout(15000) }
    );

    if (!ordersRes.ok) {
      console.error('Orders query error:', ordersRes.status, await ordersRes.text());
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }

    const orders = await ordersRes.json();
    console.log(`Fetched ${orders.length} orders from last 7 days`);

    if (orders.length === 0) {
      return res.status(200).json({ success: true, processed: 0, message: 'No orders in last 7 days' });
    }

    // Group orders by restaurant_slug
    const byRestaurant = {};
    for (const order of orders) {
      const slug = order.restaurant_slug;
      if (!slug) continue;
      if (!byRestaurant[slug]) byRestaurant[slug] = [];
      byRestaurant[slug].push(order);
    }

    const slugs = Object.keys(byRestaurant);
    console.log(`Processing insights for ${slugs.length} restaurant(s)`);

    let processed = 0;
    const errors = [];

    for (const slug of slugs) {
      try {
        const restaurantOrders = byRestaurant[slug];
        const insights = computeInsights(restaurantOrders);

        // Upsert into restaurant_insights
        const upsertRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_insights`,
          {
            method: 'POST',
            headers: {
              ...sbHeaders,
              'Prefer': 'resolution=merge-duplicates,return=representation',
            },
            body: JSON.stringify({
              restaurant_slug: slug,
              top_items: insights.topItems,
              peak_hours: insights.peakHours,
              avg_order_value: insights.avgOrderValue,
              total_orders_7d: insights.totalOrders,
              summary_text: insights.summaryText,
              updated_at: new Date().toISOString(),
            }),
          }
        );

        if (!upsertRes.ok) {
          const errText = await upsertRes.text();
          console.error(`Upsert error for ${slug}:`, errText);
          errors.push({ slug, error: errText });
          continue;
        }

        processed++;
      } catch (e) {
        console.error(`Error processing ${slug}:`, e.message);
        errors.push({ slug, error: e.message });
      }
    }

    return res.status(200).json({ success: true, processed, errors });

  } catch (error) {
    console.error('chatbot-learnings error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function computeInsights(orders) {
  const itemCounts = {};
  const hourCounts = {};
  let totalRevenue = 0;

  for (const order of orders) {
    // Count items
    try {
      const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const name = item.name || item.id || 'Unknown';
          const qty = item.qty || 1;
          itemCounts[name] = (itemCounts[name] || 0) + qty;
        }
      }
    } catch { /* skip unparseable items */ }

    // Count peak hours
    if (order.created_at) {
      const hour = new Date(order.created_at).getUTCHours();
      // Convert to DR timezone (UTC-4)
      const drHour = (hour - 4 + 24) % 24;
      hourCounts[drHour] = (hourCounts[drHour] || 0) + 1;
    }

    // Sum revenue
    if (order.total) {
      totalRevenue += order.total;
    }
  }

  // Top 5 items
  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Peak hours (top 5)
  const peakHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hour, count]) => ({ hour: parseInt(hour), count }));

  const totalOrders = orders.length;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  // Build summary text for chatbot injection
  const lines = [];
  lines.push(`DATOS DE VENTAS (ultimos 7 dias):`);
  lines.push(`- Total de ordenes: ${totalOrders}`);
  lines.push(`- Ticket promedio: RD$${avgOrderValue}`);

  if (topItems.length > 0) {
    lines.push(`- Items mas populares:`);
    topItems.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${item.name} (${item.count} vendidos)`);
    });
  }

  if (peakHours.length > 0) {
    const formatHour = (h) => {
      const suffix = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}${suffix}`;
    };
    const peakStr = peakHours.slice(0, 3).map(p => `${formatHour(p.hour)} (${p.count} ordenes)`).join(', ');
    lines.push(`- Horas pico: ${peakStr}`);
  }

  lines.push(`\nUsa estos datos para hacer recomendaciones inteligentes. Si un cliente no sabe que pedir, recomienda los items mas populares. Menciona la popularidad de forma natural (ej: "ese es de los mas pedidos").`);

  return {
    topItems,
    peakHours,
    avgOrderValue,
    totalOrders,
    summaryText: lines.join('\n'),
  };
}
