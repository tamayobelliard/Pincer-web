import fs from 'fs';
import path from 'path';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node scripts/test-parse-menu.js ./menu-photo.jpg');
  process.exit(1);
}

const resolved = path.resolve(imagePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const ext = path.extname(resolved).toLowerCase();
const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mime = mimeMap[ext] || 'image/jpeg';

const base64 = fs.readFileSync(resolved).toString('base64');
const dataUri = `data:${mime};base64,${base64}`;

const slug = process.argv[3] || 'mrsandwich';
const url = process.argv[4] || 'http://localhost:3000/api/parse-menu';

console.log(`Image: ${resolved} (${(Buffer.byteLength(base64, 'utf8') / 1024 / 1024).toFixed(1)} MB base64)`);
console.log(`Slug: ${slug}`);
console.log(`Endpoint: ${url}`);
console.log('Sending to Claude Vision... (this may take 10-30s)\n');

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri, restaurant_slug: slug }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`Error ${res.status}:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`✅ Extracted ${data.count} items:\n`);
  data.items.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.name} — RD$${item.price} [${item.category}]${item.description ? ` (${item.description})` : ''}`);
  });
  console.log(`\nTotal: ${data.count} items inserted into products table for "${slug}"`);
} catch (err) {
  console.error('Request failed:', err.message);
  process.exit(1);
}
