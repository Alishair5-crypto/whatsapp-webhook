// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  Built on: commit 8a9f7aa (last working voice base)
//
//  BUGS FIXED vs current GitHub code:
//  [B1]  gemini-2.5-flash removed (deprecated/404) → gemini-3.7-flash primary, gemini-3.6-flash fallback
//  [B2]  Timeout 7s → 20s (prevents premature abort)
//  [B3]  maxOutputTokens 300 → 800 (Urdu needs more tokens, was cutting replies)
//  [B4]  whisper-large-v3 → whisper-large-v3-turbo (faster, better Urdu)
//  [B5]  Whisper prompt English → Urdu with Faisalabad explicit (fixes Faizabad error)
//  [B6]  Payment numbers from env vars (JAZZCASH_NUMBER, EASYPAISA_NUMBER)
//  [B7]  Deduplication by message.id (stops Meta retry duplicate messages)
//  [B8]  Send 200 to Meta immediately via waitUntil (prevents retry storm)
//  [B9]  Gemini 429 circuit breaker (skips rate-limited model 5 min)
//  [B10] Abort retry — on timeout, retry same model once before moving on
//  [B11] Groq LLM fallback (openai/gpt-oss-120b → qwen/qwen3.6-27b)
//  [B12] Midnight PKT circuit breaker reset (daily quota refills at midnight)
//  [B13] City name correction — Faizabad→Faisalabad (STT + AI reply)
//  [B14] Neon DB persistent memory (survives cold starts)
//  [B15] Google Sheets order auto-save via [ORDER:...] tag
//  [B16] PKT time injected into system prompt (correct time-based greetings)
//  [B17] ElevenLabs eleven_flash_v2_5 + language_code:ur (better Urdu voice)
//  [B18] fromNumber missing → skip safely
//  [B19] mediaData.url missing → log + fallback (was silent)
//  [B20] System prompt fixed — removed "Text messages only" (voice IS handled)
//
//  REQUIRED ENV VARS:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//  DATABASE_URL         ← Neon PostgreSQL (create table below)
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY
//
//  NEON TABLE (run once in Neon SQL editor):
//  CREATE TABLE IF NOT EXISTS zara_conversations (
//    phone_number  TEXT PRIMARY KEY,
//    customer_name TEXT DEFAULT '',
//    history       JSONB DEFAULT '[]',
//    last_seen     TIMESTAMPTZ DEFAULT NOW(),
//    msg_count     INTEGER DEFAULT 0
//  );
//
//  OPTIONAL ENV VARS:
//  ELEVENLABS_VOICE_ID  (default: 21m00Tcm4TlvDq8ikWAM = Rachel, free)
//  CEREBRAS_API_KEY     (extra AI fallback, free)
//  OPENROUTER_API_KEY   (extra AI fallback, free)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── [B8] Vercel waitUntil — send 200 fast, process async ─────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── [B9] Circuit breaker ──────────────────────────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = k      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

// ── [B12] Midnight PKT reset ──────────────────────────────────────────────────
function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Karachi', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) { global._cb.clear(); console.log('[CB] Midnight PKT reset — quota refilled'); }
  } catch (_) {}
}

// ── [B7] Deduplication ────────────────────────────────────────────────────────
if (!global._dedup) global._dedup = new Map();
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v <= now) global._dedup.delete(k);
  if ((global._dedup.get(msgId)||0) > now) return true;
  global._dedup.set(msgId, now + 10*60*1000);
  return false;
}

// ── [B14] Neon DB persistent memory ──────────────────────────────────────────
let _neonSql = null;
function getNeon(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  if (!_neonSql) {
    try { const {neon} = require('@neondatabase/serverless'); _neonSql = neon(dbUrl); }
    catch(e) { console.error('[DB] neon init failed:', e.message); return null; }
  }
  return _neonSql;
}
const _dbCache = new Map();
async function dbGet(dbUrl, phone) {
  if (_dbCache.has(phone)) return _dbCache.get(phone);
  const sql = getNeon(dbUrl); if (!sql) return null;
  try {
    const rows = await sql`SELECT history, customer_name FROM zara_conversations WHERE phone_number=${phone} LIMIT 1`;
    if (rows?.length) {
      const d = { history: rows[0].history||[], customerName: rows[0].customer_name||'' };
      _dbCache.set(phone, d); return d;
    }
  } catch(e) { console.error('[DB GET]', e.message); }
  return null;
}
async function dbSave(dbUrl, phone, customerName, history) {
  _dbCache.set(phone, {history, customerName});
  const sql = getNeon(dbUrl); if (!sql) return;
  try {
    await sql`
      INSERT INTO zara_conversations (phone_number, customer_name, history, last_seen, msg_count)
      VALUES (${phone}, ${customerName||''}, ${JSON.stringify(history.slice(-20))}::jsonb, NOW(), ${history.length})
      ON CONFLICT (phone_number) DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        history       = EXCLUDED.history,
        last_seen     = NOW(),
        msg_count     = EXCLUDED.msg_count
    `;
  } catch(e) { console.error('[DB SAVE]', e.message); }
}

// ── [B13] City name correction ────────────────────────────────────────────────
const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()]||w) : t;

// ── [B15] Google Sheets ───────────────────────────────────────────────────────
let _gTok = {token:null, exp:0};
async function getGToken(email, key) {
  if (_gTok.token && Date.now() < _gTok.exp-300000) return _gTok.token;
  try {
    const now=Math.floor(Date.now()/1000), b64=s=>Buffer.from(s).toString('base64url');
    const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const p=b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    const s=crypto.createSign('RSA-SHA256'); s.update(`${h}.${p}`);
    const sig=s.sign(key.replace(/\\n/g,'\n'),'base64url');
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}`});
    const d=await r.json();
    if (d.access_token) { _gTok={token:d.access_token,exp:Date.now()+(d.expires_in||3600)*1000}; return _gTok.token; }
  } catch(e) { console.error('[GTOKEN]',e.message); }
  return null;
}
function parseOrderTag(text) {
  const m=text.match(/\[ORDER:([^\]]+)\]/i); if(!m) return null;
  const o={};
  for(const p of m[1].split('|')){const[k,...v]=p.split('=');if(k&&v.length)o[k.trim().toLowerCase()]=v.join('=').trim();}
  return Object.keys(o).length?o:null;
}
async function saveToSheet(sid, email, key, order, phone) {
  if(!sid||!email||!key) return;
  try {
    const tok=await getGToken(email,key); if(!tok) return;
    const row=[
      new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),
      order.name||'', phone||'', order.product||'',
      order.qty||'', order.price||'', order.payment||'',
      order.address||'', order.city||'', 'Pending'
    ];
    const res=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Sheet1!A:J:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
    if(res.ok) console.log('[SHEET] Order saved ✓');
    else { const e=await res.text(); console.error('[SHEET FAIL]',res.status,e.slice(0,150)); }
  } catch(e) { console.error('[SHEET]',e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// [B16] PKT time for system prompt
function getPKT() {
  try {
    const p={};
    for(const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT unavailable'; }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function oaiChat({url,key,model,messages,maxTokens=800,timeout=20000}) {
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),timeout);
  try { return await fetch(`${url}/chat/completions`,{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.7,max_tokens:maxTokens})}); }
  finally { clearTimeout(t); }
}

// ── In-memory history fallback ────────────────────────────────────────────────
const chatHistories = new Map();

// ═════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();

  // Env vars
  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      ||'').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     ||'').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        ||'').trim();
  const GEMINI_API_KEY      = (process.env.GEMINI_API_KEY      ||'').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        ||'').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  ||'').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID ||'21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     ||'').trim();  // [B6]
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    ||'').trim();  // [B6]
  const CEREBRAS_API_KEY    = (process.env.CEREBRAS_API_KEY    ||'').trim();
  const OPENROUTER_API_KEY  = (process.env.OPENROUTER_API_KEY  ||'').trim();
  const DATABASE_URL        = (process.env.DATABASE_URL        ||'').trim();  // [B14]
  const GOOGLE_SHEETS_ID    = (process.env.GOOGLE_SHEETS_ID    ||'').trim();  // [B15]
  const GOOGLE_SA_EMAIL     = (process.env.GOOGLE_SA_EMAIL     ||'').trim();  // [B15]
  const GOOGLE_SA_KEY       = (process.env.GOOGLE_SA_KEY       ||'').trim();  // [B15]

  // [B16] System prompt with PKT time + all fixes
  const SYSTEM_PROMPT = `آپ زارہ ہیں — فاطمہ آرٹس (Fatima Arts) کی گرم جوش سیلز ایجنٹ، پاکستان کا ایک premium unstitched fabric brand۔ آپ روبوٹ نہیں ہیں۔ کبھی AI، automation یا software کا ذکر نہ کریں۔

ابھی کا وقت (PKT): ${getPKT()}

=== زبان اور جواب کا طریقہ (سب سے اہم — لازمی پڑھیں) ===

🔴 DEFAULT زبان: ہمیشہ اردو script (اردو حروف میں) میں جواب دیں
یعنی: "جی آپی، فاطمہ آرٹس میں خوش آمدید 😊" — نہ کہ "Ji aapi, Fatima Arts mein khush aamdeed"

زبان کا اصول (صرف customer کی زبان دیکھ کر فیصلہ کریں):
1. Customer اردو script میں لکھے (مثلاً: "مجھے کپڑا چاہیے") → اردو script میں جواب دیں ✅
2. Customer Roman Urdu میں لکھے (مثلاً: "mujhe kapra chahiye") → Roman Urdu میں جواب دیں ✅
3. Customer English میں لکھے (مثلاً: "I want fabric") → English میں جواب دیں ✅
4. Customer voice note بھیجے → transcribed text کی زبان دیکھ کر جواب دیں ✅

⚠️ Roman Urdu صرف اسی وقت لکھیں جب customer نے خود Roman Urdu لکھا ہو
⚠️ اگر کوئی یقین نہ ہو → DEFAULT: اردو script میں جواب دیں
⚠️ زبان خود سے کبھی نہ بدلیں جب تک customer نہ بدلے

لہجہ: خالص پاکستانی اردو — نہ ہندی لہجہ، نہ انگریزی accent

=== شہروں کے نام (لازمی درست لکھیں) ===
⚠️ Faisalabad (کبھی Faizabad یا Faizaabad نہیں لکھنا)
Lahore • Karachi • Islamabad • Rawalpindi • Multan • Gujranwala • Peshawar • Quetta

=== پہچان ===
نام: زارہ — فاطمہ آرٹس ٹیم ممبر
لہجہ: گرم، دوستانہ، پیشہ ورانہ — ہمدرد ساتھی کی طرح
ہر پیغام میں customer کا نام استعمال کریں (اگر معلوم ہو)
زیادہ سے زیادہ 2-3 emojis فی پیغام
اگر پوچھیں: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== وقت کی بنیاد پر سلام (PKT وقت اوپر دیکھیں) ===
06:00–12:00 → صبح بخیر! 🌅
12:00–17:00 → خیریت سے ہیں؟ ☀️
17:00–21:00 → شام بخیر! ✨
21:00–06:00 → السلام علیکم! (مختصر جواب، کل صبح مکمل)
صرف پہلے پیغام پر سلام، ہر بار نہیں۔

=== موسم کی ترجیح ===
سردی (نومبر–فروری): مارینہ، ویلوٹ، دھنک، کرندی پہلے بتائیں
گرمی (اپریل–ستمبر): لان، لنن، پرنٹڈ سوٹ پہلے بتائیں
عید الفطر (رمضان آخری 10 دن): ایمبرائیڈرڈ، فینسی، کوٹیل
عید الاضحیٰ (ذوالحج 1-10): ایمبرائیڈرڈ، ویلوٹ، کوٹیل
شادی سیزن (اکتوبر–دسمبر، مارچ–اپریل): ایمبرائیڈرڈ، ویلوٹ، فینسی

=== مصنوعات (سب unstitched) ===
1. لان/پرنٹڈ — گرمی، ہلکا، سانس لینے والا
2. ایمبرائیڈرڈ — شادیاں، خاص مواقع
3. لنن/کھدر — کلاسک، درمیانی موسم
4. کوٹیل — premium، رسمی مواقع
5. کرندی — نرم، مقبول
6. مارینہ — گرم، آرام دہ، سردی
7. ویلوٹ — شاہانہ، سردی
8. دھنک — نرم، گرم، سردی
پہلے کپڑے کی خصوصیت + موسم + موقع بتائیں۔ قیمت صرف جب پوچھیں۔

=== اپ سیل (ایک، فطری) ===
لان پوچھے → "ویسے ہمارا کرندی بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
مارینہ پوچھے → "اگر کچھ اور premium چاہیے تو ہمارا ویلوٹ بھی دیکھیں — بہت خوبصورت ہے"
retail آرڈر → wholesale mention کریں اگر دکاندار لگے

=== قیمت ===
ریٹیل: 1 سوٹ = 3,600 روپے | ڈیلیوری الگ | کوئی minimum نہیں
ہول سیل (10+ سوٹ): 2,999/سوٹ | 10 سوٹ = 29,990 | شہر ڈیلیوری مفت

=== مول بھاؤ ===
پہلی بار: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — اتنی quality اس price میں کہیں نہیں ملتی 🎨"
دوسری بار: "آپی! ہم quality میں کبھی compromise نہیں کرتے — یہی ہماری پہچان ہے 😊"
تیسری بار: "آپی، discount تو boss کا اختیار ہے — میں ابھی پوچھتی ہوں" → boss alert
بغیر boss اجازت discount کبھی نہیں۔

=== ادائیگی ===
1. JazzCash  → ${JAZZCASH_NUMBER  ||'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER ||'boss se confirm karein'}
3. COD — ادائیگی ڈیلیوری پر
• COD: مکمل پتہ + فون نمبر + متبادل نمبر لیں
• JazzCash/EasyPaisa: نمبر دیں، screenshot مانگیں
• Screenshot ملے → فوراً boss کو alert کریں
• Payment یا COD بغیر آرڈر کبھی confirm نہ کریں

=== ڈیلیوری ===
شہر: 1-2 working days | باہر: 3-5 working days
ہول سیل شہر: مفت | ہول سیل باہر: extra charges
آرڈر کے بعد: مکمل پتہ مانگیں

=== واپسی/تبادلہ ===
واپسی نہیں — سب sales final
تبادلہ صرف: اصلی خرابی یا غلط سامان
24 گھنٹے میں request + تصویر ثبوت | boss فیصلہ کرے

=== اوقات ===
پیر–اتوار: OPEN ✅ | جمعہ 11AM–3PM: بند
جمعہ کے بعد: قطار کے سب پیغامات کا جواب
رات 10 بجے کے بعد: مختصر جواب، کل صبح مکمل

=== آرڈر کا طریقہ ===
1. boss کو alert: نام + سامان + retail/wholesale
2. confirm: product + قیمت + payment options
3. ڈیلیوری پتہ مانگیں
4. ادائیگی کا طریقہ confirm کریں

آرڈر confirm ہونے پر یہ tag لکھیں (اپنی line پر):
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]
صرف ایک بار جب آرڈر پہلی بار confirm ہو۔ city درست لکھیں۔

=== boss کو فوری call ===
🚨 customer ناراض، بدتمیز
🛍️ wholesale (10+ سوٹ)
💰 retail 10,000+ روپے
✅ payment screenshot
🔄 تبادلہ کی درخواست
🏷️ تیسری بار discount مانگے
❓ کوئی غیر معمولی صورتحال

=== حالات کی پہچان ===
نیا customer: گرم خوش آمدید، فاطمہ آرٹس متعارف کروائیں
پرانا customer: نام + آخری product context + upsell
آرڈر ہو جائے: confirm + قیمت + payment + پتہ مانگیں
payment ہو جائے: شکریہ + delivery timeline
شکایت: پہلے معذرت + boss alert + تصویر ثبوت
مول بھاؤ: 3-step sequence، خود discount نہ دیں
wholesale: فوری boss alert
voice note: transcribed text کو normal message سمجھیں

=== اعتماد سازی ===
کپڑے کی اصلیت: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
رنگ کی فکر: "آپی! رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
پہلی بار: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"

=== یادداشت ===
پوری گفتگو یاد رکھیں۔ context استعمال کریں۔ جواب دیے سوال دوبارہ نہ پوچھیں۔

=== مرد customer ===
"آپی" کبھی نہیں۔ "بھائی جان" یا "جناب" استعمال کریں۔

=== پیغام کی لمبائی ===
زیادہ سے زیادہ 5-6 سطریں۔ ضرورت ہو تو 2 پیغاموں میں بھیجیں۔

=== کبھی نہ کریں ===
❌ AI/bot/automated کہنا
❌ boss بغیر discount
❌ competitors کا ذکر
❌ payment/COD بغیر آرڈر confirm
❌ رات 10 بجے کے بعد outbound
❌ جمعہ 11AM–3PM`;

  // ─── GET: Webhook Verification ───────────────────────────────────────────
  if (req.method === 'GET') {
    const protocol = req.headers['x-forwarded-proto']||'https';
    const host     = req.headers['x-forwarded-host']||req.headers.host||'localhost';
    const url      = new URL(req.url, `${protocol}://${host}`);
    const mode     = url.searchParams.get('hub.mode');
    const token    = url.searchParams.get('hub.verify_token');
    const challenge= url.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode==='subscribe' && String(token).trim()===String(VERIFY_TOKEN).trim()) {
        console.log('[VERIFY] Webhook verified ✓');
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Active');
  }

  // ─── POST: Message Handler ────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body==='string') { try { body=JSON.parse(body); } catch(e) {} }

    const entry    = body?.entry?.[0];
    const value    = entry?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

    // [B8] Always send 200 to Meta first
    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN||!PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        const message = messages[0];
        if (!message) return;

        // [B7] Deduplication
        if (alreadyProcessed(message?.id)) {
          console.log('[DEDUP] Skip:', message?.id);
          return;
        }

        // [B18] Validate fromNumber
        const fromNumber = message.from;
        if (!fromNumber) { console.error('[ERROR] message.from missing'); return; }

        const isAudioIncoming = message.type==='audio' || message.type==='voice';
        const contact         = contacts.find(c=>c?.wa_id===fromNumber)||contacts[0]||null;
        const customerName    = (contact?.profile?.name||'').trim();

        // ── [B14] Load history from Neon or in-memory ─────────────────
        let history = [];
        const dbData = await dbGet(DATABASE_URL, fromNumber);
        if (dbData) {
          history = dbData.history||[];
        } else {
          if (!chatHistories.has(fromNumber)) chatHistories.set(fromNumber, []);
          history = chatHistories.get(fromNumber);
        }
        const MAX_HISTORY = 20;

        let userMessageText = '';

        // ── STEP A: Text extract or Groq Whisper transcription ────────
        if (message.type==='text') {
          userMessageText = fixCities(message.text?.body||''); // [B13]

        } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
          console.log('[STEP A] Fetching audio from Meta...');
          const mediaId = message.audio?.id || message.voice?.id;

          if (!mediaId) {
            userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
          } else {
            const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
              headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
            });
            if (!mediaRes.ok) {
              console.error('[STEP A FAIL] Media fetch:', mediaRes.status);
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              const mediaData = await mediaRes.json();
              if (!mediaData?.url) {
                // [B19] was silent before
                console.error('[STEP A FAIL] mediaData.url missing:', JSON.stringify(mediaData));
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const audioStream = await fetch(mediaData.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                const arrayBuffer = await audioStream.arrayBuffer();

                const formData = new globalThis.FormData();
                const blob     = new globalThis.Blob([arrayBuffer], { type:'audio/ogg' });
                formData.append('file',     blob, 'voice.ogg');
                formData.append('model',    'whisper-large-v3-turbo'); // [B4]
                formData.append('language', 'ur');
                // [B5] Urdu prompt with Faisalabad explicit
                formData.append('prompt', 'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');

                const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                  method:'POST', headers:{ Authorization: `Bearer ${GROQ_API_KEY}` }, body: formData
                });
                if (groqRes.ok) {
                  const groqData  = await groqRes.json();
                  userMessageText = fixCities((groqData.text||'').trim()); // [B13]
                  console.log('[STEP A SUCCESS] Transcribed:', userMessageText.slice(0,80));
                } else {
                  console.error('[STEP A FAIL] Groq:', groqRes.status);
                  userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                }
              }
            }
          }

        } else if (message.type==='image')    { userMessageText='[Customer ne image bheji — poochein kya chahiye]'; }
          else if (message.type==='sticker')  { userMessageText='[Customer ne sticker bheja — friendly acknowledgment do]'; }
          else if (message.type==='document') { userMessageText='[Customer ne document bheja — poochein kya chahiye]'; }
          else                                { userMessageText='[Customer ne kuch bheja — poochein kya chahiye]'; }

        if (!userMessageText.trim()) userMessageText = 'السلام علیکم';

        // Build AI inputs
        const geminiContents = [
          ...history,
          { role:'user', parts:[{ text:(customerName?`Customer name: ${customerName}\n`:'')+userMessageText }] }
        ];
        const oaiMessages = [
          { role:'system', content:SYSTEM_PROMPT },
          ...history.map(c=>({ role:c.role==='model'?'assistant':'user', content:c.parts?.[0]?.text||'' })),
          { role:'user', content:(customerName?`Customer name: ${customerName}\n`:'')+userMessageText }
        ];

        let aiReply = '';

        // ══════════════════════════════════════════════════════════════
        // STEP B: AI CHAIN
        // ══════════════════════════════════════════════════════════════

        // Tier 1+2: Gemini [B1][B2][B3][B9][B10]
        if (!aiReply && GEMINI_API_KEY) {
          for (const model of ['gemini-3.7-flash','gemini-3.6-flash']) {
            if (aiReply) break;
            const cbKey = `g:${model}`;
            if (isBlocked(cbKey)) { console.warn('[SKIP]', cbKey); continue; }

            for (let att=1; att<=2; att++) {
              if (aiReply) break;
              const ctrl=new AbortController();
              const tid=setTimeout(()=>ctrl.abort(), 20000); // [B2]
              try {
                console.log(`[STEP B] ${model} attempt ${att}...`);
                const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                  { method:'POST', headers:{'Content-Type':'application/json'}, signal:ctrl.signal,
                    body:JSON.stringify({ system_instruction:{parts:[{text:SYSTEM_PROMPT}]}, contents:geminiContents,
                      generationConfig:{temperature:0.7, maxOutputTokens:800} }) } // [B3]
                );
                if (r.ok) {
                  const d=await r.json();
                  const raw=d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                  if (raw) aiReply=raw.replace(/[*_~`#]/g,'').trim();
                  console.log(`[STEP B SUCCESS] ${model} att${att}`); break;
                }
                if (r.status===429) { blockFor(cbKey,5*60*1000); break; } // [B9]
                if (r.status===503 && att<2) { await sleep(2000); continue; }
                const et=await r.text().catch(()=>'');
                console.error(`[STEP B FAIL] ${model} ${r.status}:`,et.slice(0,150)); break;
              } catch(e) {
                const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort');
                if (abort&&att<2) { console.warn(`[STEP B TIMEOUT] ${model} retry...`); await sleep(2000); continue; } // [B10]
                console.error(`[STEP B EXC] ${model}:`,e?.message); break;
              } finally { clearTimeout(tid); }
            }
          }
        }

        // Tier 3: Cerebras llama-3.3-70b (free, fast)
        if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cerebras')) {
          try {
            console.log('[STEP B] Cerebras...');
            const r=await oaiChat({url:'https://api.cerebras.ai/v1',key:CEREBRAS_API_KEY,model:'llama-3.3-70b',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log('[STEP B SUCCESS] Cerebras'); }
            else if (r.status===429) blockFor('cerebras',5*60*1000);
            else console.error('[STEP B FAIL] Cerebras:', r.status);
          } catch(e) { console.error('[STEP B EXC] Cerebras:',e?.message); }
        }

        // Tier 4: Groq LLM [B11] — correct 2026 model names
        if (!aiReply && GROQ_API_KEY) {
          for (const gm of ['openai/gpt-oss-120b','qwen/qwen3.6-27b']) {
            if (aiReply) break;
            const cbKey=`gr:${gm}`; if(isBlocked(cbKey)) continue;
            try {
              console.log(`[STEP B] Groq ${gm}...`);
              const r=await oaiChat({url:'https://api.groq.com/openai/v1',key:GROQ_API_KEY,model:gm,messages:oaiMessages});
              if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log(`[STEP B SUCCESS] Groq:${gm}`); break; }
              if (r.status===429) { blockFor(cbKey,5*60*1000); break; }
              console.error(`[STEP B FAIL] Groq:${gm}`, r.status); break;
            } catch(e) { console.error(`[STEP B EXC] Groq:${gm}:`,e?.message); break; }
          }
        }

        // Tier 5: OpenRouter (optional free fallback)
        if (!aiReply && OPENROUTER_API_KEY && !isBlocked('or:mistral')) {
          try {
            console.log('[STEP B] OpenRouter...');
            const r=await oaiChat({url:'https://openrouter.ai/api/v1',key:OPENROUTER_API_KEY,model:'mistralai/mistral-7b-instruct:free',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log('[STEP B SUCCESS] OpenRouter'); }
            else if (r.status===429) blockFor('or:mistral',5*60*1000);
            else console.error('[STEP B FAIL] OpenRouter:', r.status);
          } catch(e) { console.error('[STEP B EXC] OpenRouter:',e?.message); }
        }

        if (!aiReply) {
          aiReply = 'Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏';
          console.warn('[STEP B FALLBACK] All models failed.');
        }

        // [B15] Google Sheets — save order if [ORDER:...] tag in reply
        const orderTag = parseOrderTag(aiReply);
        if (orderTag) {
          aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi,'').trim();
          saveToSheet(GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, orderTag, fromNumber).catch(()=>{});
        }

        // [B13] City fix on AI reply
        aiReply = fixCities(aiReply);
        if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

        // Save to history
        history.push({ role:'user',  parts:[{ text:userMessageText }] });
        history.push({ role:'model', parts:[{ text:aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length-MAX_HISTORY);

        // Sync in-memory
        chatHistories.set(fromNumber, history);
        // [B14] Save to Neon async
        dbSave(DATABASE_URL, fromNumber, customerName, history).catch(()=>{});

        // ── STEP C: ElevenLabs TTS → WhatsApp Voice Note ──────────────
        // [B20] Only if customer sent audio (same as working base)
        let voiceSentSuccess = false;

        if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] ElevenLabs TTS...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method:'POST',
              headers: { 'xi-api-key':ELEVENLABS_API_KEY, 'Content-Type':'application/json', 'Accept':'audio/mpeg' },
              body: JSON.stringify({
                text:          aiReply,
                model_id:      'eleven_flash_v2_5', // [B17] better Urdu than multilingual_v2
                language_code: 'ur',               // [B17] explicit Urdu = no English accent
                voice_settings: {
                  stability:         0.75,          // consistent Urdu accent
                  similarity_boost:  0.85,          // stay close to voice character
                  style:             0.4,           // natural, not dramatic
                  use_speaker_boost: true           // clearer output
                }
              })
            });

            if (ttsRes.ok) {
              const arrayBuffer   = await ttsRes.arrayBuffer();
              const mediaFormData = new globalThis.FormData();
              const audioBlob     = new globalThis.Blob([arrayBuffer], { type:'audio/mpeg' });
              mediaFormData.append('messaging_product', 'whatsapp');
              mediaFormData.append('file', audioBlob, 'voice.mp3');
              mediaFormData.append('type', 'audio/mpeg');

              const uploadRes  = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                method:'POST', headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}` }, body: mediaFormData
              });
              const uploadData = await uploadRes.json();

              if (uploadData?.id) {
                const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                  method:'POST',
                  headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
                  body: JSON.stringify({
                    messaging_product:'whatsapp', recipient_type:'individual',
                    to:fromNumber, type:'audio', audio:{ id:uploadData.id }
                  })
                });
                if (sendVoiceRes.ok) {
                  voiceSentSuccess = true;
                  console.log('[STEP C SUCCESS] Voice note sent!');
                } else {
                  const e=await sendVoiceRes.text();
                  console.error('[STEP C FAIL] Send:', e.slice(0,150));
                }
              } else { console.error('[STEP C FAIL] Upload:', JSON.stringify(uploadData)); }

            } else if (ttsRes.status===429) {
              console.warn('[STEP C] ElevenLabs 429 quota → text fallback');
            } else {
              console.error('[STEP C FAIL] ElevenLabs:', ttsRes.status);
            }
          } catch(err) { console.error('[STEP C ERROR]:', err.message); }
        }

        // ── STEP D: Text fallback (only if voice NOT sent) ────────────
        if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method:'POST',
            headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
            body: JSON.stringify({
              messaging_product:'whatsapp', recipient_type:'individual',
              to:fromNumber, type:'text', text:{ preview_url:false, body:aiReply }
            })
          });
          if (textRes.ok) console.log('[STEP D SUCCESS] Text sent. id:', message?.id||'n/a');
          else { const e=await textRes.text().catch(()=>''); console.error('[STEP D FAIL]:', textRes.status, e.slice(0,150)); }
        }

      } catch(err) { console.error('[FATAL]:', err.message, err.stack); }
    })();

    // [B8] Send 200 fast, keep processing in background
    if (waitUntilFn) { waitUntilFn(processPromise); return res.status(200).send('EVENT_RECEIVED'); }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
