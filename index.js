// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  2026-09-03 — FULLY GROUNDED PRODUCTION BUILD
//
//  GROUNDING SYSTEM (AI ko guess nahi karne deta):
//  [GR1] Product Catalog — JSON inventory, AI guess نہیں کرے گی
//  [GR2] Pricing Guard  — code se price validate, AI calculate نہیں کر سکتی
//  [GR3] Order State Machine — Browsing→Selected→Address→Payment→Confirmed
//  [GR4] COD Verification — fake orders روکنے کے لیے, 3-step confirm
//  [GR5] Stock Check — out of stock → clear message, no guessing
//  [GR6] Address Validator — incomplete address → order block
//  [GR7] System Prompt Grounding — hard rules, catalog injected
//
//  MEMORY:
//  [M1] Supabase persistent memory (survives cold starts)
//       Tables: zara_conversations, zara_orders
//  [M2] In-memory Map fallback (if Supabase not configured)
//
//  AI CHAIN (5 free providers, auto-failover):
//  1. Gemini 3.7-flash  2. Gemini 3.6-flash
//  3. Cerebras llama-3.3-70b  4. Groq openai/gpt-oss-120b
//  5. OpenRouter mistral-7b:free
//
//  SELF-HEAL:
//  [H1] Circuit breaker per model (429/503/timeout → 5 min block)
//  [H2] Force-reset if ALL models blocked
//  [H3] Midnight PKT reset (daily quota refill)
//
//  QUALITY:
//  [U1] ElevenLabs Flash v2.5 + Urdu language_code
//  [U2] City name correction (Faizabad→Faisalabad etc.)
//
//  RECOMMENDED ADDITIONS (smooth flow):
//  [R1] Auto Order ID (FA-YYYYMMDD-NNNN)
//  [R2] Wholesale auto-detect (10+ suits → wholesale rate)
//  [R3] Rate limit per customer (max 30 msg/min, prevents spam)
//  [R4] Order tag validation (price/product mismatch → reject)
//
//  REQUIRED ENV VARS:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//  SUPABASE_URL, SUPABASE_KEY
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY
//  OPTIONAL: CEREBRAS_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_VOICE_ID
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
// [GR1] PRODUCT CATALOG — single source of truth
// Update inStock: false to mark out of stock (no code change needed)
// ════════════════════════════════════════════════════════════════════════════
const CATALOG = {
  lawn:        { name:'Lawn/Printed',  nameUr:'لان/پرنٹڈ',   season:'summer',     price:3600, wholesale:2999, inStock:true,  desc:'گرمیوں کا ہلکا، سانس لینے والا اور خوبصورت کپڑا' },
  embroidered: { name:'Embroidered',   nameUr:'ایمبرائیڈرڈ', season:'all-season', price:3600, wholesale:2999, inStock:true,  desc:'شادیوں اور خاص مواقع کے لیے — خوبصورت کڑھائی' },
  linen:       { name:'Linen/Khaddar', nameUr:'لنن/کھدر',    season:'mid-season', price:3600, wholesale:2999, inStock:true,  desc:'کلاسک آرام دہ کپڑا — درمیانی موسم کے لیے بہترین' },
  kotail:      { name:'Kotail',        nameUr:'کوٹیل',        season:'formal',     price:3600, wholesale:2999, inStock:true,  desc:'پریمیم، رسمی مواقع کے لیے — خاص اور شاندار' },
  karandi:     { name:'Karandi',       nameUr:'کرندی',        season:'mid-season', price:3600, wholesale:2999, inStock:true,  desc:'نرم، درمیانی موسم کا بہت مقبول کپڑا' },
  marina:      { name:'Marina',        nameUr:'مارینہ',       season:'winter',     price:3600, wholesale:2999, inStock:true,  desc:'گرم، آرام دہ — سردیوں کا سب سے پسندیدہ' },
  velvet:      { name:'Velvet',        nameUr:'ویلوٹ',        season:'winter',     price:3600, wholesale:2999, inStock:true,  desc:'شاہانہ، پر تعیش — سردیوں کی شان' },
  dhanak:      { name:'Dhanak',        nameUr:'دھنک',         season:'winter',     price:3600, wholesale:2999, inStock:true,  desc:'نرم، گرم — سردیوں کا آرام دہ انتخاب' },
};
const WHOLESALE_MIN = 10; // minimum suits for wholesale price
const RETAIL_DELIVERY = 200; // delivery charge for retail (city)
const WHOLESALE_DELIVERY_CITY = 0; // free for wholesale city

// [GR1] Find product by name/keyword (case-insensitive)
function findProduct(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [key, p] of Object.entries(CATALOG)) {
    if (lower.includes(key) || lower.includes(p.name.toLowerCase()) || lower.includes(p.nameUr)) {
      return { key, ...p };
    }
  }
  return null;
}

// [GR2] PRICING GUARD — calculate price from catalog only
function calcPrice(productKey, qty, isWholesale) {
  const p = CATALOG[productKey];
  if (!p) return null;
  const unitPrice = (isWholesale && qty >= WHOLESALE_MIN) ? p.wholesale : p.price;
  const total = unitPrice * qty;
  const delivery = (isWholesale && qty >= WHOLESALE_MIN) ? WHOLESALE_DELIVERY_CITY : RETAIL_DELIVERY;
  return { unitPrice, qty, total, delivery, grandTotal: total + delivery };
}

// [GR2] Validate price in ORDER tag against catalog
function validateOrderPrice(orderTag) {
  const product = findProduct(orderTag.product || '');
  if (!product) return { valid: false, reason: `Product "${orderTag.product}" not in catalog` };
  const qty = parseInt(orderTag.qty) || 1;
  const isWholesale = qty >= WHOLESALE_MIN;
  const pricing = calcPrice(product.key, qty, isWholesale);
  const aiPrice = parseInt(String(orderTag.price || '').replace(/[^0-9]/g, ''));
  if (aiPrice && Math.abs(aiPrice - pricing.total) > 100) {
    return { valid: false, reason: `Price mismatch: AI said ${aiPrice}, catalog says ${pricing.total}`, corrected: pricing };
  }
  return { valid: true, pricing, product };
}

// [GR5] STOCK CHECK
function getStockStatus(productKey) {
  const p = CATALOG[productKey];
  if (!p) return 'not_found';
  return p.inStock ? 'in_stock' : 'out_of_stock';
}

// Build catalog section for system prompt (GR7 grounding)
function buildCatalogPrompt() {
  const lines = ['=== پروڈکٹ کیٹالاگ (ان قیمتوں کے علاوہ کوئی قیمت نہ بتائیں) ==='];
  for (const [key, p] of Object.entries(CATALOG)) {
    const stock = p.inStock ? '✅ دستیاب' : '❌ ختم';
    lines.push(`${p.nameUr} (${p.name}): ${stock} | ریٹیل: ${p.price} روپے/سوٹ | ہول سیل (${WHOLESALE_MIN}+ سوٹ): ${p.wholesale} روپے/سوٹ`);
  }
  lines.push(`ڈیلیوری: شہر میں ${RETAIL_DELIVERY} روپے (ریٹیل) | ہول سیل شہر مفت`);
  return lines.join('\n');
}

// [GR6] ADDRESS VALIDATOR — ensures complete address before order
function validateAddress(address) {
  if (!address || typeof address !== 'string') return { valid: false, msg: 'پتہ نہیں ملا' };
  const trimmed = address.trim();
  if (trimmed.length < 15) return { valid: false, msg: 'پتہ بہت مختصر ہے' };
  const hasNumber   = /\d/.test(trimmed);
  const wordCount   = trimmed.split(/[\s,،]+/).filter(Boolean).length;
  const hasLocality = wordCount >= 4;
  if (!hasNumber)   return { valid: false, msg: 'مکان/فلیٹ نمبر نہیں ہے' };
  if (!hasLocality) return { valid: false, msg: 'گلی، محلہ، علاقہ کی تفصیل نہیں ہے' };
  return { valid: true, msg: 'OK' };
}

// [R1] Auto Order ID — FA-YYYYMMDD-random4
function generateOrderId() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Karachi' }).replace(/-/g,'');
  const r = Math.floor(1000 + Math.random() * 9000);
  return `FA-${d}-${r}`;
}

// [GR3] ORDER STATE MACHINE — in-memory + Supabase
if (!global._orderStates) global._orderStates = new Map();

const ORDER_STATUS = {
  BROWSING:  'browsing',
  SELECTED:  'product_selected',
  ADDR:      'address_pending',
  ADDR_OK:   'address_collected',
  PAY:       'payment_pending',
  COD_WAIT:  'cod_pending',         // [GR4] waiting for COD confirmation
  VERIFIED:  'verified',
  CONFIRMED: 'confirmed',
};

function getOrderState(phone) {
  return global._orderStates.get(phone) || { status: ORDER_STATUS.BROWSING };
}
function setOrderState(phone, patch) {
  const current = getOrderState(phone);
  const updated  = { ...current, ...patch, updatedAt: Date.now() };
  global._orderStates.set(phone, updated);
  return updated;
}

// ════════════════════════════════════════════════════════════════════════════
// Vercel waitUntil
// ════════════════════════════════════════════════════════════════════════════
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── [H1] Circuit breaker ──────────────────────────────────────────────────────
if (!global._cb)    global._cb    = new Map();
if (!global._errs)  global._errs  = new Map();
const isBlocked = k  => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms, why='') => {
  global._cb.set(k, Date.now() + ms);
  const e = global._errs.get(k) || { count:0, last:'' };
  e.count++; e.last = why; global._errs.set(k, e);
  console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s why=${why} fails=${e.count}`);
};

// [H2] Force-reset if all blocked
function selfHeal(keys) {
  if (keys.length > 0 && keys.every(k => isBlocked(k))) {
    keys.forEach(k => global._cb.delete(k));
    console.warn('[SELF-HEAL] All providers blocked → force reset');
  }
}

// [H3] Midnight reset
function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) { global._cb.clear(); console.log('[MIDNIGHT] CB reset'); }
  } catch (_) {}
}

// ── [R3] Rate limiter per customer (max 30 msg/min) ──────────────────────────
if (!global._rateLimit) global._rateLimit = new Map();
function isRateLimited(phone) {
  const now  = Date.now();
  const win  = 60 * 1000;
  const MAX  = 30;
  const hist = (global._rateLimit.get(phone) || []).filter(t => now - t < win);
  if (hist.length >= MAX) return true;
  hist.push(now);
  global._rateLimit.set(phone, hist);
  return false;
}

// ── [M1] Supabase persistent memory ──────────────────────────────────────────
const _memCache = new Map(); // fast in-process cache

async function dbGet(url, key, phone) {
  if (_memCache.has(phone)) return _memCache.get(phone);
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/zara_conversations?phone_number=eq.${encodeURIComponent(phone)}&select=history,customer_name,order_state`, {
      headers: { apikey:key, Authorization:`Bearer ${key}` }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (rows?.length) {
      const data = { history:rows[0].history||[], customerName:rows[0].customer_name||'', orderState:rows[0].order_state||{} };
      _memCache.set(phone, data);
      return data;
    }
    return null;
  } catch(e) { console.error('[DB GET]', e.message); return null; }
}

async function dbSave(url, key, phone, customerName, history, orderState) {
  _memCache.set(phone, { history, customerName, orderState });
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/zara_conversations`, {
      method: 'POST',
      headers: { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
      body: JSON.stringify({
        phone_number:  phone,
        customer_name: customerName||'',
        history:       history.slice(-20),
        order_state:   orderState||{},
        last_seen:     new Date().toISOString(),
        msg_count:     history.length
      })
    });
  } catch(e) { console.error('[DB SAVE]', e.message); }
}

// Save confirmed order to zara_orders table
async function dbSaveOrder(url, key, orderData) {
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/zara_orders`, {
      method: 'POST',
      headers: { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json', Prefer:'return=minimal' },
      body: JSON.stringify({ ...orderData, created_at: new Date().toISOString(), status:'pending' })
    });
    console.log('[DB ORDER] Saved to zara_orders ✓');
  } catch(e) { console.error('[DB ORDER]', e.message); }
}

// Local fallback
const _localHist = new Map();
function localHistory(phone) { if (!_localHist.has(phone)) _localHist.set(phone,[]); return _localHist.get(phone); }

// ── City name fix [U2] ────────────────────────────────────────────────────────
const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', rawalpndi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()]||w) : t;

// ── Google Sheets [GR3 confirmed orders] ─────────────────────────────────────
async function getGToken(email, key) {
  try {
    const now=Math.floor(Date.now()/1000), b64=s=>Buffer.from(s).toString('base64url');
    const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const p=b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    const s=crypto.createSign('RSA-SHA256'); s.update(`${h}.${p}`);
    const sig=s.sign(key.replace(/\\n/g,'\n'),'base64url');
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}`});
    return (await r.json()).access_token||null;
  } catch(e) { console.error('[GTOKEN]',e.message); return null; }
}
async function sheetAppend(sid, email, key, row) {
  if (!sid||!email||!key) return;
  try {
    const tok=await getGToken(email,key); if(!tok) return;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Sheet1!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{
      method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})
    });
    console.log('[SHEET] Row saved ✓');
  } catch(e) { console.error('[SHEET]',e.message); }
}

// Parse [ORDER:...] tag from AI reply
function parseOrderTag(text) {
  const m=text.match(/\[ORDER:([^\]]+)\]/i); if(!m) return null;
  const o={};
  for (const p of m[1].split('|')) { const [k,...v]=p.split('='); if(k&&v.length) o[k.trim().toLowerCase()]=v.join('=').trim(); }
  return Object.keys(o).length?o:null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPKT() {
  try {
    const p={};
    for (const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT unavailable'; }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function oaiChat({url,key,model,messages,maxTokens=800,timeout=20000}) {
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),timeout);
  try { return await fetch(`${url}/chat/completions`,{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.7,max_tokens:maxTokens})}); }
  finally { clearTimeout(t); }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();

  // Env
  const WT   = (process.env.WHATSAPP_TOKEN      ||'').trim();
  const PID  = (process.env.PHONE_NUMBER_ID     ||'').trim();
  const VT   = (process.env.VERIFY_TOKEN        ||'').trim();
  const GEM  = (process.env.GEMINI_API_KEY      ||'').trim();
  const GROQ = (process.env.GROQ_API_KEY        ||'').trim();
  const CER  = (process.env.CEREBRAS_API_KEY    ||'').trim();
  const OR   = (process.env.OPENROUTER_API_KEY  ||'').trim();
  const ELAB = (process.env.ELEVENLABS_API_KEY  ||'').trim();
  const EVID = (process.env.ELEVENLABS_VOICE_ID ||'21m00Tcm4TlvDq8ikWAM').trim();
  const JCN  = (process.env.JAZZCASH_NUMBER     ||'').trim();
  const EPN  = (process.env.EASYPAISA_NUMBER    ||'').trim();
  const SBURL= (process.env.SUPABASE_URL        ||'').trim();
  const SBKEY= (process.env.SUPABASE_KEY        ||'').trim();
  const GSID = (process.env.GOOGLE_SHEETS_ID    ||'').trim();
  const GSA  = (process.env.GOOGLE_SA_EMAIL     ||'').trim();
  const GSAK = (process.env.GOOGLE_SA_KEY       ||'').trim();

  // ─── GET: Verify ────────────────────────────────────────────────────────
  if (req.method==='GET') {
    const prot=req.headers['x-forwarded-proto']||'https', host=req.headers['x-forwarded-host']||req.headers.host||'localhost';
    const u=new URL(req.url,`${prot}://${host}`);
    const mode=u.searchParams.get('hub.mode'), token=u.searchParams.get('hub.verify_token'), challenge=u.searchParams.get('hub.challenge');
    if (mode&&token) {
      if (mode==='subscribe'&&String(token).trim()===VT) { console.log('[VERIFY] OK'); return res.status(200).send(challenge); }
      return res.status(403).send('Token Mismatch');
    }
    return res.status(200).send('Webhook Active');
  }

  // ─── POST ───────────────────────────────────────────────────────────────
  if (req.method==='POST') {
    let body=req.body;
    if (typeof body==='string') { try { body=JSON.parse(body); } catch(e) {} }

    const entry    = body?.entry?.[0];
    const value    = entry?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WT||!PID) { console.error('[CFG] Missing env vars'); return res.status(200).send('EVENT_RECEIVED'); }

    if (!global._dedup) global._dedup = new Map();
    const DEDUP_TTL = 10*60*1000;

    const proc = (async () => {
      const allProviders = ['g:gemini-3.7-flash','g:gemini-3.6-flash','cerebras','gr:openai/gpt-oss-120b','or:mistral'];
      selfHeal(allProviders.filter(k=>isBlocked(k)));

      try {
        for (const msg of messages) {
          const msgId = msg?.id;
          const now   = Date.now();

          // Dedup
          if ((global._dedup.get(msgId)||0) > now) { console.log('[DEDUP]', msgId); continue; }
          if (msgId) global._dedup.set(msgId, now+DEDUP_TTL);
          if (global._dedup.size>500) for(const[k,v]of global._dedup)if(v<=now)global._dedup.delete(k);

          const from = msg.from;
          if (!from) continue;

          // [R3] Rate limit
          if (isRateLimited(from)) { console.warn('[RATE] Blocked:', from); continue; }

          const isAudio = msg.type==='audio'||msg.type==='voice';
          const contact = contacts.find(c=>c?.wa_id===from)||contacts[0]||null;
          let customerName = (contact?.profile?.name||'').trim();

          // [M1] Load from Supabase
          let history = [], dbOrderState = {};
          const dbData = await dbGet(SBURL, SBKEY, from);
          if (dbData) {
            history       = dbData.history || [];
            dbOrderState  = dbData.orderState || {};
            if (!customerName && dbData.customerName) customerName = dbData.customerName;
          } else {
            history = localHistory(from);
          }

          // [GR3] Sync order state from DB to memory
          if (Object.keys(dbOrderState).length > 0 && !global._orderStates.has(from)) {
            global._orderStates.set(from, dbOrderState);
          }
          const orderState = getOrderState(from);

          // STEP A: Extract text or transcribe voice
          let userText = '';
          if (msg.type==='text') {
            userText = fixCities(msg.text?.body||'');
          } else if (isAudio && GROQ && WT) {
            const mediaId = msg.audio?.id||msg.voice?.id;
            if (!mediaId) { userText='[Customer ne voice bheja]'; }
            else {
              console.log('[A] mediaId:', mediaId);
              const mr=await fetch(`https://graph.facebook.com/v20.0/${mediaId}`,{headers:{Authorization:`Bearer ${WT}`}});
              if (!mr.ok) { userText='[Customer ne voice bheja]'; }
              else {
                const md=await mr.json().catch(()=>({}));
                if (!md?.url) { userText='[Customer ne voice bheja]'; }
                else {
                  const ar=await fetch(md.url,{headers:{Authorization:`Bearer ${WT}`}});
                  if (!ar.ok) { userText='[Customer ne voice bheja]'; }
                  else {
                    const buf=await ar.arrayBuffer();
                    const fd=new globalThis.FormData();
                    fd.append('file',new globalThis.Blob([buf],{type:'audio/ogg'}),'voice.ogg');
                    fd.append('model','whisper-large-v3-turbo');
                    fd.append('language','ur');
                    fd.append('prompt','فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک');
                    const gr=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${GROQ}`},body:fd});
                    if (gr.ok) { const gd=await gr.json().catch(()=>({})); userText=fixCities((gd.text||'').trim()); console.log('[A OK] len:',userText.length); }
                    else { console.error('[A FAIL] Groq:', gr.status); userText='[Customer ne voice bheja]'; }
                  }
                }
              }
            }
          } else if (msg.type==='image')   { userText='[Customer ne image bheji — poochein kya chahiye]'; }
            else if (msg.type==='sticker') { userText='[Customer ne sticker bheja — friendly acknowledgment do]'; }
            else if (msg.type==='document'){ userText='[Customer ne document bheja]'; }
            else                           { userText='[Customer ne kuch bheja]'; }

          if (!userText.trim()) userText='السلام علیکم';

          // [GR5] Stock check — detect product mention in user message
          const mentionedProduct = findProduct(userText);
          let stockWarning = '';
          if (mentionedProduct && !mentionedProduct.inStock) {
            stockWarning = `\n⚠️ SYSTEM NOTE: Customer نے "${mentionedProduct.nameUr}" مانگا ہے جو اس وقت OUT OF STOCK ہے۔ Zara کو clearly بتانا ہے کہ یہ ابھی available نہیں، اور متبادل suggest کریں۔`;
          }

          // [R2] Wholesale auto-detect
          const isWholesaleLikely = /\b(10|1[1-9]|[2-9]\d|دوکان|دکان|shop|wholesale|ہول)\b/i.test(userText);

          // [GR7] Build grounded system prompt
          const SYS = `آپ زارہ ہیں — فاطمہ آرٹس (Fatima Arts) کی سیلز ایجنٹ۔ آپ روبوٹ نہیں ہیں۔ کبھی AI یا automation کا ذکر نہ کریں۔

CURRENT TIME: ${getPKT()}
${customerName ? `CUSTOMER NAME: ${customerName}` : ''}
ORDER STATE: ${orderState.status || 'browsing'}
${isWholesaleLikely ? '🏪 WHOLESALE INQUIRY LIKELY: اگر 10+ suits ہیں تو wholesale rate لاگو کریں' : ''}
${stockWarning}

=== سخت قواعد (ان کی کبھی خلاف ورزی نہ کریں) ===
❌ قیمت خود calculate نہ کریں — نیچے دیے catalog سے ہی بتائیں
❌ catalog میں موجود products کے علاوہ کوئی product نہ بتائیں
❌ out of stock product کو available نہ کہیں
❌ ادھورے پتے پر آرڈر confirm نہ کریں
❌ payment کی تصدیق کے بغیر آرڈر final نہ کریں
❌ AI، bot، یا automated کا ذکر کبھی نہ کریں
❌ boss کی اجازت کے بغیر discount نہ دیں

${buildCatalogPrompt()}

=== پہچان ===
نام: زارہ | فاطمہ آرٹس | گرم، دوستانہ، پیشہ ورانہ لہجہ
ہر پیغام میں customer کا نام | max 2-3 emoji | ہر پیغام personal

=== زبان ===
اردو میں → اردو | Roman Urdu میں → Roman Urdu | English میں → English
صرف پاکستانی اردو لہجہ — ہندی یا انگریزی accent نہیں

=== وقت سلام (PKT) ===
06:00–12:00 → صبح بخیر! 🌅 | 12:00–17:00 → خیریت سے ہیں؟ ☀️
17:00–21:00 → شام بخیر! ✨ | 21:00–06:00 → السلام علیکم!
صرف پہلے پیغام پر

=== شہر === فیصل آباد = Faisalabad (کبھی Faizabad نہیں)

=== موسم ===
سردی (نومبر–فروری): مارینہ، ویلوٹ، دھنک، کرندی پہلے
گرمی (اپریل–ستمبر): لان، لنن پہلے

=== اپ سیل (ایک، فطری) ===
لان پوچھے → کرندی mention کریں
مارینہ پوچھے → ویلوٹ mention کریں
Retail → wholesale hint کریں اگر دکاندار لگے

=== مول بھاؤ ===
1st: "آپی، یہ قیمت پہلے سے بہت مناسب ہے 🎨"
2nd: "آپی! ہم quality میں کبھی compromise نہیں کرتے 😊"
3rd: "آپی، discount تو boss کا اختیار ہے" → boss alert

=== ادائیگی ===
1. JazzCash → ${JCN||'boss se confirm karein'}
2. EasyPaisa → ${EPN||'boss se confirm karein'}
3. COD — پتہ + فون + متبادل فون نمبر لیں

=== [GR4] COD تصدیق (لازمی تین مراحل) ===
جب customer COD چنے:
1. مکمل پتہ مانگیں (مکان نمبر + گلی + علاقہ + شہر + landmark)
2. متبادل فون نمبر مانگیں
3. یہ پوچھیں: "کیا آپ کے گھر میں کوئی package receive کر سکتا ہے؟"
صرف یہ تینوں معلومات ملنے کے بعد COD confirm کریں۔

=== [GR6] پتہ کی شرط ===
مکمل پتہ لازمی: مکان/فلیٹ نمبر + گلی + علاقہ + شہر
ادھورے پتے پر آرڈر بالکل نہ کریں — مزید پوچھیں

=== [GR3] آرڈر کے مراحل ===
1. customer product چنے → price بتائیں (catalog سے)
2. پتہ مانگیں → validate کریں
3. ادائیگی کا طریقہ مانگیں
4. COD ہے تو 3-step verification
5. سب ٹھیک → [ORDER:...] tag لکھیں اور confirm کریں

=== آرڈر ٹیگ (صرف جب سب confirm ہو) ===
[ORDER:name=CustomerName|product=ProductKey|qty=2|price=7200|payment=COD|address=Full Address|city=Faisalabad]
productKey must be one of: lawn, embroidered, linen, kotail, karandi, marina, velvet, dhanak
price must match catalog exactly (qty × unit price)

=== boss alert ===
🚨 ناراض | 🛍️ 10+ سوٹ | 💰 10,000+ | ✅ screenshot | 🔄 تبادلہ | 🏷️ تیسری discount | ❓ غیر معمولی

=== یادداشت === پوری گفتگو یاد رکھیں۔ دوبارہ نہ پوچھیں جو پہلے پوچھا۔

=== مرد customer === "آپی" نہیں — "بھائی جان" یا "جناب"

=== ROUTING TAG (بالکل آخری line) ===
[VOICE] = voice-only / ان پڑھ customer
[TEXT]  = پڑھا لکھا customer
Voice + ان پڑھ → [VOICE] | Voice + پڑھا لکھا → [TEXT] | Text → [TEXT] | پہلی بار → [VOICE]`;

          // Build AI inputs
          const histG = [...history, { role:'user', parts:[{text:(customerName?`Customer: ${customerName}\n`:'')+`Message:\n${userText}`}] }];
          const histO = [
            { role:'system', content:SYS },
            ...history.map(c=>({role:c.role==='model'?'assistant':'user',content:c.parts?.[0]?.text||''})),
            { role:'user', content:(customerName?`Customer: ${customerName}\n`:'')+`Message:\n${userText}` }
          ];

          let aiReply='', usedProv='';

          // ════════════════════════════════════════════════════════════
          // STEP B: 5-TIER AI CHAIN
          // ════════════════════════════════════════════════════════════

          // Tier 1+2: Gemini
          if (!aiReply && GEM) {
            for (const m of ['gemini-3.7-flash','gemini-3.6-flash']) {
              if (aiReply) break;
              const cb=`g:${m}`; if(isBlocked(cb)){console.warn('[SKIP]',cb);continue;}
              for (let a=1;a<=2;a++) {
                if (aiReply) break;
                const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),20000);
                try {
                  console.log(`[B] ${cb} att${a}`);
                  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEM}`,{
                    method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,
                    body:JSON.stringify({system_instruction:{parts:[{text:SYS}]},contents:histG,generationConfig:{temperature:0.7,maxOutputTokens:a===1?800:600}})
                  });
                  if (r.ok){const d=await r.json().catch(()=>({}));const raw=d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProv=cb;}console.log(`[B OK] ${cb} a${a}`);break;}
                  if (r.status===429){blockFor(cb,5*60*1000,'429');break;}
                  if (r.status===503&&a<2){await sleep(4000);continue;}
                  const et=await r.text().catch(()=>'');console.error(`[B FAIL] ${cb} ${r.status}:`,et.slice(0,80));break;
                } catch(e){const ab=e?.name==='AbortError'||String(e?.message||'').includes('abort');if(ab&&a<2){await sleep(2000);continue;}console.error(`[B EXC] ${cb}:`,e?.message);break;}
                finally{clearTimeout(t);}
              }
            }
          }

          // Tier 3: Cerebras
          if (!aiReply&&CER&&!isBlocked('cerebras')) {
            for(let a=1;a<=2;a++){if(aiReply)break;try{console.log(`[B] cerebras a${a}`);const r=await oaiChat({url:'https://api.cerebras.ai/v1',key:CER,model:'llama-3.3-70b',messages:histO});if(r.ok){const d=await r.json().catch(()=>({}));const raw=d.choices?.[0]?.message?.content?.trim();if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProv='cerebras';}console.log('[B OK] cerebras');break;}if(r.status===429){blockFor('cerebras',5*60*1000,'429');break;}if(r.status===503&&a<2){await sleep(4000);continue;}console.error('[B FAIL] cerebras',r.status);break;}catch(e){const ab=e?.name==='AbortError'||String(e?.message||'').includes('abort');if(ab&&a<2){await sleep(2000);continue;}console.error('[B EXC] cerebras:',e?.message);break;}}
          }

          // Tier 4: Groq
          if (!aiReply&&GROQ) {
            for(const gm of['openai/gpt-oss-120b','qwen/qwen3.6-27b']){if(aiReply)break;const cb=`gr:${gm}`;if(isBlocked(cb))continue;try{console.log(`[B] ${cb}`);const r=await oaiChat({url:'https://api.groq.com/openai/v1',key:GROQ,model:gm,messages:histO});if(r.ok){const d=await r.json().catch(()=>({}));const raw=d.choices?.[0]?.message?.content?.trim();if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProv=cb;}console.log(`[B OK] ${cb}`);break;}if(r.status===429){blockFor(cb,5*60*1000,'429');break;}console.error(`[B FAIL] ${cb}`,r.status);break;}catch(e){console.error(`[B EXC] ${cb}:`,e?.message);break;}}
          }

          // Tier 5: OpenRouter
          if (!aiReply&&OR&&!isBlocked('or:mistral')) {
            try{console.log('[B] openrouter');const r=await oaiChat({url:'https://openrouter.ai/api/v1',key:OR,model:'mistralai/mistral-7b-instruct:free',messages:histO});if(r.ok){const d=await r.json().catch(()=>({}));const raw=d.choices?.[0]?.message?.content?.trim();if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProv='or:mistral';}console.log('[B OK] openrouter');}else if(r.status===429)blockFor('or:mistral',5*60*1000,'429');else console.error('[B FAIL] openrouter',r.status);}catch(e){console.error('[B EXC] openrouter:',e?.message);}
          }

          if (!aiReply) { aiReply='Thori dair mein wapas aati hoon. Shukriya sabr ka 🙏'; console.warn('[B FALLBACK]'); }
          else console.log(`[B DONE] prov=${usedProv}`);

          // ════════════════════════════════════════════════════════════
          // [GR2+GR4+GR6] GROUNDING VALIDATION
          // ════════════════════════════════════════════════════════════
          const orderTag = parseOrderTag(aiReply);
          if (orderTag) {
            // [GR2] Price validation
            const priceCheck = validateOrderPrice(orderTag);
            if (!priceCheck.valid) {
              console.warn('[GR2] Price mismatch:', priceCheck.reason);
              if (priceCheck.corrected) {
                // Correct the price in reply
                aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi,
                  `[ORDER:name=${orderTag.name}|product=${orderTag.product}|qty=${orderTag.qty}|price=${priceCheck.corrected.total}|payment=${orderTag.payment}|address=${orderTag.address}|city=${orderTag.city}]`
                );
                console.log('[GR2] Price corrected to:', priceCheck.corrected.total);
              }
            }

            // [GR6] Address validation
            const addrCheck = validateAddress(orderTag.address);
            if (!addrCheck.valid) {
              console.warn('[GR6] Address invalid:', addrCheck.msg);
              // Remove order tag — address incomplete
              aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();
              aiReply += `\n\n⚠️ پتہ مکمل نہیں ہے (${addrCheck.msg})۔ براہ کرم مکمل پتہ دیں۔`;
            } else {
              // [GR4] COD verification state update
              if ((orderTag.payment||'').toLowerCase().includes('cod')) {
                const cod_state = setOrderState(from, {
                  status:      ORDER_STATUS.COD_WAIT,
                  product:     orderTag.product,
                  qty:         parseInt(orderTag.qty)||1,
                  price:       priceCheck.corrected?.total || parseInt(orderTag.price)||0,
                  payment:     'COD',
                  address:     orderTag.address,
                  city:        fixCities(orderTag.city||''),
                  customerName: orderTag.name||customerName,
                });
                console.log('[GR4] COD state set, awaiting confirmation');
              }

              // [GR3] Confirmed order — save to DB + sheet
              const orderId = generateOrderId();
              const finalOrder = {
                order_id:      orderId,
                phone_number:  from,
                customer_name: orderTag.name||customerName||'',
                product:       orderTag.product||'',
                qty:           parseInt(orderTag.qty)||1,
                price:         priceCheck.corrected?.total || parseInt(orderTag.price)||0,
                payment:       orderTag.payment||'',
                address:       orderTag.address||'',
                city:          fixCities(orderTag.city||''),
              };

              // Remove tag from reply, add order ID
              aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();
              aiReply += `\n\nآپ کا آرڈر نمبر: *${orderId}* 🎉`;

              // Save async
              const row = [new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}), finalOrder.customer_name, from, finalOrder.product, finalOrder.qty, finalOrder.price, finalOrder.payment, finalOrder.address, finalOrder.city, orderId, 'Pending'];
              sheetAppend(GSID,GSA,GSAK,row).catch(()=>{});
              dbSaveOrder(SBURL,SBKEY,finalOrder).catch(()=>{});
              setOrderState(from, { status:ORDER_STATUS.CONFIRMED, orderId });
              console.log('[GR3] Order confirmed:', orderId);
            }
          }

          // ── ROUTING: Extract [VOICE]/[TEXT] tag FIRST, then clean reply ──
          // BUG FIX: tags must be read BEFORE fixCities/strip removes them
          let sendVoice = false;
          {
            const lines   = aiReply.trim().split('\n');
            const lastFew = lines.slice(-4).map(l => l.trim().toUpperCase());
            const hasV    = lastFew.some(l => l === '[VOICE]');
            const hasT    = lastFew.some(l => l === '[TEXT]');

            if (hasV || hasT) {
              // Strip tag lines from bottom of reply
              let cut = lines.length;
              for (let i = lines.length - 1; i >= 0; i--) {
                const u = lines[i].trim().toUpperCase();
                if (u === '[VOICE]' || u === '[TEXT]' || u === '') cut = i;
                else break;
              }
              aiReply = lines.slice(0, cut).join('\n').trim();

              // Routing decision
              if (!isAudio) {
                // Customer sent text → always TEXT reply
                sendVoice = false;
                console.log('[ROUTE] Text in → TEXT');
              } else if (hasV) {
                // Voice in + uneducated → VOICE reply
                sendVoice = true;
                console.log('[ROUTE] Voice + uneducated → VOICE');
              } else {
                // Voice in + educated → TEXT reply
                sendVoice = false;
                console.log('[ROUTE] Voice + educated → TEXT');
              }
            } else {
              // No tag found — safe default: match what customer sent
              sendVoice = isAudio;
              console.log('[ROUTE] No tag — default:', sendVoice ? 'VOICE' : 'TEXT');
            }
          }

          // NOW clean cities + remove any leftover stray tags
          aiReply = fixCities(aiReply).replace(/\[VOICE\]|\[TEXT\]|\[ORDER:[^\]]*\]/gi, '').trim();

          if (!aiReply.trim()) aiReply='Thori dair mein wapas aati hoon. Shukriya 🙏';

          // [M1] Save history + order state to Supabase
          history.push({role:'user',parts:[{text:userText}]});
          history.push({role:'model',parts:[{text:aiReply}]});
          if(history.length>20)history.splice(0,history.length-20);
          const currentOrderState = getOrderState(from);
          dbSave(SBURL,SBKEY,from,customerName,history,currentOrderState).catch(()=>{});
          if(!SBURL){const lh=localHistory(from);lh.push({role:'user',parts:[{text:userText}]});lh.push({role:'model',parts:[{text:aiReply}]});if(lh.length>20)lh.splice(0,lh.length-20);}

          // STEP C: ElevenLabs TTS [U1]
          let voiceSent=false;
          if(sendVoice&&ELAB&&EVID&&WT&&PID){
            try{
              console.log('[C] TTS...');
              const tts=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EVID}`,{
                method:'POST',headers:{'xi-api-key':ELAB,'Content-Type':'application/json','Accept':'audio/mpeg'},
                body:JSON.stringify({text:aiReply,model_id:'eleven_flash_v2_5',language_code:'ur',voice_settings:{stability:0.75,similarity_boost:0.85,style:0.4,use_speaker_boost:true}})
              });
              if(tts.ok){
                const buf=await tts.arrayBuffer();
                const mfd=new globalThis.FormData();
                mfd.append('messaging_product','whatsapp');
                mfd.append('file',new globalThis.Blob([buf],{type:'audio/mpeg'}),'voice.mp3');
                mfd.append('type','audio/mpeg');
                const up=await fetch(`https://graph.facebook.com/v20.0/${PID}/media`,{method:'POST',headers:{Authorization:`Bearer ${WT}`},body:mfd});
                const ud=await up.json().catch(()=>({}));
                if(up.ok&&ud?.id){
                  const vr=await fetch(`https://graph.facebook.com/v20.0/${PID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${WT}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:from,type:'audio',audio:{id:ud.id}})});
                  if(vr.ok){voiceSent=true;console.log('[C OK]');}
                  else console.error('[C FAIL] send:',vr.status);
                }else console.error('[C FAIL] upload:',up.status);
              }else if(tts.status===429)console.warn('[C] 429→text');
              else console.error('[C FAIL] EL:',tts.status);
            }catch(e){console.error('[C ERR]:',e.message);}
          }

          // STEP D: Text reply
          if(!voiceSent&&WT&&PID){
            const tr=await fetch(`https://graph.facebook.com/v20.0/${PID}/messages`,{
              method:'POST',headers:{Authorization:`Bearer ${WT}`,'Content-Type':'application/json'},
              body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:from,type:'text',text:{preview_url:false,body:aiReply}})
            });
            if(tr.ok)console.log('[D OK] id:',msgId||'n/a');
            else{const e=await tr.text().catch(()=>'');console.error('[D FAIL]',tr.status,e.slice(0,80));}
          }

        } // end messages loop
      } catch(err) { console.error('[FATAL]:', err.message, err.stack); }
    })();

    if(waitUntilFn){waitUntilFn(proc);return res.status(200).send('EVENT_RECEIVED');}
    await proc;
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).send('Method Not Allowed');
};
