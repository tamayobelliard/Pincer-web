import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'shift-report' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const token = getRestaurantToken(req);
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ error: 'Sesión inválida' });

  const { shift_id } = req.body;
  if (!shift_id) return res.status(400).json({ error: 'shift_id requerido' });

  try {
    const slug = session.restaurant_slug;

    // 1. Fetch shift
    const shiftRes = await fetch(
      `${supabaseUrl}/rest/v1/shifts?id=eq.${shift_id}&restaurant_slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!shiftRes.ok) return res.status(500).json({ error: 'Error cargando turno' });
    const shifts = await shiftRes.json();
    if (!shifts.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const shift = shifts[0];

    // 2. Fetch restaurant info
    const restRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(slug)}&select=display_name,logo_url&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    const restRows = await restRes.json().catch(() => []);
    const restaurant = restRows[0] || {};

    // 3. Fetch orders for this shift
    const ordersRes = await fetch(
      `${supabaseUrl}/rest/v1/orders?shift_id=eq.${shift_id}&restaurant_slug=eq.${encodeURIComponent(slug)}&select=*`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!ordersRes.ok) return res.status(500).json({ error: 'Error cargando órdenes' });
    const orders = await ordersRes.json();

    // 4. Calculate metrics
    const summary = calculateMetrics(orders);
    const closeTime = new Date().toISOString();

    // 5. Fetch previous shift for comparison
    const prevRes = await fetch(
      `${supabaseUrl}/rest/v1/shifts?restaurant_slug=eq.${encodeURIComponent(slug)}&status=eq.cerrado&id=neq.${shift_id}&order=closed_at.desc&limit=1&select=total_bruto,total_ordenes`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    const prevShifts = await prevRes.json().catch(() => []);
    const prevShift = prevShifts[0] || null;

    // 6. Fetch all closed shifts today for daily accumulation
    const todayStart = getDRMidnight();
    const dayRes = await fetch(
      `${supabaseUrl}/rest/v1/shifts?restaurant_slug=eq.${encodeURIComponent(slug)}&status=eq.cerrado&created_at=gte.${encodeURIComponent(todayStart)}&select=total_bruto,total_ordenes`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    const dayShifts = await dayRes.json().catch(() => []);

    // Include current shift in daily totals
    const dayTotals = {
      shifts: dayShifts.length + 1,
      ventas: dayShifts.reduce((s, sh) => s + (sh.total_bruto || 0), 0) + summary.total_bruto,
      ordenes: dayShifts.reduce((s, sh) => s + (sh.total_ordenes || 0), 0) + summary.total_ordenes,
    };

    // 7. Update shift with calculated totals and close it
    await fetch(
      `${supabaseUrl}/rest/v1/shifts?id=eq.${shift_id}`,
      {
        method: 'PATCH', headers,
        body: JSON.stringify({
          status: 'cerrado',
          hora_cierre: closeTime,
          closed_at: closeTime,
          ...summary,
        }),
        signal: AbortSignal.timeout(5000),
      }
    );

    // 8. Generate PDF
    const pdf = await generateShiftPDF({
      restaurant: restaurant.display_name || slug,
      encargado: shift.nombre_encargado,
      turno: shift.turno,
      horaInicio: shift.hora_inicio,
      horaCierre: closeTime,
      summary,
      prevShift,
      dayTotals,
    });

    console.log(`[shift-report] ${slug}: shift #${shift_id} closed, ${summary.total_ordenes} orders, RD$${summary.total_bruto}`);
    return res.status(200).json({ pdf, summary });

  } catch (error) {
    console.error('[shift-report] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ══════════════════════════════════════════════════════════════
// METRICS CALCULATION
// ══════════════════════════════════════════════════════════════

function calculateMetrics(orders) {
  const completedStatuses = ['accepted', 'ready', 'notified', 'paid'];
  const cancelledStatuses = ['cancelled', 'canceled'];

  let total_bruto = 0;
  let total_efectivo = 0;
  let total_tarjeta = 0;
  let total_delivery = 0;
  let total_pickup = 0;
  let ordenes_completadas = 0;
  let ordenes_canceladas = 0;
  const itemCounts = {};

  for (const o of orders) {
    const total = o.total || 0;
    total_bruto += total;

    // Payment method (inferred from azul_order_id)
    if (o.azul_order_id) {
      total_tarjeta += total;
    } else {
      total_efectivo += total;
    }

    // Order type
    if (o.order_type === 'delivery') {
      total_delivery++;
    } else {
      total_pickup++;
    }

    // Status
    if (cancelledStatuses.includes(o.status)) {
      ordenes_canceladas++;
    } else if (completedStatuses.includes(o.status)) {
      ordenes_completadas++;
    }

    // Count items for top products
    try {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (Array.isArray(o.items) ? o.items : []);
      for (const item of items) {
        const name = item.name || item.id || 'Desconocido';
        if (!name.toLowerCase().startsWith('extra ')) {
          itemCounts[name] = (itemCounts[name] || 0) + (item.qty || 1);
        }
      }
    } catch {}
  }

  const itbis = Math.round(total_bruto * 0.18);
  const fee_pincer = 0;
  const total_neto = total_bruto - itbis - fee_pincer;

  const topProducts = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  return {
    total_ordenes: orders.length,
    ordenes_completadas,
    ordenes_canceladas,
    total_bruto,
    total_neto,
    fee_pincer,
    itbis,
    total_efectivo,
    total_tarjeta,
    total_delivery,
    total_pickup,
    topProducts,
  };
}

// ══════════════════════════════════════════════════════════════
// PDF GENERATION — 80mm thermal ticket format
// ══════════════════════════════════════════════════════════════

const W = 226; // 80mm at 72dpi
const MARGIN = 12;
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const LGRAY = rgb(0.75, 0.75, 0.75);
const GREEN = rgb(0.02, 0.59, 0.16);

function getDRMidnight() {
  const now = new Date();
  const dr = new Date(now.getTime() - 4 * 3600000);
  dr.setUTCHours(0, 0, 0, 0);
  return new Date(dr.getTime() + 4 * 3600000).toISOString();
}

function formatDRTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Santo_Domingo' });
}

function formatDRDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Santo_Domingo' });
}

const TURNO_LABELS = { manana: 'Mañana', tarde: 'Tarde', noche: 'Noche', personalizado: 'Personalizado' };

async function generateShiftPDF({ restaurant, encargado, turno, horaInicio, horaCierre, summary, prevShift, dayTotals }) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const contentW = W - MARGIN * 2;

  // Pre-calculate height needed
  let totalH = 0;
  totalH += 60;  // header
  totalH += 80;  // shift info
  totalH += 80;  // sales summary
  totalH += 60;  // financials
  totalH += 50;  // payment methods
  totalH += 50;  // order types
  totalH += 20 + summary.topProducts.length * 14; // top products
  totalH += 50;  // vs previous
  totalH += 50;  // daily totals
  totalH += 80;  // signature
  totalH += 40;  // footer
  totalH += 40;  // padding

  const page = doc.addPage([W, totalH]);
  let y = totalH - MARGIN;

  // Helper: draw centered text
  function centerText(text, font, size, color) {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (W - w) / 2, y, size, font, color: color || BLACK });
    y -= size + 3;
  }

  // Helper: draw left-right row
  function row(left, right, font, size, color) {
    const rw = font.widthOfTextAtSize(right, size);
    page.drawText(left, { x: MARGIN, y, size, font, color: color || BLACK });
    page.drawText(right, { x: W - MARGIN - rw, y, size, font, color: color || BLACK });
    y -= size + 3;
  }

  // Helper: dashed line
  function dashedLine() {
    const dash = '- '.repeat(Math.floor(contentW / regular.widthOfTextAtSize('- ', 7)));
    page.drawText(dash, { x: MARGIN, y, size: 7, font: regular, color: LGRAY });
    y -= 10;
  }

  // ── HEADER ──
  centerText('PINCER', bold, 14, BLACK);
  centerText('Reporte de Turno', regular, 9, GRAY);
  y -= 4;
  dashedLine();

  // ── SHIFT INFO ──
  row('Restaurante:', restaurant, regular, 8, GRAY);
  row('Encargado:', encargado, bold, 8);
  row('Turno:', TURNO_LABELS[turno] || turno, regular, 8);
  row('Inicio:', formatDRTime(horaInicio), regular, 8);
  row('Cierre:', formatDRTime(horaCierre), regular, 8);
  row('Fecha:', formatDRDate(horaInicio), regular, 8);
  y -= 2;
  dashedLine();

  // ── RESUMEN DE VENTAS ──
  centerText('RESUMEN DE VENTAS', bold, 9);
  y -= 2;
  row('Total ordenes:', String(summary.total_ordenes), regular, 8);
  row('Completadas:', String(summary.ordenes_completadas), regular, 8, GREEN);
  row('Canceladas:', String(summary.ordenes_canceladas), regular, 8, summary.ordenes_canceladas > 0 ? rgb(0.8, 0.1, 0.1) : GRAY);
  y -= 2;
  dashedLine();

  // ── FINANCIALS ──
  row('Venta bruta:', 'RD$' + summary.total_bruto.toLocaleString(), bold, 9);
  row('ITBIS (18%):', 'RD$' + summary.itbis.toLocaleString(), regular, 8, GRAY);
  if (summary.fee_pincer > 0) {
    row('Fee Pincer:', 'RD$' + summary.fee_pincer.toLocaleString(), regular, 8, GRAY);
  }
  row('Venta neta:', 'RD$' + summary.total_neto.toLocaleString(), bold, 9, GREEN);
  y -= 2;
  dashedLine();

  // ── MÉTODOS DE PAGO ──
  centerText('METODOS DE PAGO', bold, 9);
  y -= 2;
  row('Efectivo:', 'RD$' + summary.total_efectivo.toLocaleString(), regular, 8);
  row('Tarjeta:', 'RD$' + summary.total_tarjeta.toLocaleString(), regular, 8);
  y -= 2;
  dashedLine();

  // ── TIPO DE ORDEN ──
  centerText('TIPO DE ORDEN', bold, 9);
  y -= 2;
  row('Pickup / Dine-in:', String(summary.total_pickup), regular, 8);
  row('Delivery:', String(summary.total_delivery), regular, 8);
  y -= 2;
  dashedLine();

  // ── TOP 5 PRODUCTOS ──
  if (summary.topProducts.length > 0) {
    centerText('TOP 5 PRODUCTOS', bold, 9);
    y -= 2;
    summary.topProducts.forEach((p, i) => {
      row(`${i + 1}. ${p.name}`, String(p.qty), regular, 8);
    });
    y -= 2;
    dashedLine();
  }

  // ── VS TURNO ANTERIOR ──
  if (prevShift) {
    centerText('VS TURNO ANTERIOR', bold, 9);
    y -= 2;
    const ventasDiff = prevShift.total_bruto > 0
      ? Math.round(((summary.total_bruto - prevShift.total_bruto) / prevShift.total_bruto) * 100)
      : 0;
    const ordenesDiff = summary.total_ordenes - (prevShift.total_ordenes || 0);
    const ventasColor = ventasDiff >= 0 ? GREEN : rgb(0.8, 0.1, 0.1);
    const ordenesColor = ordenesDiff >= 0 ? GREEN : rgb(0.8, 0.1, 0.1);
    const ventasSign = ventasDiff >= 0 ? '+' : '';
    const ordenesSign = ordenesDiff >= 0 ? '+' : '';
    row('Ventas:', `${ventasSign}${ventasDiff}%`, regular, 8, ventasColor);
    row('Ordenes:', `${ordenesSign}${ordenesDiff}`, regular, 8, ordenesColor);
    y -= 2;
    dashedLine();
  }

  // ── ACUMULADO DEL DÍA ──
  centerText('ACUMULADO DEL DIA', bold, 9);
  y -= 2;
  row('Turnos hoy:', String(dayTotals.shifts), regular, 8);
  row('Total ventas:', 'RD$' + dayTotals.ventas.toLocaleString(), regular, 8);
  row('Total ordenes:', String(dayTotals.ordenes), regular, 8);
  y -= 2;
  dashedLine();

  // ── FIRMA ──
  y -= 10;
  const lineW = 140;
  const lineX = (W - lineW) / 2;
  page.drawLine({
    start: { x: lineX, y },
    end: { x: lineX + lineW, y },
    thickness: 0.5,
    color: BLACK,
  });
  y -= 12;
  centerText(encargado, regular, 8, GRAY);
  centerText('Firma del encargado', regular, 7, LGRAY);

  // ── FOOTER ──
  y -= 10;
  centerText('Generado por Pincer', regular, 7, LGRAY);
  centerText('pincerweb.com', regular, 7, LGRAY);

  // Trim page to actual content height
  const actualH = totalH - y + MARGIN;
  page.setSize(W, actualH);
  // Shift all content: pdf-lib uses bottom-left origin, we need to move everything down
  // Actually we need to re-generate with correct height. Use a simpler approach:
  // Set mediabox to crop from top
  page.setMediaBox(0, y - MARGIN, W, actualH);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString('base64');
}
