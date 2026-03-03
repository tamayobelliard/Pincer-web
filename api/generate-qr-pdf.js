import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';

// ── Image URLs (same as admin/index.html print template) ──
const IMAGES = {
  watermark: 'https://i.imgur.com/Dep2ZsJ.png',
  pincerLogo: 'https://i.imgur.com/t72wYFc.png',
  visa: 'https://i.imgur.com/gMRFXRj.png',
  mastercard: 'https://i.imgur.com/qgq4m7h.png',
  visaSecure: 'https://i.imgur.com/fgA6bpW.png',
  mcIdCheck: 'https://i.imgur.com/KLv1a0r.png',
};

const NAVY = rgb(0.102, 0.137, 0.196); // #1a2332
const WHITE = rgb(1, 1, 1);
const LIGHT_WHITE = rgb(0.75, 0.75, 0.75); // simulates rgba(255,255,255,0.7) on navy
const FAINT_WHITE = rgb(0.55, 0.55, 0.55); // simulates rgba(255,255,255,0.4) on navy

async function fetchImage(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}

async function embedImage(doc, buf) {
  if (!buf) return null;
  try {
    try { return await doc.embedPng(buf); } catch {}
    return await doc.embedJpg(buf);
  } catch { return null; }
}

/**
 * Generate a QR flyer PDF matching the admin print template.
 * @param {string} slug - Restaurant slug (for QR URL)
 * @param {string} restaurantName - Display name
 * @param {string|null} logoUrl - Restaurant logo URL (optional)
 * @returns {Promise<string>} Base64 encoded PDF
 */
export async function generateQRPdf(slug, restaurantName, logoUrl) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  // ── Fetch all images in parallel ──
  const [qrBuf, logoBuf, watermarkBuf, pincerLogoBuf, visaBuf, mcBuf, vsecureBuf, mcidBuf] =
    await Promise.all([
      QRCode.toBuffer(`https://pincerweb.com/${slug}`, {
        width: 400, margin: 2, color: { dark: '#1e293b', light: '#ffffff' },
        errorCorrectionLevel: 'H',
      }),
      logoUrl ? fetchImage(logoUrl) : Promise.resolve(null),
      fetchImage(IMAGES.watermark),
      fetchImage(IMAGES.pincerLogo),
      fetchImage(IMAGES.visa),
      fetchImage(IMAGES.mastercard),
      fetchImage(IMAGES.visaSecure),
      fetchImage(IMAGES.mcIdCheck),
    ]);

  const qrImg = await embedImage(doc, qrBuf);
  const logoImg = await embedImage(doc, logoBuf);
  const watermarkImg = await embedImage(doc, watermarkBuf);
  const pincerLogoImg = await embedImage(doc, pincerLogoBuf);
  const visaImg = await embedImage(doc, visaBuf);
  const mcImg = await embedImage(doc, mcBuf);
  const vsecureImg = await embedImage(doc, vsecureBuf);
  const mcidImg = await embedImage(doc, mcidBuf);

  // ══════════════════════════════════════════════════════
  // HEADER — navy background with logo circle + name
  // ══════════════════════════════════════════════════════
  const headerH = 200;
  const headerY = height - headerH;

  page.drawRectangle({
    x: 0, y: headerY, width, height: headerH, color: NAVY,
  });

  let headerContentY = height - 30;

  // White circle with logo
  if (logoImg) {
    const circleR = 50;
    const circleX = width / 2;
    const circleY = height - 30 - circleR;

    page.drawCircle({
      x: circleX, y: circleY, size: circleR,
      color: WHITE,
    });

    // Logo inside circle (slightly smaller for padding)
    const logoDim = circleR * 1.5;
    page.drawImage(logoImg, {
      x: circleX - logoDim / 2,
      y: circleY - logoDim / 2,
      width: logoDim,
      height: logoDim,
    });

    headerContentY = circleY - circleR - 15;
  }

  // Restaurant name
  const nameSize = 22;
  const nameW = fontBold.widthOfTextAtSize(restaurantName, nameSize);
  page.drawText(restaurantName, {
    x: (width - nameW) / 2,
    y: logoImg ? headerContentY : headerY + headerH / 2 - nameSize / 2,
    size: nameSize,
    font: fontBold,
    color: WHITE,
  });

  // ══════════════════════════════════════════════════════
  // MIDDLE — white area: QR + CTA text
  // ══════════════════════════════════════════════════════
  const footerH = 170;
  const middleTop = headerY;
  const middleBottom = footerH;
  const middleCenterY = middleBottom + (middleTop - middleBottom) / 2;

  // QR code
  if (qrImg) {
    const qrSize = 220;
    page.drawImage(qrImg, {
      x: (width - qrSize) / 2,
      y: middleCenterY - 10,
      width: qrSize,
      height: qrSize,
    });
  }

  // CTA: "ORDENA Y PAGA DESDE TU CELULAR"
  const cta1 = 'ORDENA Y PAGA DESDE TU CELULAR';
  const cta1Size = 18;
  const cta1W = fontBold.widthOfTextAtSize(cta1, cta1Size);
  page.drawText(cta1, {
    x: (width - cta1W) / 2,
    y: middleCenterY - 25,
    size: cta1Size,
    font: fontBold,
    color: NAVY,
  });

  // CTA: "SIN FILAS"
  const cta2 = 'SIN FILAS';
  const cta2Size = 24;
  const cta2W = fontBold.widthOfTextAtSize(cta2, cta2Size);
  page.drawText(cta2, {
    x: (width - cta2W) / 2,
    y: middleCenterY - 55,
    size: cta2Size,
    font: fontBold,
    color: NAVY,
  });

  // Watermark bottom-right of middle section
  if (watermarkImg) {
    const wmW = 100;
    const wmH = wmW * (watermarkImg.height / watermarkImg.width);
    page.drawImage(watermarkImg, {
      x: width - wmW - 20,
      y: middleBottom + 15,
      width: wmW,
      height: wmH,
    });
  }

  // ══════════════════════════════════════════════════════
  // FOOTER — navy background: Pincer branding
  // ══════════════════════════════════════════════════════
  page.drawRectangle({
    x: 0, y: 0, width, height: footerH, color: NAVY,
  });

  let footerY = footerH - 28;

  // Pincer logo + "Pincer" text
  if (pincerLogoImg) {
    const plH = 22;
    const plW = plH * (pincerLogoImg.width / pincerLogoImg.height);
    const pincerText = 'Pincer';
    const ptSize = 18;
    const ptW = fontBold.widthOfTextAtSize(pincerText, ptSize);
    const totalW = plW + 8 + ptW;
    const startX = (width - totalW) / 2;

    page.drawImage(pincerLogoImg, {
      x: startX, y: footerY - 3, width: plW, height: plH,
    });
    page.drawText(pincerText, {
      x: startX + plW + 8, y: footerY, size: ptSize, font: fontBold, color: WHITE,
    });
  } else {
    const ptSize = 18;
    const ptW = fontBold.widthOfTextAtSize('Pincer', ptSize);
    page.drawText('Pincer', {
      x: (width - ptW) / 2, y: footerY, size: ptSize, font: fontBold, color: WHITE,
    });
  }

  footerY -= 20;

  // Tagline
  const tagline = 'Pedidos por QR que elevan la experiencia de tu restaurante, food truck o food park.';
  const tagSize = 8;
  const tagW = fontRegular.widthOfTextAtSize(tagline, tagSize);
  page.drawText(tagline, {
    x: (width - tagW) / 2, y: footerY,
    size: tagSize, font: fontRegular, color: LIGHT_WHITE,
  });

  footerY -= 14;

  // Contact info
  const contact = 'info@pincerweb.com  \u00B7  +1(829) 548-1236  \u00B7  Santiago, Rep\u00FAblica Dominicana';
  const contactSize = 8;
  const contactW = fontRegular.widthOfTextAtSize(contact, contactSize);
  page.drawText(contact, {
    x: (width - contactW) / 2, y: footerY,
    size: contactSize, font: fontRegular, color: LIGHT_WHITE,
  });

  footerY -= 22;

  // Payment badges
  const badges = [visaImg, mcImg, vsecureImg, mcidImg].filter(Boolean);
  if (badges.length > 0) {
    const badgeH = 24;
    const badgeGap = 16;
    const badgeDims = badges.map(b => ({
      img: b,
      w: badgeH * (b.width / b.height),
      h: badgeH,
    }));
    const totalBadgeW = badgeDims.reduce((s, d) => s + d.w, 0) + badgeGap * (badges.length - 1);
    let bx = (width - totalBadgeW) / 2;
    for (const d of badgeDims) {
      page.drawImage(d.img, { x: bx, y: footerY - d.h / 2, width: d.w, height: d.h });
      bx += d.w + badgeGap;
    }
    footerY -= badgeH + 8;
  }

  // Copyright
  const copyright = '\u00A9 2026 Pincer. Hecho en Rep\u00FAblica Dominicana.';
  const copySize = 7;
  const copyW = fontRegular.widthOfTextAtSize(copyright, copySize);
  page.drawText(copyright, {
    x: (width - copyW) / 2, y: footerY,
    size: copySize, font: fontRegular, color: FAINT_WHITE,
  });

  // ── Save and return base64 ──
  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString('base64');
}
