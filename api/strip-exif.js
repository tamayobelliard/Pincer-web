// Strip EXIF/GPS metadata from JPEG images without external dependencies.
// Works by removing APP1 (EXIF), APP2 (ICC if EXIF-bearing), and APP13 (IPTC) segments.
// PNG files pass through unchanged (no EXIF by spec).

export function stripExif(buffer) {
  // Only process JPEG (starts with FF D8)
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return buffer; // Not JPEG or too small — return as-is
  }

  const chunks = [];
  // Keep SOI marker
  chunks.push(buffer.subarray(0, 2));

  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xFF) break;

    const marker = buffer[offset + 1];

    // SOS (Start of Scan) — rest of file is image data, copy it all
    if (marker === 0xDA) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    // Markers without length (RST, SOI, EOI, TEM)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      chunks.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    // Read segment length
    if (offset + 3 >= buffer.length) break;
    const segLen = (buffer[offset + 2] << 8) | buffer[offset + 3];
    const totalLen = segLen + 2; // +2 for marker bytes

    // Strip APP1 (0xE1 = EXIF/XMP), APP2 (0xE2), APP13 (0xED = IPTC)
    if (marker === 0xE1 || marker === 0xE2 || marker === 0xED) {
      // Skip this segment (strip it)
      offset += totalLen;
      continue;
    }

    // Keep all other segments
    chunks.push(buffer.subarray(offset, offset + totalLen));
    offset += totalLen;
  }

  return Buffer.concat(chunks);
}
