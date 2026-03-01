export const config = { maxDuration: 30 };

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseKey || !anthropicKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Fetch active restaurants
    let restaurants = [];
    try {
      const rRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?status=eq.active&role=eq.restaurant&select=display_name,restaurant_slug,order_types,hours,address,business_type`,
        {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (rRes.ok) restaurants = await rRes.json();
    } catch (e) { console.error('pincer-chat: restaurants fetch error:', e.message); }

    // Fetch all products grouped by restaurant
    let products = [];
    try {
      const pRes = await fetch(
        `${supabaseUrl}/rest/v1/products?active=eq.true&select=name,price,category,restaurant_slug&order=restaurant_slug,display_order`,
        {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (pRes.ok) products = await pRes.json();
    } catch (e) { console.error('pincer-chat: products fetch error:', e.message); }

    // Build restaurant directory for system prompt
    const restaurantList = restaurants.map(r => {
      const types = (r.order_types || []).map(t => {
        if (t === 'dine_in') return 'Comer aqui';
        if (t === 'take_out') return 'Para llevar';
        if (t === 'delivery') return 'Delivery';
        return t;
      }).join(', ');
      const items = products
        .filter(p => p.restaurant_slug === r.restaurant_slug)
        .map(p => `  - ${p.name} (RD$${p.price}, ${p.category})`)
        .join('\n');
      return `${r.display_name} [slug: /${r.restaurant_slug}]
  Tipo: ${r.business_type || 'Restaurante'}
  Orden: ${types || 'Comer aqui'}
  Horario: ${r.hours || 'No especificado'}
  Direccion: ${r.address || 'No especificada'}
${items ? '  Menu:\n' + items : '  (Sin menu cargado)'}`;
    }).join('\n\n');

    const systemPrompt = `REGLA ABSOLUTA: Responde SIEMPRE en español, sin excepcion, aunque el usuario escriba en otro idioma.

Eres el asistente virtual de Pincer, plataforma dominicana de pedidos digitales por QR.
Tu tono es amigable, profesional y conciso. Usas emojis con moderacion (1-2 por mensaje).
Respuestas CORTAS: maximo 2-3 oraciones por mensaje.

Ayudas a dos tipos de usuarios:

1. RESTAURANTES que quieren registrarse:
   - Explica que Pincer es un sistema de pedidos por QR: menu digital + chatbot IA + dashboard + analiticas
   - Registro gratis en pincerweb.com/signup
   - Prueba gratuita de 30 dias con todas las funciones premium
   - Incluye kit de hardware (QR codes impresos, soporte de mesa)
   - Ganan con Azul por cada transaccion procesada
   - Ideal para food trucks, food parks, bares, restaurantes y cafeterias
   - Si preguntan como registrarse: [LINK: Registrar mi negocio | /signup]

2. CLIENTES que quieren comer:
   - Ayuda a encontrar restaurantes segun preferencias, tipo de comida, delivery/takeout/dine-in
   - Cuando recomiendes un restaurante, SIEMPRE incluye el link con formato: [LINK: nombre | /slug]
   - Puedes recomendar platos especificos del menu de cada restaurante
   - Si no hay restaurantes que coincidan, sugiere explorar las opciones disponibles

FORMATO:
- Al final de cada mensaje incluye botones: [BUTTONS: opcion1 | opcion2 | opcion3]
- Maximo 4 botones por mensaje
- Para links a restaurantes o paginas usa: [LINK: texto visible | /ruta]
- SIEMPRE incluye [BUTTONS:] al final

RESTAURANTES ACTIVOS EN PINCER:

${restaurantList || '(No hay restaurantes activos actualmente)'}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages.slice(-10),
      }),
      signal: AbortSignal.timeout(25000),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('pincer-chat Claude error:', data);
      return res.status(200).json({ answer: 'Ups, algo salio mal. Intenta de nuevo 😅' });
    }

    const answer = data.content?.find(c => c.type === 'text')?.text || 'Ups, algo salio mal 😅';
    return res.status(200).json({ answer });

  } catch (error) {
    console.error('pincer-chat error:', error);
    return res.status(200).json({ answer: 'Ups, algo salio mal. Intenta de nuevo 😅' });
  }
}
