import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { handleCors } from './cors.js';
import { verifyRestaurantSession } from './verify-session.js';

export const config = { maxDuration: 15 };

const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
}

// ── Colors ──
const RED     = rgb(0.86, 0.15, 0.16);  // #DC2626
const NAVY    = rgb(0.06, 0.09, 0.16);  // #0F172A
const SLATE   = rgb(0.39, 0.45, 0.53);  // #64748B
const LGRAY   = rgb(0.85, 0.85, 0.87);  // #D9D9DE
const BG      = rgb(0.96, 0.96, 0.97);  // #F5F5F7
const WHITE   = rgb(1, 1, 1);
const GREEN   = rgb(0.05, 0.65, 0.31);  // #0DA650
const BLACK   = rgb(0, 0, 0);

// ── Date helpers ──


function formatDateES(dateStr) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} de ${months[d.getUTCMonth()]}`;
}

function fmtNum(n) {
  return (n || 0).toLocaleString('es-DO');
}

function fmtPct(curr, prev) {
  if (!prev || prev === 0) return '';
  const change = Math.round((curr - prev) / prev * 100);
  return change >= 0 ? `+${change}%` : `${change}%`;
}

function formatHour(h) {
  if (h === null || h === undefined) return 'N/A';
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${suffix}`;
}

// ── PDF drawing helpers ──

function drawText(page, text, x, y, font, size, color) {
  page.drawText(String(text || ''), { x, y, size, font, color: color || NAVY });
}

function drawCenteredText(page, text, y, font, size, color, pageWidth) {
  const w = font.widthOfTextAtSize(String(text || ''), size);
  page.drawText(String(text || ''), { x: (pageWidth - w) / 2, y, size, font, color: color || NAVY });
}

function drawRightText(page, text, x, y, font, size, color) {
  const w = font.widthOfTextAtSize(String(text || ''), size);
  page.drawText(String(text || ''), { x: x - w, y, size, font, color: color || NAVY });
}

function drawBox(page, x, y, w, h, color) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawLine(page, x1, y1, x2, y2, color, thickness) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color: color || LGRAY, thickness: thickness || 1 });
}

// Wrap long text into multiple lines
function wrapText(text, font, size, maxWidth) {
  const words = (text || '').split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── PDF generation ──

async function generateReportPDF(insight, restaurantName) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const W = 595; // A4 width
  const H = 842; // A4 height
  const M = 40;  // margin
  const CW = W - 2 * M; // content width

  // ═══════════════════════════════════════════════
  // PAGE 1 — Executive Summary
  // ═══════════════════════════════════════════════
  const p1 = doc.addPage([W, H]);
  let y = H - M;

  // Header bar
  drawBox(p1, 0, H - 80, W, 80, NAVY);
  drawText(p1, 'PINCER', M, H - 35, bold, 22, WHITE);
  drawText(p1, 'Reporte Semanal', M, H - 55, regular, 12, rgb(0.7, 0.7, 0.8));
  drawRightText(p1, restaurantName, W - M, H - 35, bold, 14, WHITE);
  drawRightText(p1, `${formatDateES(insight.week_start)} — ${formatDateES(insight.week_end)}`, W - M, H - 55, regular, 10, rgb(0.7, 0.7, 0.8));

  y = H - 110;

  // 4 KPI boxes (2x2 grid)
  const boxW = (CW - 20) / 2;
  const boxH = 80;
  const kpis = [
    { label: 'Total Órdenes', value: fmtNum(insight.total_orders), delta: fmtPct(insight.total_orders, insight.prev_week_orders) },
    { label: 'Total Ventas', value: `RD$${fmtNum(insight.total_revenue)}`, delta: fmtPct(insight.total_revenue, insight.prev_week_revenue) },
    { label: 'Ticket Promedio', value: `RD$${fmtNum(insight.avg_ticket)}`, delta: '' },
    { label: 'Conversión', value: `${insight.conversion_rate || 0}%`, delta: '' },
  ];

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bx = M + col * (boxW + 20);
    const by = y - row * (boxH + 15);
    drawBox(p1, bx, by - boxH, boxW, boxH, BG);

    drawText(p1, kpis[i].label, bx + 15, by - 22, regular, 10, SLATE);
    drawText(p1, kpis[i].value, bx + 15, by - 48, bold, 22, NAVY);
    if (kpis[i].delta) {
      const deltaColor = kpis[i].delta.startsWith('+') ? GREEN : RED;
      drawText(p1, kpis[i].delta, bx + 15, by - 68, bold, 11, deltaColor);
    }
  }

  y = y - 2 * (boxH + 15) - 25;

  // Hero Insight section
  const heroText = insight.ai_insights?.hero_insight || 'No hay insights disponibles para esta semana.';
  drawBox(p1, M, y - 10, CW, 4, RED);
  y -= 30;
  drawText(p1, 'Insight Principal', M, y, bold, 14, RED);
  y -= 20;

  const heroLines = wrapText(heroText, regular, 10, CW - 10);
  for (const line of heroLines) {
    drawText(p1, line, M + 5, y, regular, 10, NAVY);
    y -= 16;
  }

  // ═══════════════════════════════════════════════
  // PAGE 2 — Products & Conversion
  // ═══════════════════════════════════════════════
  const p2 = doc.addPage([W, H]);
  y = H - M;

  // Section: Top Products
  drawText(p2, 'Top Productos', M, y, bold, 16, NAVY);
  y -= 8;
  drawLine(p2, M, y, W - M, y, RED, 2);
  y -= 22;

  // Table header
  drawText(p2, 'Producto', M, y, bold, 10, SLATE);
  drawText(p2, 'Unidades', M + 280, y, bold, 10, SLATE);
  drawRightText(p2, 'Revenue', W - M, y, bold, 10, SLATE);
  y -= 5;
  drawLine(p2, M, y, W - M, y, LGRAY);
  y -= 15;

  const topItems = insight.top_items || [];
  for (let i = 0; i < Math.min(topItems.length, 10); i++) {
    const item = topItems[i];
    if (i % 2 === 0) drawBox(p2, M, y - 4, CW, 18, BG);
    drawText(p2, `${i + 1}. ${item.name}`, M + 5, y, regular, 10, NAVY);
    drawText(p2, String(item.units || 0), M + 285, y, regular, 10, NAVY);
    drawRightText(p2, `RD$${fmtNum(item.revenue)}`, W - M - 5, y, regular, 10, NAVY);
    y -= 20;
  }

  // Low items
  const lowItems = insight.low_items || [];
  if (lowItems.length > 0) {
    y -= 15;
    drawText(p2, 'Productos con Pocas Ventas', M, y, bold, 12, RED);
    y -= 18;
    for (const item of lowItems) {
      drawText(p2, `• ${item.name} — ${item.units} vendidos`, M + 10, y, regular, 10, SLATE);
      y -= 16;
    }
  }

  // Conversion Funnel
  y -= 25;
  drawText(p2, 'Funnel de Conversión', M, y, bold, 16, NAVY);
  y -= 8;
  drawLine(p2, M, y, W - M, y, RED, 2);
  y -= 30;

  const behavior = insight.behavior || {};
  const funnel = [
    { label: 'Visitas al menú', value: '—' },
    { label: 'Agregaron al carrito', value: '—' },
    { label: 'Iniciaron checkout', value: '—' },
    { label: 'Completaron orden', value: '—' },
  ];

  // Funnel boxes
  const funnelW = [CW, CW * 0.82, CW * 0.64, CW * 0.50];
  for (let i = 0; i < funnel.length; i++) {
    const fw = funnelW[i];
    const fx = M + (CW - fw) / 2;
    drawBox(p2, fx, y - 28, fw, 30, i === 3 ? RED : BG);
    const textColor = i === 3 ? WHITE : NAVY;
    drawText(p2, funnel[i].label, fx + 10, y - 20, regular, 10, textColor);
    drawRightText(p2, funnel[i].value, fx + fw - 10, y - 20, bold, 10, textColor);
    y -= 38;
  }

  // Behavior notes
  y -= 10;
  if (behavior.items_per_session) {
    drawText(p2, `Items por sesión: ${behavior.items_per_session}`, M, y, regular, 10, SLATE);
    y -= 16;
  }
  if (behavior.abandonment_section) {
    drawText(p2, `Mayor abandono en: ${behavior.abandonment_section}`, M, y, regular, 10, RED);
    y -= 16;
  }

  // ═══════════════════════════════════════════════
  // PAGE 3 — AI Actions, Chatbot & Languages
  // ═══════════════════════════════════════════════
  const p3 = doc.addPage([W, H]);
  y = H - M;

  // Section: Recommended Actions
  drawText(p3, 'Acciones Recomendadas', M, y, bold, 16, NAVY);
  y -= 8;
  drawLine(p3, M, y, W - M, y, RED, 2);
  y -= 25;

  const actions = insight.ai_insights?.actions || [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    // Priority badge
    const badgeColors = [RED, rgb(0.92, 0.58, 0.05), SLATE];
    drawBox(p3, M, y - 15, 24, 22, badgeColors[i] || SLATE);
    drawCenteredText(p3, String(a.priority || i + 1), y - 8, bold, 12, WHITE, M * 2 + 24);

    drawText(p3, a.title || '', M + 34, y, bold, 12, NAVY);
    y -= 18;

    const descLines = wrapText(a.description || '', regular, 10, CW - 44);
    for (const line of descLines) {
      drawText(p3, line, M + 34, y, regular, 10, SLATE);
      y -= 15;
    }
    y -= 12;
  }

  // Section: Chatbot Stats
  y -= 10;
  drawText(p3, 'Chatbot', M, y, bold, 16, NAVY);
  y -= 8;
  drawLine(p3, M, y, W - M, y, RED, 2);
  y -= 25;

  const chat = insight.chatbot_stats || {};
  const chatRows = [
    ['Conversaciones', String(chat.conversations || 0)],
    ['Mensajes enviados', String(chat.messages || 0)],
    ['Órdenes por chatbot', String(chat.orders || 0)],
    ['Tasa de conversión', `${chat.conversion_rate || 0}%`],
  ];
  for (const [label, val] of chatRows) {
    drawText(p3, label, M + 10, y, regular, 10, NAVY);
    drawRightText(p3, val, W - M, y, bold, 10, NAVY);
    y -= 20;
  }

  // Section: Language breakdown
  y -= 15;
  drawText(p3, 'Idiomas de Visitantes', M, y, bold, 16, NAVY);
  y -= 8;
  drawLine(p3, M, y, W - M, y, RED, 2);
  y -= 25;

  const langs = insight.language_breakdown || {};
  const langNames = { es: 'Español', en: 'English', fr: 'Français', ht: 'Kreyòl', other: 'Otros' };
  const langColors = [RED, rgb(0.25, 0.47, 0.85), GREEN, rgb(0.6, 0.4, 0.8), SLATE];
  let li = 0;
  for (const [code, pct] of Object.entries(langs)) {
    if (pct === 0) continue;
    const barW = Math.max(5, (CW - 120) * pct / 100);
    drawBox(p3, M + 100, y - 4, barW, 14, langColors[li % langColors.length]);
    drawText(p3, langNames[code] || code, M + 10, y, regular, 10, NAVY);
    drawText(p3, `${pct}%`, M + 105 + barW, y, bold, 10, NAVY);
    y -= 22;
    li++;
  }

  // Footer
  y = M + 20;
  drawLine(p3, M, y + 10, W - M, y + 10, LGRAY);
  const generatedDate = new Date().toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });
  drawCenteredText(p3, `Generado por Pincer · ${generatedDate}`, y - 5, regular, 9, SLATE, W);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString('base64');
}

// ── Handler ──

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabaseKey) return res.status(500).json({ error: 'Server misconfigured' });

  // Auth
  const token = req.headers['x-restaurant-token'];
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ error: 'Sesión inválida' });

  const slug = req.query.slug || session.restaurant_slug;
  if (slug !== session.restaurant_slug) return res.status(403).json({ error: 'No autorizado para este restaurante' });

  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;

  try {
    // Fetch insight: by specific date_from, or most recent available
    let insightUrl;
    if (dateFrom) {
      insightUrl = `${supabaseUrl}/rest/v1/restaurant_insights?restaurant_slug=eq.${encodeURIComponent(slug)}&week_start=eq.${dateFrom}&select=*&limit=1`;
    } else {
      insightUrl = `${supabaseUrl}/rest/v1/restaurant_insights?restaurant_slug=eq.${encodeURIComponent(slug)}&select=*&order=week_start.desc&limit=1`;
    }
    const insightRes = await fetch(insightUrl, { headers: sbHeaders(), signal: AbortSignal.timeout(5000) });

    if (!insightRes.ok) return res.status(500).json({ error: 'Error leyendo datos' });
    const rows = await insightRes.json();

    if (!rows.length) {
      return res.status(404).json({ error: `No hay reporte disponible${dateFrom ? ' para ' + dateFrom : ''}. Genera uno primero.` });
    }

    const insight = rows[0];

    // Fetch restaurant name
    const nameRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=display_name&limit=1`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(3000) }
    );
    const nameRows = await nameRes.json().catch(() => []);
    const restaurantName = nameRows[0]?.display_name || slug;

    // Generate PDF
    const pdf = await generateReportPDF(insight, restaurantName);

    return res.status(200).json({
      pdf,
      week_start: insight.week_start,
      week_end: insight.week_end,
    });

  } catch (error) {
    console.error('[download-report] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
