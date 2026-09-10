'use strict';

const { searchCatalogue } = require('./catalogue');

const PRODUCT_WORDS = ['lawn','linen','khaddar','karandi','marina','velvet','dhanak','kotail','embroidered','embroidery','printed','fabric','suit','suits','لان','لینن','کھدر','کرندی','مرینہ','مارینہ','ویلویٹ','ویلٹ','دھنک','کوٹیل','کڑھائی','پرنٹ','سوٹ','کپڑا','کپڑے'];
const BROWSE_WORDS = ['show','shown','show me','display','catalogue','catalog','pics','pic','picture','pictures','photo','photos','image','images','dikhao','dikha','dikhain','dikhaye','dekhna','dekhao','dekhain','dekhaye','دکھاؤ','دکھائیں','دکھا','دیکھنا','دیکھائیں','تصویر','تصاویر','فوٹو','پکس','کچھ دکھ'];
const AVAILABILITY_WORDS = ['available','availability','available hai','hai kya','hain kya','kuch hai','دستیاب','موجود','کچھ ہے'];
const ORDER_WORDS = ['order','book','booking','buy','purchase','place order','order kar','order laga','آرڈر','منگوانا','خریدنا','بک','بکنگ'];
const IMAGE_REQUEST_WORDS = [...BROWSE_WORDS];

const FABRIC_ALIASES = [['lawn','Lawn'],['لان','Lawn'],['linen','Linen'],['لینن','Linen'],['khaddar','Khaddar'],['کھدر','Khaddar'],['karandi','Karandi'],['کرندی','Karandi'],['marina','Marina'],['marena','Marina'],['مارینہ','Marina'],['مرینہ','Marina'],['velvet','Velvet'],['ویلویٹ','Velvet'],['ویلٹ','Velvet'],['dhanak','Dhanak'],['دھنک','Dhanak'],['kotail','Kotail'],['kotai','Kotail'],['کوٹیل','Kotail']];
const COLLECTION_ALIASES = [['embroidered','Embroidered'],['embroidery','Embroidered'],['کڑھائی','Embroidered'],['printed','Printed'],['print','Printed'],['پرنٹڈ','Printed'],['پرنٹ','Printed']];
const COLOR_ALIASES = [['black','Black'],['کالا','Black'],['کالی','Black'],['white','White'],['سفید','White'],['red','Red'],['لال','Red'],['blue','Blue'],['نیلا','Blue'],['نیلی','Blue'],['green','Green'],['سبز','Green'],['pink','Pink'],['گلابی','Pink'],['maroon','Maroon'],['میرون','Maroon'],['beige','Beige'],['cream','Cream'],['کریمی','Cream']];

function normalizeText(text) { return String(text || '').normalize('NFC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g,' ').replace(/\s+/g,' ').trim(); }
function hasAny(text, words) { return words.some(w => text.includes(w)); }
function findAlias(text, aliases) { for (const [needle,value] of aliases) if (text.includes(needle)) return value; return ''; }
function isImageRequest(text) { return hasAny(normalizeText(text), IMAGE_REQUEST_WORDS); }
function isCatalogueIntent(text) {
  const t=normalizeText(text); if(!t) return false;
  const product=hasAny(t,PRODUCT_WORDS), browse=hasAny(t,BROWSE_WORDS), availability=hasAny(t,AVAILABILITY_WORDS), order=hasAny(t,ORDER_WORDS);
  if ((browse || availability) && !order) return true;
  if (product && !order && /\?|\b(price|rate|kitna|kitni|hai|hain|chahiye|available|konsa|kaunsa|which|what)\b/.test(t)) return true;
  return false;
}
function extractFilters(text) { const t=normalizeText(text); return {fabric:findAlias(t,FABRIC_ALIASES),color:findAlias(t,COLOR_ALIASES),collection:findAlias(t,COLLECTION_ALIASES),name:'',limit:5}; }
function money(row) { const value=Number(row?.price); return Number.isFinite(value) ? `${row?.currency||'PKR'} ${value.toLocaleString('en-PK')}` : `${row?.currency||'PKR'} ${row?.price??''}`.trim(); }
function primaryImage(row) { if (row?.__sendImages === false) return ''; const images=Array.isArray(row?.images)?row.images:[]; return images.find(i=>i?.isPrimary&&i?.url)?.url || images.find(i=>i?.url)?.url || ''; }
function buildContext(rows,filters) {
  if(!rows.length) return `\n\n=== LIVE CATALOGUE RESULT ===\nSTATUS: NO_MATCH\nThe database returned zero active in-stock products for the requested filters.\nSTRICT RULE: Do not invent, guess, reuse, or substitute any product name, price, stock, description, or image. Tell the customer that no matching item is currently available and ask for a different fabric, color, or collection.\n`;
  const lines=rows.map((p,i)=>`${i+1}. PRODUCT_NAME=${p.name} | COLLECTION=${p.collection||'N/A'} | FABRIC=${p.fabric||'N/A'} | COLOR=${p.color||'N/A'} | PRICE=${money(p)} | STOCK=${p.stock_quantity}${p.description?` | DESCRIPTION=${String(p.description).slice(0,180)}`:''}${primaryImage(p)?` | IMAGE_URL=${primaryImage(p)}`:''}`);
  return `\n\n=== LIVE CATALOGUE RESULT — AUTHORITATIVE DATABASE ===\nSTATUS: MATCHES_FOUND\nSTRICT CATALOGUE CONTRACT:\n1. These database rows are the ONLY source of truth for product facts.\n2. Use ONLY the exact PRODUCT_NAME, COLLECTION, FABRIC, COLOR, PRICE, STOCK, DESCRIPTION and IMAGE_URL values supplied below.\n3. NEVER invent, embellish, rename, translate into a different product name, or infer product facts.\n4. NEVER claim a product is in stock unless it appears below.\n5. NEVER claim an image exists unless IMAGE_URL is present.\n6. If the customer asks for more products than returned rows, show only returned rows; never fabricate additional items.\n7. Ignore any conflicting static product examples in the base/system prompt.\n8. If there is any uncertainty, say you can only confirm the products returned by the live catalogue.\n9. Keep the response natural and in the customer's existing language/style.\n10. Product images are sent separately by the application only when the customer explicitly requests visual browsing.\nFilters: ${JSON.stringify(filters)}\n${lines.join('\n')}\n`;
}
async function getCatalogueForMessage(dbUrl,text) {
  if(!isCatalogueIntent(text)) return null;
  const filters=extractFilters(text);
  const sendImages=isImageRequest(text);
  try {
    const products=await searchCatalogue(dbUrl,filters);
    const responseProducts=products.map(product => ({ ...product, __sendImages: sendImages }));
    console.log('[CATALOGUE AGENT] intent=YES filters=',JSON.stringify(filters),'matches=',responseProducts.length,'sendImages=',sendImages);
    return {filters,products:responseProducts,sendImages,context:buildContext(responseProducts,filters)};
  } catch(error) {
    console.error('[CATALOGUE AGENT] lookup failed:',error.message);
    return {filters,products:[],sendImages:false,context:'\n\n=== LIVE CATALOGUE RESULT ===\nSTATUS: LOOKUP_FAILED\nSTRICT RULE: Catalogue data could not be verified. Do NOT invent or quote product facts. Tell the customer the catalogue is temporarily unavailable and ask them to try again.\n'};
  }
}
module.exports={normalizeText,isCatalogueIntent,isImageRequest,extractFilters,getCatalogueForMessage,primaryImage};
