import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Fetch user by username
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&status=eq.active&select=*`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!userRes.ok) {
      console.error('Supabase error:', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    const user = users[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    return res.status(200).json({
      success: true,
      role: user.role,
      restaurant_slug: user.restaurant_slug,
      display_name: user.display_name,
      username: user.username,
      ...(user.role === 'admin' && process.env.ADMIN_API_KEY ? { adminToken: process.env.ADMIN_API_KEY } : {}),
    });

  } catch (error) {
    console.error('auth error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
