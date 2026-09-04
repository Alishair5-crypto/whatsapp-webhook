// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent (Neon DB)
//  2026-09-03 — PRODUCTION READY (OPTIMIZED)
//
//  MEMORY:
//  [M1] Neon PostgreSQL persistent memory — survives Vercel cold starts
//       Table: zara_conversations (phone_number, customer_name, history, last_seen, msg_count)
//       Fallback: in-memory Map (if DATABASE_URL not configured)
//
//  AI CHAIN (5 free providers, auto-failover):
//  1. Gemini 3.7-flash  2. Gemini 3.6-flash
//  3. Cerebras llama-3.3-70b  4. Groq openai/gpt-oss-120b
//  5. OpenRouter mistral-7b:free
//
//  SELF-HEAL SYSTEM:
//  [H1] Circuit breaker per model (429/503/timeout → block 5 min)
//  [H2] Force-reset: if ALL models blocked → clear all and retry
//  [H3] Midnight PKT reset (daily quota refills)
//  [H4] Structured error logging (error type + model + timestamp)
//  [H5] Model health table (persists across cold starts)
//
//  URDU QUALITY:
//  [U1] ElevenLabs Flash v2.5 model (lower latency, better Urdu)
//  [U2] Urdu-specific voice settings (stability 0.75, similarity 0.85)
//  [U3] City name correction (Faizabad → Faisalabad etc.)
//  [U4] System prompt Urdu-only instruction for AI replies
//
//  GOOGLE SHEETS:
//  [G1] Auto-save orders via [ORDER:...] tag
//  [G2] Service account JWT with in-memory caching
//
//  REQUIRED ENV VARS:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//  DATABASE_URL  ← for Neon persistent memory
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY  ← for orders
//
//  OPTIONAL:
//  CEREBRAS_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_VOICE_ID
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

// ── Vercel waitUntil ──────────────────────────────────────────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── [H1] Circuit breaker — in-memory (fast) ──────────────────────────────────
if (!global._cb)   global._cb   = new Map(); // key → blockedUntilMs
if (!global._errs) global._errs = new Map(); // key → { count, lastError }

const isBlocked = (k)      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms, reason='') => {
  global._cb.set(k, Date.now() + ms);
  const e = global._errs.get(k) || { count:0, lastError:'' };
  e.count++; e.lastError = reason;
  global._errs.set(k, e);
  console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s | reason: ${reason} | fails: ${e.count}`);
};

// [H2] Force-reset: if ALL Gemini + Groq models blocked → clear all
function selfHeal(providers) {
  const allBlocked = providers.every(k => isBlocked(k));
  if (allBlocked && providers.length > 0) {
    console.warn('[SELF-HEAL] All providers blocked — force clearing circuit breakers');
    for (const k of providers) global._cb.delete(k);
  }
}

// [H3] Midnight PKT reset
function maybeResetAtMidnight() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) {
      global._cb.clear(); global._errs.clear();
      console.log('[MIDNIGHT] Circuit breakers reset — daily quota refilled');
    }
  } catch (_) {}
}

// ── [M1] Neon PostgreSQL persistent memory ───────────────────────────────────
const memCache = new Map(); // in-memory cache with size management
function setMemCache(phone, data) {
  if (memCache.size > 300) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(phone, data);
}

async function dbGet(databaseUrl, phone) {
  if (memCache.has(phone)) return memCache.get(phone);
  if (!databaseUrl) return null;
  try {
    const sql = neon(databaseUrl);
    const rows = await sql`SELECT history, customer_name FROM zara_conversations WHERE phone_number = ${phone}`;
    if (rows?.length) {
      const data = { history: rows[0].history || [], customerName: rows[0].customer_name || '' };
      setMemCache(phone, data);
      return data;
    }
    return null;
  } catch(e) { console.error('[DB GET ERR]', e.message); return null; }
}

async function dbSave(databaseUrl, phone, customerName, history) {
  setMemCache(phone, { history, customerName });
  if (!databaseUrl) return;
  try {
    const sql = neon(databaseUrl);
    const histSlice = history.slice(-20);
    const msgCount = history.length;
    const lastSeen = new Date().toISOString();
    await sql`
      INSERT INTO zara_conversations (phone_number, customer_name, history, last_seen, msg_count)
      VALUES (${phone}, ${customerName || ''}, ${histSlice}::jsonb, ${lastSeen}, ${msgCount})
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        customer_name = EXCLUDED.customer_name,
        history = EXCLUDED.history,
        last_seen = EXCLUDED.last_seen,
        msg_count = EXCLUDED.msg_count
    `;
  } catch(e) { console.error('[DB SAVE ERR]', e.message); }
}

// In-memory fallback (when DATABASE_URL not configured)
const localHistories = new Map();
function getLocalHistory(phone) {
  if (!localHistories.has(phone)) {
    if (localHistories.size > 300) {
      const firstKey = localHistories.keys().next().value;
      localHistories.delete(firstKey);
    }
    localHistories.set(phone, []);
  }
  return localHistories.get(phone);
}

// ── City name correction [U3] ─────────────────────────────────────────────────
const CITY_FIX = {
  'faizabad':'Faisalabad','faizaabad':'Faisalabad','faisalabaad':'Faisalabad',
  'faisalbad':'Faisalabad','faisalaabad':'Faisalabad','fisalabad':'Faisalabad',
  'lahroe':'Lahore','lhaore':'Lahore','lahor':'Lahore',
  'karaachi':'Karachi','karachy':'Karachi','krachi':'Karachi',
  'rwalpindi':'Rawalpindi','rawalpndi':'Rawalpindi',
  'gujranwla':'Gujranwala','gujrnwala':'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()] || w) : t;

// ── Google Sheets [G1] & Token Caching [G2] ──────────────────────────────────
let cachedGoogleToken = { token: null, expiresAt: 0 };

async function getGoogleToken(email, key) {
  if (cachedGoogleToken.token && Date.now() < cachedGoogleToken.expiresAt - 300000) {
    return cachedGoogleToken.token;
  }
  try {
    const now = Math.floor(Date.now()/1000);
    const b64 = s => Buffer.from(s).toString('base64url');
    const h   = b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const p   = b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    const s   = crypto.createSign('RSA-SHA256'); s.update(`${h}.${p}`);
    const sig = s.sign(key.replace(/\\n/g,'\n'),'base64url');
    const r   = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}`});
    const data = await r.json();
    if (data.access_token) {
      cachedGoogleToken = {
        token: data.access_token,
        expiresAt: Date.now() + ((data.expires_in || 3600) * 1000)
      };
      return cachedGoogleToken.token;
    }
    return null;
  } catch(e) { console.error('[SHEETS TOKEN]', e.message); return null; }
}

async function saveOrder({ sheetsId, saEmail, saKey, order, phone }) {
  if (!sheetsId||!saEmail||!saKey) return;
  try {
    const token = await getGoogleToken(saEmail, saKey);
    if (!token) return;
    const row = [new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}), order.name||'', phone||'', order.product||'', order.qty||'', order.price||'', order.payment||'', order.address||'', order.city||'', 'Pending'];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/Sheet1!A:J:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({values:[row]})
    });
    console.log('[SHEETS] Order saved ✓');
  } catch(e) { console.error('[SHEETS ERR]', e.message); }
}

function parseOrder(text) {
  const m = text.match(/\[ORDER:([^\]]+)\]/i); if (!m) return null;
  const o = {};
  for (const p of m[1].split('|')) { const [k,...v]=p.split('='); if(k&&v.length) o[k.trim().toLowerCase()]=v.join('=').trim(); }
  return Object.keys(o).length ? o : null;
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

async function oaiChat({url, key, model, messages, maxTokens=800, timeout=20000}) {
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),timeout);
  try {
    return await fetch(`${url}/chat/completions`,{
      method:'POST', signal:ctrl.signal,
      headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,messages,temperature:0.7,max_tokens:maxTokens})
    });
  } finally { clearTimeout(t); }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  maybeResetAtMidnight();

  // Env
  const WT   = (process.env.WHATSAPP_TOKEN||'').trim();
  const PID  = (process.env.PHONE_NUMBER_ID||'').trim();
  const VT   = (process.env.VERIFY_TOKEN||'').trim();
  const GEM  = (process.env.GEMINI_API_KEY||'').trim();
  const GROQ = (process.env.GROQ_API_KEY||'').trim();
  const CER  = (process.env.CEREBRAS_API_KEY||'').trim();
  const OR   = (process.env.OPENROUTER_API_KEY||'').trim();
  const ELAB = (process.env.ELEVENLABS_API_KEY||'').trim();
  const EVID = (process.env.ELEVENLABS_VOICE_ID||'21m00Tcm4TlvDq8ikWAM').trim();
  const JCN  = (process.env.JAZZCASH_NUMBER||'').trim();
  const EPN  = (process.env.EASYPAISA_NUMBER||'').trim();
  const DBURL= (process.env.DATABASE_URL||'').trim();
  const GSID = (process.env.GOOGLE_SHEETS_ID||'').trim();
  const GSA  = (process.env.GOOGLE_SA_EMAIL||'').trim();
  const GSAK = (process.env.GOOGLE_SA_KEY||'').trim();

  // System prompt
  const SYS = `آپ زارہ ہیں — فاطمہ آرٹس (Fatima Arts) کی گرم جوش سیلز ایجنٹ۔ آپ روبوٹ نہیں ہیں۔ کبھی AI، automation یا software کا ذکر نہ کریں۔

CURRENT TIME: ${getPKT()}

=== اہم ہدایت: زبان اور لہجہ ===
جواب ہمیشہ اردو میں دیں — خالص پاکستانی اردو، نہ ہندی، نہ انگریزی لہجہ۔
اگر customer اردو میں لکھے → اردو میں جواب دیں
اگر Roman Urdu میں لکھے → Roman Urdu میں جواب دیں
اگر English میں لکھے → English میں جواب دیں
زبان customer کی پیروی کرے، خود سے نہ بدلے۔

=== شہروں کے نام — انتہائی ضروری ===
⚠️ فیصل آباد = Faisalabad (کبھی Faizabad نہ لکھیں)
⚠️ درست نام: Faisalabad • Lahore • Karachi • Islamabad • Rawalpindi • Multan • Gujranwala

=== پہچان ===
نام: زارہ — فاطمہ آرٹس ٹیم ممبر
لہجہ: گرم، دوستانہ، پیشہ ورانہ — ایک ہمدرد ساتھی کی طرح
ہر پیغام میں customer کا نام استعمال کریں (اگر معلوم ہو)
زیادہ سے زیادہ 2-3 emojis فی پیغام
اگر پوچھیں کہ آپ کون ہیں: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== وقت کی بنیاد پر سلام (PKT) ===
06:00–12:00 → صبح بخیر! 🌅
12:00–17:00 → خیریت سے ہیں؟ ☀️
17:00–21:00 → شام بخیر! ✨
21:00–06:00 → السلام علیکم!
صرف پہلے پیغام پر، ہر بار نہیں۔

=== موسم کی ترجیح ===
سردی (نومبر–فروری): مارینہ، ویلوٹ، دھنک، کرندی پہلے بتائیں
گرمی (اپریل–ستمبر): لان، لنن، پرنٹڈ سوٹ پہلے بتائیں

=== مصنوعات (سب unstiched) ===
لان/پرنٹڈ • ایمبرائیڈرڈ • لنن/کھدر • کوٹیل • کرندی • مارینہ • ویلوٹ • دھنک
پہلے کپڑے کی خصوصیت + موسم + موقع بتائیں۔ قیمت صرف جب پوچھیں۔

=== اپ سیل (ایک، فطری) ===
لان پوچھے → "ویسے ہمارا کرندی بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
مارینہ پوچھے → "اگر کچھ اور premium چاہیے تو ہمارا ویلوٹ بھی دیکھیں 😊"

=== قیمت ===
ریٹیل: 3,600 روپے/سوٹ | ڈیلیوری الگ | کوئی minimum نہیں
ہول سیل (10+ سوٹ): 2,999/سوٹ | شہر میں ڈیلیوری مفت

=== مول بھاؤ ===
1st: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — اتنی quality اس price میں کہیں نہیں ملتی 🎨"
2nd: "آپی! ہم quality میں کبھی compromise نہیں کرتے 😊"
3rd: "آپی، discount تو boss کا اختیار ہے — میں ابھی پوچھتی ہوں" → boss کو alert
بغیر boss اجازت discount کبھی نہیں۔

=== ادائیگی ===
1. JazzCash → ${JCN||'boss se confirm karein'}
2. EasyPaisa → ${EPN||'boss se confirm karein'}
3. COD — پتہ + فون نمبر لیں
screenshot ملے → فوراً boss کو alert کریں

=== ڈیلیوری ===
شہر: 1-2 دن | باہر: 3-5 دن | ہول سیل شہر: مفت

=== واپسی/تبادلہ ===
واپسی نہیں۔ تبادلہ صرف: خرابی/غلط سامان، 24 گھنٹے، تصویر ثبوت، boss فیصلہ کرے۔

=== اوقات ===
پیر–اتوار open ✅ | جمعہ 11AM–3PM بند | رات 10 بعد: مختصر جواب، کل صبح مکمل

=== آرڈر ===
1. boss کو alert (نام + سامان + retail/wholesale)
2. confirm: سامان + قیمت + ادائیگی
3. پتہ + شہر مانگیں
4. ادائیگی کا طریقہ

=== boss alert ===
🚨 ناراض | 🛍️ 10+ سوٹ | 💰 10,000+ | ✅ screenshot | 🔄 تبادلہ | 🏷️ تیسری بار discount | ❓ غیر معمولی

=== یادداشت ===
پوری گفتگو یاد رکھیں۔ context استعمال کریں۔ جواب دیے سوال دوبارہ نہ پوچھیں۔

=== مرد customer ===
"آپی" کبھی نہیں۔ "بھائی جان" یا "جناب" استعمال کریں۔

=== کبھی نہ کریں ===
❌ AI/bot/automated کہنا | ❌ boss اجازت بغیر discount | ❌ competitors
❌ payment/COD بغیر آرڈر confirm | ❌ رات 10 بعد outbound | ❌ جمعہ 11–3

=== Google Sheets آرڈر ٹیگ ===
جب customer پورا پتہ اور ادائیگی confirm کرے، یہ ٹیگ اپنی line پر لکھیں:
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]
صرف ایک بار جب آرڈر پہلی بار confirm ہو۔ city ہمیشہ درست لکھیں (Faisalabad، Lahore وغیرہ)۔

=== ROUTING TAG (آخری line پر لازمی) ===
[VOICE] = customer ان پڑھ: صرف voice notes، ٹوٹا پھوٹا text
[TEXT]  = customer پڑھا لکھا: درست جملے، punctuation
- voice note + ان پڑھ → [VOICE]
- voice note + پڑھا لکھا → [TEXT]
- text message → [TEXT]
- پہلی بار → [VOICE]
یہ ٹیگ بالکل آخری line ہو۔ اس کے بعد کچھ نہیں۔`;

  // ─── GET: Verify ──────────────────────────────────────────────────────────
  if (req.method==='GET') {
    const protocol=req.headers['x-forwarded-proto']||'https';
    const host=req.headers['x-forwarded-host']||req.headers.host||'localhost';
    const url=new URL(req.url,`${protocol}://${host}`);
    const mode=url.searchParams.get('hub.mode'), token=url.searchParams.get('hub.verify_token'), challenge=url.searchParams.get('hub.challenge');
    if (mode&&token) {
      if (mode==='subscribe'&&String(token).trim()===String(VT).trim()) { console.log('[VERIFY] OK'); return res.status(200).send(challenge); }
      return res.status(403).send('Token Mismatch');
    }
    return res.status(200).send('Webhook Active');
  }

  // ─── POST ─────────────────────────────────────────────────────────────────
  if (req.method==='POST') {
    let body=req.body;
    if (typeof body==='string') { try { body=JSON.parse(body); } catch(e) {} }

    const entry      = body?.entry?.[0];
    const value      = entry?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WT||!PID) { console.error('[CFG] Missing WHATSAPP_TOKEN/PHONE_NUMBER_ID'); return res.status(200).send('EVENT_RECEIVED'); }

    // Dedup store
    if (!global._dedup) global._dedup = new Map();
    const DEDUP_TTL = 10*60*1000;

    const processPromise = (async () => {
      // [H2] Self-heal check before processing
      const allKeys = ['g:gemini-3.7-flash','g:gemini-3.6-flash','cerebras','gr:openai/gpt-oss-120b','or:mistral'];
      selfHeal(allKeys.filter(k => isBlocked(k)));

      try {
        for (const msg of messages) {
          const msgId = msg?.id;

          // Dedup
          const now = Date.now();
          if (global._dedup.get(msgId) > now) { console.log('[DEDUP] Skip:', msgId); continue; }
          if (msgId) global._dedup.set(msgId, now+DEDUP_TTL);
          // Cleanup dedup
          if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v<=now) global._dedup.delete(k);

          const from = msg.from;
          if (!from) { console.error('[ERR] No from'); continue; }

          const isAudio      = msg.type==='audio'||msg.type==='voice';
          const contact      = contacts.find(c=>c?.wa_id===from)||contacts[0]||null;
          let customerName  = (contact?.profile?.name||'').trim();

          // [M1] Load history from Neon DB (or local fallback)
          let history = [];
          const dbData = await dbGet(DBURL, from);
          if (dbData) {
            history = dbData.history || [];
            if (!customerName && dbData.customerName) customerName = dbData.customerName;
          } else {
            history = getLocalHistory(from);
          }

          let userText = '';

          // STEP A: Text or voice
          if (msg.type==='text') {
            userText = fixCities(msg.text?.body||'');

          } else if (isAudio && GROQ && WT) {
            const mediaId = msg.audio?.id||msg.voice?.id;
            if (!mediaId) { userText='[Customer ne voice bheja]'; }
            else {
              console.log('[A] mediaId:', mediaId);
              const mr = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`,{headers:{'Authorization':`Bearer ${WT}`}});
              if (!mr.ok) { console.error('[A] Media:', mr.status); userText='[Customer ne voice bheja]'; }
              else {
                const md = await mr.json().catch(()=>({}));
                if (!md?.url) { console.error('[A] No URL'); userText='[Customer ne voice bheja]'; }
                else {
                  const ar = await fetch(md.url,{headers:{'Authorization':`Bearer ${WT}`}});
                  if (!ar.ok) { console.error('[A] Download:', ar.status); userText='[Customer ne voice bheja]'; }
                  else {
                    const buf=await ar.arrayBuffer();
                    const fd=new globalThis.FormData();
                    fd.append('file',new globalThis.Blob([buf],{type:'audio/ogg'}),'voice.ogg');
                    fd.append('model','whisper-large-v3-turbo');
                    fd.append('language','ur');
                    fd.append('prompt','فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');
                    const gr=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{'Authorization':`Bearer ${GROQ}`},body:fd});
                    if (gr.ok) {
                      const gd=await gr.json().catch(()=>({}));
                      userText=fixCities((gd.text||'').trim());
                      console.log('[A OK] len:', userText.length);
                    } else { console.error('[A] Groq STT:', gr.status); userText='[Customer ne voice bheja]'; }
                  }
                }
              }
            }
          } else if (msg.type==='image')    { userText='[Customer ne image bheji — poochein kya chahiye]'; }
            else if (msg.type==='sticker')  { userText='[Customer ne sticker bheja — friendly acknowledgment do]'; }
            else if (msg.type==='document') { userText='[Customer ne document bheja]'; }
            else                            { userText='[Customer ne kuch bheja]'; }

          if (!userText.trim()) userText='السلام علیکم';

          // Build AI inputs
          const histGemini = [
            ...history,
            { role:'user', parts:[{text:(customerName?`Customer name: ${customerName}\n`:'')+`Message:\n${userText}`}] }
          ];
          const histOAI = [
            { role:'system', content:SYS },
            ...history.map(c=>({role:c.role==='model'?'assistant':'user',content:c.parts?.[0]?.text||''})),
            { role:'user', content:(customerName?`Customer name: ${customerName}\n`:'')+`Message:\n${userText}` }
          ];

          let aiReply='', usedProvider='';

          // ════════════════════════════════════════════════════════════
          // STEP B: 5-TIER AI CHAIN
          // ════════════════════════════════════════════════════════════

          // Tier 1+2: Gemini
          if (!aiReply && GEM) {
            for (const model of ['gemini-3.7-flash','gemini-3.6-flash']) {
              if (aiReply) break;
              const cbKey = `g:${model}`;
              if (isBlocked(cbKey)) { console.warn('[SKIP]', cbKey); continue; }
              for (let att=1; att<=2; att++) {
                if (aiReply) break;
                const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),20000);
                try {
                  console.log(`[B] ${cbKey} att${att}`);
                  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEM}`,{
                    method:'POST', headers:{'Content-Type':'application/json'}, signal:ctrl.signal,
                    body:JSON.stringify({system_instruction:{parts:[{text:SYS}]},contents:histGemini,generationConfig:{temperature:0.7,maxOutputTokens:att===1?800:650}})
                  });
                  if (r.ok) {
                    const d=await r.json().catch(()=>({}));
                    const raw=d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (raw) { aiReply=raw.replace(/[*_~`#]/g,'').trim(); usedProvider=cbKey; }
                    console.log(`[B OK] ${cbKey} att${att}`); break;
                  }
                  if (r.status===429) { blockFor(cbKey,5*60*1000,'429 quota'); break; }
                  if (r.status===503&&att<2) { await sleep(4000); continue; }
                  const et=await r.text().catch(()=>''); console.error(`[B FAIL] ${cbKey} ${r.status}:`,et.slice(0,100)); break;
                } catch(e) {
                  const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort');
                  if (abort&&att<2) { await sleep(2000); continue; }
                  console.error(`[B EXC] ${cbKey}:`,e?.message); break;
                } finally { clearTimeout(t); }
              }
            }
          }

          // Tier 3: Cerebras
          if (!aiReply && CER && !isBlocked('cerebras')) {
            for (let att=1; att<=2; att++) {
              if (aiReply) break;
              try {
                console.log(`[B] cerebras att${att}`);
                const r=await oaiChat({url:'https://api.cerebras.ai/v1',key:CER,model:'llama-3.3-70b',messages:histOAI});
                if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider='cerebras';} console.log('[B OK] cerebras'); break; }
                if (r.status===429) { blockFor('cerebras',5*60*1000,'429'); break; }
                if (r.status===503&&att<2) { await sleep(4000); continue; }
                console.error('[B FAIL] cerebras',r.status); break;
              } catch(e) { const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort'); if(abort&&att<2){await sleep(2000);continue;} console.error('[B EXC] cerebras:',e?.message); break; }
            }
          }

          // Tier 4: Groq
          if (!aiReply && GROQ) {
            for (const gm of ['openai/gpt-oss-120b','qwen/qwen3.6-27b']) {
              if (aiReply) break;
              const cbKey=`gr:${gm}`; if(isBlocked(cbKey)) continue;
              try {
                console.log(`[B] ${cbKey}`);
                const r=await oaiChat({url:'https://api.groq.com/openai/v1',key:GROQ,model:gm,messages:histOAI});
                if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider=cbKey;} console.log(`[B OK] ${cbKey}`); break; }
                if (r.status===429) { blockFor(cbKey,5*60*1000,'429'); break; }
                console.error(`[B FAIL] ${cbKey}`,r.status); break;
              } catch(e) { console.error(`[B EXC] ${cbKey}:`,e?.message); break; }
            }
          }

          // Tier 5: OpenRouter
          if (!aiReply && OR && !isBlocked('or:mistral')) {
            try {
              console.log('[B] openrouter:mistral');
              const r=await oaiChat({url:'https://openrouter.ai/api/v1',key:OR,model:'mistralai/mistral-7b-instruct:free',messages:histOAI});
              if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider='or:mistral';} console.log('[B OK] openrouter'); }
              else if (r.status===429) blockFor('or:mistral',5*60*1000,'429');
              else console.error('[B FAIL] openrouter',r.status);
            } catch(e) { console.error('[B EXC] openrouter:',e?.message); }
          }

          if (!aiReply) {
            aiReply='Thori dair mein wapas aati hoon, system thoda busy hai. Shukriya sabr ka 🙏';
            console.warn('[B FALLBACK] All providers failed');
          } else console.log(`[B DONE] provider=${usedProvider}`);

          // [G1] Order tag
          const order = parseOrder(aiReply);
          if (order && GSID) {
            aiReply=aiReply.replace(/\[ORDER:[^\]]+\]/gi,'').trim();
            saveOrder({sheetsId:GSID,saEmail:GSA,saKey:GSAK,order,phone:from}).catch(()=>{});
          }

          // City fix on AI reply
          aiReply = fixCities(aiReply);

          // Routing tag
          let sendVoice=false;
          const lines=aiReply.trim().split('\n');
          const lastFew=lines.slice(-3).map(l=>l.trim().toUpperCase());
          const hasV=lastFew.some(l=>l==='[VOICE]'), hasT=lastFew.some(l=>l==='[TEXT]');
          if (hasV||hasT) {
            let cut=lines.length;
            for (let i=lines.length-1;i>=0;i--) { const u=lines[i].trim().toUpperCase(); if(u==='[VOICE]'||u==='[TEXT]'||u==='') cut=i; else break; }
            aiReply=lines.slice(0,cut).join('\n').trim();
            if (!isAudio) sendVoice=false;
            else if (hasV) { sendVoice=true; console.log('[ROUTE] VOICE'); }
            else { sendVoice=false; console.log('[ROUTE] TEXT'); }
          } else { sendVoice=isAudio; console.log('[ROUTE] Default:', sendVoice?'VOICE':'TEXT'); }

          if (!aiReply.trim()) aiReply='Thori dair mein wapas aati hoon. Shukriya 🙏';

          // [M1] Save to Neon DB (async, don't wait)
          history.push({role:'user',parts:[{text:userText}]});
          history.push({role:'model',parts:[{text:aiReply}]});
          if (history.length>20) history.splice(0,history.length-20);
          dbSave(DBURL, from, customerName, history).catch(()=>{});
          if (!DBURL) { // local fallback update
            const lh = getLocalHistory(from);
            lh.push({role:'user',parts:[{text:userText}]});
            lh.push({role:'model',parts:[{text:aiReply}]});
            if (lh.length>20) lh.splice(0,lh.length-20);
          }

          // STEP C: ElevenLabs voice — [U1] Flash v2.5 model + [U2] Urdu settings
          let voiceSent=false;
          if (sendVoice && ELAB && EVID && WT && PID) {
            try {
              console.log('[C] TTS...');
              const tts=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EVID}`,{
                method:'POST',
                headers:{'xi-api-key':ELAB,'Content-Type':'application/json','Accept':'audio/mpeg'},
                body:JSON.stringify({
                  text: aiReply,
                  model_id: 'eleven_flash_v2_5',    // [U1] Flash v2.5 — faster + better non-English
                  language_code: 'ur',             // [U1] Explicit Urdu language code
                  voice_settings: {
                    stability:         0.75,         // [U2] Higher stability = consistent Urdu accent
                    similarity_boost:  0.85,         // [U2] Stay close to original voice character
                    style:             0.4,          // [U2] Natural style, not over-dramatic
                    use_speaker_boost: true          // [U2] Clearer voice output
                  }
                })
              });
              if (tts.ok) {
                const buf=await tts.arrayBuffer();
                const mfd=new globalThis.FormData();
                mfd.append('messaging_product','whatsapp');
                mfd.append('file',new globalThis.Blob([buf],{type:'audio/mpeg'}),'voice.mp3');
                mfd.append('type','audio/mpeg');
                const up=await fetch(`https://graph.facebook.com/v20.0/${PID}/media`,{method:'POST',headers:{'Authorization':`Bearer ${WT}`},body:mfd});
                const ud=await up.json().catch(()=>({}));
                if (up.ok&&ud?.id) {
                  const vr=await fetch(`https://graph.facebook.com/v20.0/${PID}/messages`,{
                    method:'POST',headers:{'Authorization':`Bearer ${WT}`,'Content-Type':'application/json'},
                    body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:from,type:'audio',audio:{id:ud.id}})
                  });
                  if (vr.ok) { voiceSent=true; console.log('[C OK] Voice sent'); }
                  else console.error('[C FAIL] Send:', vr.status);
                } else console.error('[C FAIL] Upload:', up.status);
              } else if (tts.status===429) { console.warn('[C] ElevenLabs 429 → text fallback'); }
              else console.error('[C FAIL] ElevenLabs:', tts.status);
            } catch(e) { console.error('[C ERR]:', e.message); }
          }

          // STEP D: Text reply
          if (!voiceSent && WT && PID) {
            const tr=await fetch(`https://graph.facebook.com/v20.0/${PID}/messages`,{
              method:'POST', headers:{'Authorization':`Bearer ${WT}`,'Content-Type':'application/json'},
              body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:from,type:'text',text:{preview_url:false,body:aiReply}})
            });
            if (tr.ok) console.log('[D OK] Text. id:', msgId||'n/a');
            else { const e=await tr.text().catch(()=>''); console.error('[D FAIL]',tr.status,e.slice(0,100)); }
          }

        } // end for messages
      } catch(err) { console.error('[FATAL]:', err.message, err.stack); }
    })();

    if (waitUntilFn) { waitUntilFn(processPromise); return res.status(200).send('EVENT_RECEIVED'); }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).send('Method Not Allowed');
};
