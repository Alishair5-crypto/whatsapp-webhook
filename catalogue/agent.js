'use strict';

const { searchCatalogue } = require('./catalogue');

const PRODUCT_WORDS = ['lawn','linen','khaddar','karandi','marina','velvet','dhanak','kotail','embroidered','embroidery','printed','fabric','suit','suits','لان','لینن','کھدر','کرندی','مرینہ','مارینہ','ویلویٹ','ویلٹ','دھنک','کوٹیل','کڑھائی','پرنٹ','سوٹ','کپڑا','کپڑے'];
const BROWSE_WORDS = ['show','shown','show me','display','available','availability','catalogue','catalog','pics','pic','picture','pictures','photo','photos','image','images','dikhao','dikha','dikhain','dikhaye','dekhna','dekhao','dekhain','dekhaye','hai kya','hain kya','kuch hai','kuch dikh','available hai','دکھاؤ','دکھائیں','دکھا','دیکھنا','دیکھائیں','تصویر','تصاویر','فوٹو','پکس','دستیاب','موجود','کچھ ہے','کچھ دکھ'];
const COMPLETE_CATALOGUE_WORDS = ['complete catalogue','full catalogue','whole catalogue','all catalogue','complete catalog','full catalog','whole catalog','all catalog','poora catalogue','pura catalogue','sara catalogue','saara catalogue','poora catalog','pura catalog','sara catalog','saara catalog','پورا کیٹلاگ','مکمل کیٹلاگ','سارا کیٹلاگ','تمام کیٹلاگ','پورا کتالوگ','مکمل کتالوگ'];
const ORDER_WORDS = ['order','book','booking','buy','purchase','place order','order kar','order laga','آرڈر','منگوانا','خریدنا','بک','بکنگ'];
const FABRIC_ALIASES = [['lawn','Lawn'],['لان','Lawn'],['linen','Linen'],['لینن','Linen'],['khaddar','Khaddar'],['کھدر','Khaddar'],['karandi','Karandi'],['کرندی','Karandi'],['marina','Marina'],['marena','Marina'],['مارینہ','Marina'],['مرینہ','Marina'],['velvet','Velvet'],['ویلویٹ','Velvet'],['ویلٹ','Velvet'],['dhanak','Dhanak'],['دھنک','Dhanak'],['kotail','Kotail'],['kotai','Kotail'],['کوٹیل','Kotail']];
const COLLECTION_ALIASES = [['embroidered','Embroidered'],['embroidery','Embroidered'],['کڑھائی','Embroidered'],['printed','Printed'],['print','Printed'],['پرنٹڈ','Printed'],['پرنٹ','Printed']];
const COLOR_ALIASES = [['black','Black'],['کالا','Black'],['کالی','Black'],['white','White'],['سفید','White'],['red','Red'],['لال','Red'],['blue','Blue'],['نیلا','Blue'],['نیلی','Blue'],['green','Green'],['سبز','Green'],['pink','Pink'],['گلابی','Pink'],['maroon','Maroon'],['میرون','Maroon'],['beige','Beige'],['cream','Cream'],['کریمی','Cream']];

function normalizeText(text) { return String(text || '').normalize('NFC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g,' ').replace(/\s+/g,' ').trim(); }
function hasAny(text, words) { return words.some(w => text.includes(w)); }
function findAlias(text, aliases) { for (const [needle,value] of aliases) if (text.includes(needle)) return value; return ''; }
function isCompleteCatalogueRequest(text) { return hasAny(normalizeText(text), COMPLETE_CATALOGUE_WORDS); }
function isCatalogueIntent(text) {
  const t=normalizeText(text); if(!t) return false;
  const product=hasAny(t,PRODUCT_WORDS), browse=hasAny(t,BROWSE_WORDS), order=hasAny(t,ORDER_WORDS);
  if(browse && !order) return true;
  if(product && !order && /\?|\b(price|rate|kitna|kitni|hai|hain|chahiye|available|konsa|kaunsa|which|what)\b/.test(t)) return true;
  return false;
}
function wantsCatalogueImages(text) {
  const t=normalizeText(text); if(!t || hasAny(t,ORDER_WORDS)) return false;
  if (isCompleteCatalogueRequest(t)) return true;
  const product=hasAny(t,PRODUCT_WORDS);
  const imageWords=['pics','pic','picture','pictures','photo','photos','image','images','تصویر','تصاویر','فوٹو','پکس'];
  const visualVerbs=['show','shown','show me','display','dikhao','dikha','dikhain','dikhaye','dekhna','dekhao','dekhain','dekhaye','کچھ دکھ','دکھاؤ','دکھائیں','دکھا','دیکھنا','دیکھائیں'];
  return hasAny(t,imageWords) || (product && hasAny(t,visualVerbs));
}
function extractFilters(text) { const t=normalizeText(text); return {fabric:findAlias(t,FABRIC_ALIASES),color:findAlias(t,COLOR_ALIASES),collection:findAlias(t,COLLECTION_ALIASES),name:'',limit:isCompleteCatalogueRequest(t) ? 20 : 5}; }
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
  if(!rows.length) return `\n\n=== LIVE CATALOGUE RESULT ===\nNo active in-stock products matched the customer's request. Do NOT invent a product, price, stock status, or image. Politely ask for another fabric, color, or collection.\n`;
  const lines=rows.map((p,i)=>`${i+1}. ${p.name} | ${p.collection||'N/A'} | ${p.fabric||'N/A'} | ${p.color||'N/A'} | ${money(p)} | stock ${p.stock_quantity}${p.description?` | ${String(p.description).slice(0,180)}`:''}${primaryImage(p)?` | IMAGE_URL ${primaryImage(p)}`:''}`);
  return `\n\n=== LIVE CATALOGUE RESULT (DATABASE — AUTHORITATIVE) ===\nUse ONLY these live catalogue records for product facts. Never invent product names, prices, colors, stock, or images. If the customer asked to see products, naturally mention the matching items and that their photos are being shared.\nFilters: ${JSON.stringify(filters)}\n${lines.join('\n')}\n`;
}
async function getCatalogueForMessage(dbUrl,text) {
  if(!isCatalogueIntent(text)) return null;
  try { const filters=extractFilters(text); const products=await searchCatalogue(dbUrl,filters); return {filters,products,context:buildContext(products,filters),wantsImages:wantsCatalogueImages(text),completeCatalogue:isCompleteCatalogueRequest(text)}; }
  catch(error) { console.error('[CATALOGUE AGENT]',error.message); return {filters:extractFilters(text),products:[],context:'\n\n=== LIVE CATALOGUE RESULT ===\nCatalogue lookup is temporarily unavailable. Do NOT invent product facts. Continue with a brief honest response and ask the customer to try again.\n',wantsImages:false,completeCatalogue:false}; }
}
module.exports={normalizeText,isCatalogueIntent,wantsCatalogueImages,extractFilters,getCatalogueForMessage,primaryImage,allImages,normalizeImageUrl,isCompleteCatalogueRequest};