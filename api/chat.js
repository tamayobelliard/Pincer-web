export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Solo permitir POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, salesData } = req.body;

  try {
    const systemPrompt = `You are a friendly restaurant sales analyst assistant for Mr. Sandwich by Chef Elly.

You have access to daily sales data with these fields:
- date: fecha de la venta
- total_orders: total de órdenes del día
- total_sales: ventas totales en RD$ (pesos dominicanos)
- avg_ticket: ticket promedio
- top_item: producto más vendido
- top_item_count: cantidad del top item
- peak_hour: hora pico (0-23)
- peak_hour_orders: órdenes en hora pico

IMPORTANT RULES:
1. Always respond in Spanish
2. Use a friendly, conversational tone (like talking to the restaurant owner)
3. Format numbers with commas for readability (e.g., RD$1,500)
4. When showing dates, use format: "Lunes 5 de Febrero"
5. Use emojis to make responses engaging: 📊💰🎉📈
6. If data is empty or insufficient, be honest and helpful
7. Keep responses concise (2-3 paragraphs max)
8. Always end with a helpful insight or suggestion

Sales Data:
${JSON.stringify(salesData, null, 2)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(response.status).json({ 
        error: `Claude API error: ${data.error?.message || 'Unknown error'}` 
      });
    }

    const answer = data.content.find(c => c.type === 'text')?.text || 'No pude generar una respuesta.';

    res.status(200).json({ answer });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  }
}
