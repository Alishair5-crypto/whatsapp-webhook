'use strict';

const { searchCatalogue } = require('./catalogue');

const PRODUCT_WORDS = [
  'lawn', 'linen', 'khaddar', 'karandi', 'marina', 'velvet', 'dhanak', 'kotail',
  'embroidered', 'embroidery', 'printed', 'fabric', 'suit', 'suits',
  'لان', 'لینن', 'کھدر', 'کرندی', 'مرینہ', 'مارینہ', 'ویلویٹ', 'ویلٹ', 'دھنک', 'کوٹیل',
  'کڑھائی', 'پرنٹ', 'سوٹ', 'کپڑا', 'کپڑے'
];

const BROWSE_WORDS = [
  'show', 'shown', 'show me', 'display', 'available', 'availability', 'catalogue', 'catalog',
  'pics', 'pic', 'picture', 'pictures', 'photo', 'photos', 'image', 'images',
  'dikhao', 'dikha', 'dikhain', 'dikhaye', 'dekhna', 'dekhao', 'dekhain', 'dekhaye',
  'hai kya', 'hain kya', 'kuch hai', 'kuch dikh', 'available hai',
  'دکھاؤ', 'دکھائیں', 'دکھا', 'دیکھنا', 'دیکھائیں', 'تصویر', 'تصاویر', 'فوٹو', 'پکس',
  'دستیاب', 'موجود', 'کچھ ہے', 'کچھ دکھ'
];

const ORDER_WORDS = [
  'order', 'book', 'booking', 'buy', 'purchase', 'place order', 'order kar', 'order laga',
  'آرڈر', 'منگوانا', 'خریدنا', 'بک', 'بکنگ'
];

const FABRIC_ALIASES = [
  ['lawn', 'Lawn'], ['لان', 'Lawn'],
  ['linen', 'Linen'], ['لینن', 'Linen'],
  ['khaddar', 'Khaddar'], ['کھدر', 'Khaddar'],
  ['karandi', 'Karandi'], ['کرندی', 'Karandi'],
  ['marina', 'Marina'], ['marena', 'Marina'], ['مارینہ', 'Marina'], ['مرینہ', 'Marina'],
  ['velvet', 'Velvet'], ['velvet', 'Velvet'], ['ویلویٹ', 'Velvet'], ['ویلٹ', 'Velvet'],
  ['dhanak', 'Dhanak'], ['دھنک', 'Dhanak'],
  ['kotail', 'Kotail'], ['kotai', 'Kotail'], ['کوٹیل', 'Kotail']
];

const COLLECTION_ALIASES = [
  ['embroidered', 'Embroidered'], ['embroidery', 'Embroidered'], ['کڑھائی', 'Embroidered'],
  ['printed', 'Printed'], ['print', 'Printed'], ['پرنٹڈ', 'Printed'], ['پرنٹ', 'Printed']
];

const COLOR_ALIASES = [
  ['black', 'Black'], ['کالا', 'Black'], ['کالی', 'Black'],
  ['white', 'White'], ['سفید', 'White'],
  ['red', 'Red'], ['لال', 'Red'],
  ['blue', 'Blue'], ['نیلا', 'Blue'], ['نیلی', 'Blue'],
  ['green', 'Green'], ['سبز', 'Green'],
  ['pink', 'Pink'], ['گلابی', 'Pink'],
  ['maroon', 'Maroon'], ['میرون', 'Maroon'],
  ['beige', 'Beige'], ['cream', 'Cream'], ['کریمی', 'Cream']
];

function normalizeText(text) {
  return String(text || '').normalize('NFC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(text, words) {
  return words.some(w => text.includes(w));
}

function findAlias(text, aliases) {
  for (const [needle, value] of aliases) if (text.includes(needle)) return value;
  return '';
}

function isCatalogueIntent(text) {
  const t = normalizeText(text);
  if (!t) return false;
  const hasProduct = hasAny(t, PRODUCT_WORDS);
  const browse = hasAny(t, BROWSE_WORDS);
  const order = hasAny(t, ORDER_WORDS);

  // Explicit browsing/show requests always qualify, but do not hijack a clear order message.
  if (browse && !order) return true;
  // Product discovery questions qualify when they are not clearly an order instruction.
  if (hasProduct && !order && /\?|\b(price|rate|kitna|kitni|hai|hain|chahiye|available|konsa|kaunsa|which|what)\b/.test(t)) return true;
  return false;
}

function extractFilters(text) {
  const t = normalizeText(text);
  return {
    fabric: findAlias(t, FABRIC_ALIASES),
    color: findAlias(t, COLOR_ALIASES),
    collection: findAlias(t, COLLECTION_ALIASES),
    name: '',
    limit: 5
  };
}

function money(row) {
  const value = Number(row?.price);
  if (!Number.isFinite(value)) return `${row?.currency || 'PKR'} ${row?.price ?? ''}`.trim();
  return `${row?.currency || 'PKR'} ${value.toLocaleString('en-PK')}`;
}

function primaryImage(row) {
  const images = Array.isArray(row?.images) ? row.images : [];
  return images.find(i => i?.isPrimary && i?.url)?.url || images.find(i => i?.url)?.url || '';
}

function buildContext(rows, filters) {
  if (!rows.length) {
    return `\n\n=== LIVE CATALOGUE RESULT ===\nNo active in-stock products matched the customer's request. Do NOT invent a product, price, stock status, or image. Politely ask for another fabric, color, or collection.\n`;
  }

  const lines = rows.map((p, i) => {
    const image = primaryImage(p);
    return `${i + 1}. ${p.name} | ${p.collection || 'N/A'} | ${p.fabric || 'N/A'} | ${p.color || 'N/A'} | ${money(p)} | stock ${p.stock_quantity}${p.description ? ` | ${String(p.description).slice(0, 180)}` : ''}${image ? ` | IMAGE_URL ${image}` : ''}`;
  });

  return `\n\n=== LIVE CATALOGUE RESULT (DATABASE — AUTHORITATIVE) ===\nUse ONLY these live catalogue records for product facts. Never invent product names, prices, colors, stock, or images. If the customer asked to see products, naturally mention the matching items and that their photos are being shared.\nFilters: ${JSON.stringify(filters)}\n${lines.join('\n')}\n`;
}

async function getCatalogueForMessage(dbUrl, text) {
  if (!isCatalogueIntent(text)) return null;
  try {
    const filters = extractFilters(text);
    const products = await searchCatalogue(dbUrl, filters);
    return { filters, products, context: buildContext(products, filters) };
  } catch (error) {
    console.error('[CATALOGUE AGENT]', error.message);
    return { filters: extractFilters(text), products: [], context: '\n\n=== LIVE CATALOGUE RESULT ===\nCatalogue lookup is temporarily unavailable. Do NOT invent product facts. Continue with a brief honest response and ask the customer to try again.\n' };
  }
}

module.exports = {
  normalizeText,
  isCatalogueIntent,
  extractFilters,
  getCatalogueForMessage,
  primaryImage
};
