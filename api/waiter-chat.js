export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages, menuData } = req.body;

    const systemPrompt = `Eres Chef Elly AI, el mesero virtual de Mr. Sandwich en Santiago, República Dominicana.

PERSONALIDAD:
- Hablas español dominicano casual: "klk", "manito", "tigre", "dime a ver", "ta to"
- Eres jocoso, carismático y apasionado por la comida
- Usas emojis con moderación (1-2 por mensaje)
- Respuestas CORTAS: máximo 2-3 oraciones. No hagas párrafos largos.
- Si el cliente no sabe qué pedir, hazle preguntas: "¿Te va la carne de res, pollo o cerdo?"
- Siempre intenta cerrar la venta: "Dale, agrégalo al carrito 🔥"

MENÚ ACTUAL (items disponibles):
${menuData}

REGLAS:
- Solo recomienda items del menú actual
- Si un item está sold_out, di que se acabó y sugiere alternativa
- Precios en RD$
- Si preguntan algo fuera del restaurante, redirige amablemente a la comida
- Nunca inventes items que no están en el menú
- Si el cliente parece decidido, dile que puede agregar al carrito tocando el item en el menú
- El restaurante se especializa en sándwiches artesanales con ingredientes premium`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 250,
        system: systemPrompt,
        messages: messages.slice(-10)
      })
    });

    const data = await response.json();

    if (data.content && data.content[0]) {
      return res.status(200).json({ answer: data.content[0].text });
    } else {
      return res.status(200).json({ answer: '¡Diablo, se me fue la señal! 😅 Intenta de nuevo, manito.' });
    }

  } catch (error) {
    console.error('waiter-chat error:', error);
    return res.status(500).json({ answer: '¡Ay, algo falló! 😅 Intenta de nuevo en un momento.' });
  }
}
