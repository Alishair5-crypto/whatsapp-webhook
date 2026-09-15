'use strict';

const { searchCatalogue } = require('./catalogue');

// STRICT CATALOGUE/IMAGE RULES
// 1. This module controls ONLY catalogue lookup/image-request interpretation.
// 2. Existing Zara AI reasoning, memory, orders, payments, delivery, TTS, WhatsApp and DB logic are untouched.
// 3. Current customer message has priority over previous catalogue context.
// 4. Previous image context may resolve references such as "aur dikhao" but may NEVER override a new order/payment/address intent.
// 5. Image quantity is interpreted from the current request: explicit number > singular/plural wording > default multiple batch.
// 6. Singular image nouns mean one: tasveer, image, picture, pic, design.
// 7. Plural image nouns mean multiple: tasveeren/tasveerain, images, pictures, pics, designs.
// 8. "aur tasveer" means additional images; default additional batch is 5 unless an explicit count is given.
// 9. Never invent products, prices, stock or image URLs.
// 10. Keep verified HTTPS image URL validation unchanged.
const PRODUCT_WORDS = ['lawn','linen','khaddar','karandi','marina','marena','velvet','dhanak','kotail','embroidered','embroidery','printed','fabric','suit','suits','dress','dresses','design','designs','collection','3 piece','3-piece','three piece','لان','لینن','کھدر','کرندی','مرینہ','مارینہ','ویلویٹ','ویلٹ','دھنک','کوٹیل','کڑھائی','پرنٹ','سوٹ','کپڑا','کپڑے','ڈریس','ڈریسس','ڈیزائن','ڈیزائنز','کلیکشن','تھری پیس','تین پیس'];
const BROWSE_WORDS = ['show','shown','show me','display','available','availability','catalogue','catalog','pics','pic','picture','pictures','photo','photos','image','images','tasveer','tasveerain','tasveeren','tasaveer','tasaveers','taseer','dikhao','dikha','dikhain','dikhaye','dekhna','dekhao','dekhain','dekhaye','hai kya','hain kya','kuch hai','kuch dikh','available hai','دکھاؤ','دکھائیں','دکھا','دیکھنا','دیکھائیں','تصویر','تصاویر','فوٹو','پکس','دستیاب','موجود','کچھ ہے','کچھ دکھ'];
const VISUAL_WORDS = ['design','designs','dress','dresses','collection','3 piece','3-piece','three piece','tasveer','tasveerain','tasveeren','tasaveer','tasaveers','picture','pictures','photo','photos','image','images','pic','pics','ڈیزائن','ڈیزائنز','ڈریس','ڈریسس','کلیکشن','تھری پیس','تین پیس','نمونہ','نمونے','تصویر','تصاویر','فوٹو','پکس'];
const COMPLETE_CATALOGUE_WORDS = ['complete catalogue','full catalogue','whole catalogue','all catalogue','complete catalog','full catalog','whole catalog','all catalog','poora catalogue','pura catalogue','sara catalogue','saara catalogue','poora catalog','pura catalog','sara catalog','saara catalog','پورا کیٹلاگ','مکمل کیٹلاگ','سارا کیٹلاگ','تمام کیٹلاگ','پورا کتالوگ','مکمل کتالوگ'];
const ORDER_WORDS = ['order','orders','book','booking','buy','purchase','place order','order kar','order laga','order dena','order de','book kar','book karna','buy karna','purchase karna','lena hai','le loon','le lo','mangwana','mangwao','mangwa dein','confirm order','order confirm','checkout','payment','cod','cash on delivery','jazzcash','easypaisa','delivery address','address','آرڈر','منگوانا','خریدنا','خریدوں','بک','بکنگ','بک کرنا','کنفرم','ادائیگی','پتہ'];
const IMAGE_SINGULAR_WORDS = ['tasveer','taseer','image','picture','pic','photo','design','نمونہ','تصویر','فوٹو'];
const IMAGE_PLURAL_WORDS = ['tasveeren','tasveerain','tasaveer','tasaveers','images','pictures','pics','photos','designs','نمونے','تصاویر','پکس','ڈیزائنز'];
const FABRIC_ALIASES = [['lawn','Lawn'],['لان','Lawn'],['linen','Linen'],['لینن','Linen'],['khaddar','Khaddar'],['کھدر','Khaddar'],['karandi','Karandi'],['کرندی','Karandi'],['marina','Marina'],['marena','Marina'],['مارینہ','Marina'],['مرینہ','Marina'],['velvet','Velvet'],['ویلویٹ','Velvet'],['ویلٹ','Velvet'],['dhanak','Dhanak'],['دھنک','Dhanak'],['kotail','Kotail'],['kotai','Kotail'],['کوٹیل','Kotail']];
const COLLECTION_ALIASES = [['embroidered','Embroidered'],['embroidery','Embroidered'],['کڑھائی','Embroidered'],['printed','Printed'],['print','Printed'],['پرنٹڈ','Printed'],['پرنٹ','Printed']];
const COLOR_ALIASES = [['mustard','Mustard'],['مسٹرڈ','Mustard'],['مسترد','Mustard'],['black','Black'],['کالا','Black'],['کالی','Black'],['white','White'],['سفید','White'],['red','Red'],['لال','Red'],['blue','Blue'],['نیلا','Blue'],['نیلی','Blue'],['نیلے','Blue'],['green','Green'],['سبز','Green'],['pink','Pink'],['گلابی','Pink'],['maroon','Maroon'],['میرون','Maroon'],['beige','Beige'],['cream','Cream']];

function normalizeText(text) {
  return String(text || '').normalize('NFC').toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g,' ')
    .replace(/[.,!?؟،؛:;()[\]{}]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function hasAny(text, words) { return words.some(w => text.includes(w)); }
function findAlias(text, aliases) { for (const [needle,value] of aliases) if (text.includes(needle)) return value; return ''; }
function isCompleteCatalogueRequest(text) { return hasAny(normalizeText(text), COMPLETE_CATALOGUE_WORDS); }

function isOrderIntent(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (hasAny(t, ORDER_WORDS)) return true;
  return /(?:yeh|ye|is|us)\s+(?:wala|wali|wale)\s+(?:de|bhej|lena|le|chahiye)/.test(t)
    || /(?:this|that|the)\s+(?:one|design|dress)\s+(?:please\s+)?(?:send|give|book|ship)/.test(t)
    || /(?:send|bhej)\s+(?:this|that|yeh|ye|is|woh|wo)/.test(t)
    || /(?:naam|name).*(?:address|pata|city|shehar)/.test(t);
}

function isCatalogueIntent(text) {
  const t = normalizeText(text); if (!t) return false;
  const product = hasAny(t, PRODUCT_WORDS), browse = hasAny(t, BROWSE_WORDS);
  if (isOrderIntent(t)) return false;
  if (browse) return true;
  if (product && /\?|\b(price|rate|kitna|kitni|hai|hain|chahiye|available|konsa|kaunsa|which|what)\b/.test(t)) return true;
  return false;
}

function extractRequestedImageCount(text) {
  const t = normalizeText(text);
  if (!t) return 0;
  if (isCompleteCatalogueRequest(t)) return 50;

  // Explicit numeric request always wins, including "5 tasveer", "send 3 pics", "2 designs".
  const explicit = t.match(/\b(\d{1,2})\b/);
  if (explicit) {
    const count = Number(explicit[1]);
    if (count >= 1 && count <= 50 && (hasAny(t, IMAGE_SINGULAR_WORDS) || hasAny(t, IMAGE_PLURAL_WORDS) || hasAny(t, ['send','bhej','dikhao','dikh','show','aur','more']))) return count;
  }

  // "aur tasveer" is semantically an additional-image request, not a single-image request.
  if (/\b(?:aur|more|another|some more|kuch aur)\b/.test(t) && (hasAny(t, IMAGE_SINGULAR_WORDS) || hasAny(t, IMAGE_PLURAL_WORDS))) return 5;

  if (hasAny(t, IMAGE_PLURAL_WORDS)) return 5;
  if (hasAny(t, IMAGE_SINGULAR_WORDS)) return 1;

  return 0;
}

function wantsCatalogueImages(text) {
  const t = normalizeText(text); if (!t || isOrderIntent(t)) return false;
  return isCompleteCatalogueRequest(t) || extractRequestedImageCount(t) > 0 || (hasAny(t, PRODUCT_WORDS) && hasAny(t, ['show','shown','display','dikhao','dikha','dikhain','dikhaye','dekhna','dekhao','dekhain','dekhaye','دکھاؤ','دکھائیں','دکھا','دیکھنا','دیکھائیں']));
}

function extractFilters(text) { const t=normalizeText(text); return {fabric:findAlias(t,FABRIC_ALIASES),color:findAlias(t,COLOR_ALIASES),collection:findAlias(t,COLLECTION_ALIASES),name:'',limit:50}; }
function money(row) { const value=Number(row?.price); return Number.isFinite(value) ? `${row?.currency||'PKR'} ${value.toLocaleString('en-PK')}` : `${row?.currency||'PKR'} ${row?.price??''}`.trim(); }
function normalizeImageUrl(value) {
  if (typeof value !== 'string') return '';
  let raw = value.normalize('NFC').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('`') && raw.endsWith('`'))) raw = raw.slice(1, -1).trim();
  try { const url = new URL(raw); if (url.protocol !== 'https:') return ''; if (url.username || url.password || !url.hostname) return ''; return url.href; } catch (_) { return ''; }
}
function primaryImage(row) {
  const images=Array.isArray(row?.images)?row.images:[];
  const candidates=[...images.filter(i=>i?.isPrimary), ...images];
  for (const image of candidates) { const url=normalizeImageUrl(image?.url); if (url) return url; }
  return '';
}
function allImages(row) {
  const images=Array.isArray(row?.images)?row.images:[]; const urls=[]; const seen=new Set();
  for (const image of images) { const url=normalizeImageUrl(image?.url); if (url && !seen.has(url)) { seen.add(url); urls.push(url); } }
  return urls;
}
function buildContext(rows,filters) {
  if(!rows.length) return `\n\n=== LIVE CATALOGUE RESULT ===\nNo active catalogue products matched the customer's request. Do NOT invent a product, price, stock status, or image. Politely ask for another fabric, color, or collection.\n`;
  const hasImages = rows.some(product => allImages(product).length > 0);
  const imageInstruction = hasImages ? 'Verified product image URLs are available for the matching records. If the customer asked to see products, mention that the matching photos are being shared by the system. NEVER print, quote, rewrite, shorten, or invent an image URL in the customer-facing reply.' : 'NO VERIFIED PRODUCT IMAGE URL IS AVAILABLE for these records. Do NOT say that photos/images have been shared. Give product facts only and tell the customer photos are currently unavailable.';
  const lines=rows.map((p,i)=>`${i+1}. ${p.name} | ${p.collection||'N/A'} | ${p.fabric||'N/A'} | ${p.color||'N/A'} | ${money(p)} | ${p.inventory_verified ? `stock ${p.stock_quantity}` : 'stock NOT VERIFIED'}${p.description?` | ${String(p.description).slice(0,180)}`:''}`);
  return `\n\n=== LIVE CATALOGUE RESULT (DATABASE — AUTHORITATIVE) ===\nUse ONLY these live catalogue records for product facts. Never invent product names, prices, colors, stock, or images. ${imageInstruction}\nFilters: ${JSON.stringify(filters)}\n${lines.join('\n')}\n`;
}

function prepareImageLimitedProducts(products, requestedCount) {
  if (!Array.isArray(products) || !products.length || !requestedCount || requestedCount >= 50) return products;
  const out = []; let remaining = requestedCount;
  for (const product of products) {
    if (remaining <= 0) break;
    const urls = allImages(product);
    if (!urls.length) continue;
    const limited = { ...product, images: urls.slice(0, remaining).map((url, index) => ({ url, isPrimary: index === 0 })) };
    out.push(limited);
    remaining -= limited.images.length;
  }
  return out;
}

async function getCatalogueForMessage(dbUrl,text) {
  if(!isCatalogueIntent(text)) return null;
  try {
    const filters=extractFilters(text);
    const products=await searchCatalogue(dbUrl,filters);
    const wantsImages = wantsCatalogueImages(text);
    const requestedImageCount = wantsImages ? extractRequestedImageCount(text) : 0;
    const imageProducts = wantsImages ? prepareImageLimitedProducts(products, requestedImageCount) : products;
    return {filters,products:imageProducts,context:buildContext(products,filters),wantsImages,requestedImageCount,completeCatalogue:isCompleteCatalogueRequest(text)};
  } catch(error) {
    console.error('[CATALOGUE AGENT]',error.message);
    return {filters:extractFilters(text),products:[],context:'\n\n=== LIVE CATALOGUE RESULT ===\nCatalogue lookup is temporarily unavailable. Do NOT invent product facts. Continue with a brief honest response and ask the customer to try again.\n',wantsImages:false,requestedImageCount:0,completeCatalogue:false};
  }
}

module.exports={normalizeText,isCatalogueIntent,wantsCatalogueImages,isOrderIntent,extractRequestedImageCount,extractFilters,getCatalogueForMessage,primaryImage,allImages,normalizeImageUrl,isCompleteCatalogueRequest,buildContext};
