// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  BASE: commit 8a9f7aa (voice working) + proven fixes only
//
//  FIXES APPLIED ON TOP OF WORKING BASE:
//  [F1] Deduplication by message.id — stops Meta retry duplicate messages
//  [F2] Send 200 to Meta immediately — prevents retry storm
//  [F3] Gemini 429 circuit breaker — skips rate-limited model for 5 min
//  [F4] Gemini timeout raised 15s → 20s + abort retry once
//  [F5] Groq LLM fallback (correct 2026 models, no llama-3.3-70b-versatile)
//  [F6] Cerebras llama-3.3-70b fallback (optional, free, 2100 tok/s)
//  [F7] OpenRouter mistral:free fallback (optional)
//  [F8] Midnight PKT reset — clears circuit breakers when daily quota refills
//  [F9] City name correction — Faizabad→Faisalabad (Whisper STT error fix)
//  [F10] Whisper prompt improved — explicit Faisalabad mention
//  [F11] ElevenLabs Flash v2.5 + language_code:ur — better Urdu voice quality
//  [F12] PKT time injected into system prompt — correct time-based greetings
//  [F13] Google Sheets order save via [ORDER:...] tag (optional)
//  [F14] Neon DB persistent memory (optional, fallback to in-memory)
//  [F15] fromNumber validation — skip if missing
//  [F16] mediaData.url missing → proper fallback with log (was silent before)
//  [F17] ElevenLabs 429 → clean text fallback (was crashing before)
//
//  VOICE LOGIC (same as working base — NOT changed):
//  Customer sends voice → Groq STT → Gemini → ElevenLabs → WhatsApp voice note
//  ElevenLabs fails/429 → text fallback
//  Customer sends text → Gemini → text reply (no voice)
//
//  REQUIRED ENV VARS:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//
//  OPTIONAL ENV VARS (adds more features):
//  ELEVENLABS_VOICE_ID  — default: 21m00Tcm4TlvDq8ikWAM (Rachel free)
//  CEREBRAS_API_KEY     — extra AI fallback (free)
//  OPENROUTER_API_KEY   — extra AI fallback (free)
//  DATABASE_URL         — Neon PostgreSQL for persistent memory
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY — order saving
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Vercel waitUntil (send 200 fast, process async) [F2] ─────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── [F3] Circuit breaker — per model, in-memory ───────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = k      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

// [F8] Midnight PKT reset — daily quota refills at midnight
function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) { global._cb.clear(); console.log('[CB] Midnight reset — quota refilled'); }
  } catch (_) {}
}

// [F1] Deduplication store
if (!global._dedup) global._dedup = new Map();
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  // Cleanup old entries
  if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v <= now) global._dedup.delete(k);
  if ((global._dedup.get(msgId)||0) > now) return true;
  global._dedup.set(msgId, now + 10*60*1000); // 10 min TTL
  return false;
}

// ── [F14] Neon DB — optional persistent memory ────────────────────────────────
let _sql = null;
function getSql(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  if (!_sql) { try { const {neon}=require('@neondatabase/serverless'); _sql=neon(dbUrl); } catch(e) { return null; } }
  return _sql;
}
const _dbCache = new Map();
async function dbGet(dbUrl, phone) {
  if (_dbCache.has(phone)) return _dbCache.get(phone);
  const sql = getSql(dbUrl); if (!sql) return null;
  try {
    const rows = await sql`SELECT history, customer_name FROM zara_conversations WHERE phone_number=${phone} LIMIT 1`;
    if (rows?.length) { const d={history:rows[0].history||[],customerName:rows[0].customer_name||''}; _dbCache.set(phone,d); return d; }
  } catch(e) { console.error('[DB GET]',e.message); }
  return null;
}
async function dbSave(dbUrl, phone, customerName, history) {
  _dbCache.set(phone, {history,customerName});
  const sql = getSql(dbUrl); if (!sql) return;
  try {
    await sql`INSERT INTO zara_conversations(phone_number,customer_name,history,last_seen,msg_count) VALUES(${phone},${customerName||''},${JSON.stringify(history.slice(-20))}::jsonb,NOW()::timestamptz,${history.length}) ON CONFLICT(phone_number) DO UPDATE SET customer_name=EXCLUDED.customer_name,history=EXCLUDED.history,last_seen=NOW()::timestamptz,msg_count=EXCLUDED.msg_count`;
  } catch(e) { console.error('[DB SAVE]',e.message); }
}

// ── [F9] City name correction (Whisper STT common errors) ─────────────────────
const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()] || w) : t;

// ── [F13] Google Sheets (optional) ────────────────────────────────────────────
let _gToken = { token:null, exp:0 };
async function getGToken(email, key) {
  if (_gToken.token && Date.now() < _gToken.exp-300000) return _gToken.token;
  try {
    const now=Math.floor(Date.now()/1000), b64=s=>Buffer.from(s).toString('base64url');
    const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const p=b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    const s=crypto.createSign('RSA-SHA256'); s.update(`${h}.${p}`);
    const sig=s.sign(key.replace(/\\n/g,'\n'),'base64url');
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}`});
    const d=await r.json();
    if (d.access_token) { _gToken={token:d.access_token,exp:Date.now()+(d.expires_in||3600)*1000}; return _gToken.token; }
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
    const row=[new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),order.name||'',phone||'',order.product||'',order.qty||'',order.price||'',order.payment||'',order.address||'',order.city||'','Pending'];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Sheet1!A:J:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
    console.log('[SHEET] Order saved ✓');
  } catch(e) { console.error('[SHEET]',e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPKT() {
  try {
    const p={};
    for(const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT unavailable'; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function oaiChat({url,key,model,messages,maxTokens=800,timeout=20000}) {
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),timeout);
  try { return await fetch(`${url}/chat/completions`,{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.7,max_tokens:maxTokens})}); }
  finally { clearTimeout(t); }
}

// ── In-memory history (base architecture — kept exactly) ──────────────────────
const chatHistories = new Map();

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset(); // [F8]

  // ── Env vars ──────────────────────────────────────────────────────────────
  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      || '').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     || '').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        || '').trim();
  const GEMINI_API_KEY      = (process.env.GEMINI_API_KEY      || '').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        || '').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  || '').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     || '').trim();
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    || '').trim();
  const CEREBRAS_API_KEY    = (process.env.CEREBRAS_API_KEY    || '').trim();
  const OPENROUTER_API_KEY  = (process.env.OPENROUTER_API_KEY  || '').trim();
  const DATABASE_URL        = (process.env.DATABASE_URL        || '').trim();
  const GOOGLE_SHEETS_ID    = (process.env.GOOGLE_SHEETS_ID    || '').trim();
  const GOOGLE_SA_EMAIL     = (process.env.GOOGLE_SA_EMAIL     || '').trim();
  const GOOGLE_SA_KEY       = (process.env.GOOGLE_SA_KEY       || '').trim();

  // ── [F12] System Prompt with PKT time ────────────────────────────────────
  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding team member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

CURRENT TIME (Asia/Karachi): ${getPKT()}

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a helpful colleague, not a call-center script
- Use customer's name in EVERY message
- Max 2-3 emojis per message
- Every message must feel personal, never copy-pasted
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== LANGUAGE — AUTO DETECT ===
- Urdu script in   → Urdu script out
- English in       → English out
- Roman Urdu in    → Roman Urdu out
- Never switch language unless customer switches first
- Use pure Pakistani Urdu tone — not Hindi, not English accent

=== TIME-BASED GREETING (use CURRENT TIME above) ===
06:00 – 12:00 → صبح بخیر! 🌅
12:00 – 17:00 → خیریت سے ہیں؟ ☀️
17:00 – 21:00 → شام بخیر! ✨
21:00 – 06:00 → السلام علیکم! (brief reply, full answer next morning)
Use greeting only on FIRST message of conversation, not every reply.

=== CITY NAMES — IMPORTANT ===
⚠️ Faisalabad (NOT Faizabad, NOT Faizaabad) — always spell correctly
درست نام: Faisalabad • Lahore • Karachi • Islamabad • Rawalpindi • Multan • Gujranwala

=== CAPABILITIES ===
You handle text messages AND voice notes (transcribed to text). Reply naturally to both.

=== SEASON & FESTIVAL AWARENESS ===
WINTER (Nov–Feb) → Promote first: Marina, Velvet, Dhanak, Karandi
SUMMER (Apr–Sep) → Promote first: Lawn, Linen/Khaddar, Printed Suits
EID UL FITR (Ramadan last 10 days) → Promote: Embroidered, Fancy, Kotail
EID UL ADHA (Zul Hijja 1–10) → Promote: Embroidered, Velvet, Kotail
WEDDING SEASON (Oct–Dec, Mar–Apr) → Promote: Embroidered, Velvet, Fancy

=== PRODUCTS — ALL UNSTITCHED ===
1. Lawn/Printed    — summer, light, breathable
2. Embroidered     — weddings, celebrations, fancy
3. Linen/Khaddar   — classic, mid-season comfort
4. Kotail          — premium, formal occasions
5. Karandi         — soft, popular mid-season
6. Marina          — warm, cozy, winter
7. Velvet          — rich, luxurious, winter
8. Dhanak          — soft, warm, winter
Always describe fabric feel + season + occasion FIRST. Price only when customer asks.

=== UPSELL LOGIC ===
After answering any product question, ALWAYS add one natural suggestion:
Lawn pooche → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina pooche → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں — بہت خوبصورت ہے"
Retail order → mention wholesale if reseller: "کیا آپ دکان کے لیے لے رہی ہیں؟ wholesale میں اچھی rate مل سکتی ہے"
Upsell must feel NATURAL, never pushy. One suggestion per message, never more.

=== PRICING ===
RETAIL (single customer):
• 1 suit = PKR 3,600
• Delivery charges extra
• No minimum order

WHOLESALE (shop owners):
• Minimum 10 suits
• PKR 2,999 per suit
• 10 suits = PKR 29,990
• City delivery = FREE
• Outside city = extra charges

=== HAGGLING — SPECIFIC RESPONSES ===
Response 1 (first time): "آپی، یہ قیمت پہلے سے بہت مناسب ہے — ہمارا کپڑا دیکھ کر خود اندازہ ہو جائے گا۔ اتنی quality اس price میں کہیں نہیں ملتی 🎨"
Response 2 (second time): "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے 😊"
Response 3 (third time): "آپی، discount تو boss کا اختیار ہے — میں ابھی ان سے پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT METHODS ===
1. JazzCash  → ${JAZZCASH_NUMBER  || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD       → payment on delivery
• COD: confirm full address + phone number
• JazzCash/EasyPaisa: share number, ask for screenshot
• Screenshot received → alert boss IMMEDIATELY
• Never confirm order until payment verified or COD set

=== DELIVERY ===
• City (شہر): 1-2 working days
• Outside city: 3-5 working days
• Wholesale city delivery: FREE
• After order: ask full address → save in Notes

=== RETURN / EXCHANGE POLICY ===
• NO returns — all sales final
• Exchange ONLY: genuine defect or wrong item sent
• Must request within 24 hours of delivery with photo proof
• Boss makes final decision

=== BUSINESS HOURS ===
• Monday to Sunday: OPEN ✅
• ONLY closed: Friday 11AM–3PM (Juma)
• After 10PM: reply briefly, full answer next morning

=== ORDER PROCESS ===
1. Alert boss: name + product + retail/wholesale
2. Send confirmation: Product name, Price breakdown, Payment options
3. Ask delivery address
4. Confirm payment method

If order confirmed, include this tag on its own line:
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]

=== BOSS ALERT — CALL IMMEDIATELY ===
🚨 Customer angry, rude, or complaining
🛍️ Any wholesale inquiry (10+ suits)
💰 Retail order PKR 10,000 or more
✅ Customer sends payment screenshot
🔄 Customer requests exchange
🏷️ Customer asks for discount 3rd time
❓ Any unusual or confusing situation

=== SITUATION DETECTION ===
SITUATION 1 — New Customer: Warm welcome, introduce Fatima Arts, offer help.
SITUATION 2 — Existing Customer: Personal reply using name + last product, upsell.
SITUATION 3 — Order Placed: Confirm product + price + payment options, ask address.
SITUATION 4 — Payment Done: Thank warmly, give delivery timeline.
SITUATION 5 — Complaint: Sincere apology first, alert boss, ask for photo proof.
SITUATION 6 — Haggling: Use 3-step sequence. Never give discount yourself.
SITUATION 7 — Wholesale: Alert boss immediately.
SITUATION 10 — Voice Note: Treat transcribed text as normal message, reply naturally.

=== TRUST BUILDING ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
Color fading: "آپی! رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"

=== COD RISK MANAGEMENT ===
Take full address (house number, street, area, city), nearby landmark, alternate phone.
If COD not confirmed: hold order + alert boss.

=== MESSAGE LENGTH ===
Maximum 5-6 lines per message. Split into 2 if more info needed.

=== MALE CUSTOMER ===
Never use "آپی". Use "بھائی جان" or "جناب" or "آپ".

=== MEMORY ===
You remember the full conversation history. Use context. Never repeat answered questions.

=== NEVER DO ===
❌ Say you are AI, bot, or automated
❌ Use any name other than Zara
❌ Give discount without boss approval
❌ Mention competitors
❌ Confirm order without payment/COD
❌ Message after 10PM PKT (outbound)
❌ Message during Friday Juma 11AM-3PM`;

  // ─── GET: Webhook Verification ───────────────────────────────────────────
  if (req.method === 'GET') {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host     = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url      = new URL(req.url, `${protocol}://${host}`);
    const mode     = url.searchParams.get('hub.mode');
    const token    = url.searchParams.get('hub.verify_token');
    const challenge= url.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log('[VERIFICATION SUCCESS] Webhook verified');
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  // ─── POST: Message Handler ────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

    const entry   = body?.entry?.[0];
    const value   = entry?.changes?.[0]?.value;
    const messages= Array.isArray(value?.messages) ? value.messages : [];
    const contacts= Array.isArray(value?.contacts) ? value.contacts : [];

    // [F2] Send 200 to Meta IMMEDIATELY — prevents retry storm
    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        // Handle first message only (Meta usually sends one at a time)
        const message = messages[0];
        if (!message) return;

        const msgId = message?.id;

        // [F1] Deduplication — skip if already processed
        if (alreadyProcessed(msgId)) {
          console.log('[DEDUP] Already processed:', msgId);
          return;
        }

        // [F15] Validate fromNumber
        const fromNumber = message.from;
        if (!fromNumber) { console.error('[ERROR] message.from missing'); return; }

        const isAudioIncoming = message.type === 'audio' || message.type === 'voice';
        const contact         = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
        const customerName    = (contact?.profile?.name || '').trim();

        let userMessageText = '';

        // ── STEP A: Text Extract or Groq Whisper Transcription ────────────
        if (message.type === 'text') {
          userMessageText = fixCities(message.text?.body || ''); // [F9]

        } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
          console.log('[STEP A] Fetching audio from Meta...');
          const mediaId = message.audio?.id || message.voice?.id;

          if (!mediaId) {
            userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
          } else {
            const mediaRes  = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });
            if (!mediaRes.ok) {
              console.error('[STEP A FAIL] Media fetch:', mediaRes.status);
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              const mediaData = await mediaRes.json();
              if (!mediaData.url) {
                // [F16] was silent before — now logged
                console.error('[STEP A FAIL] mediaData.url missing:', JSON.stringify(mediaData));
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const audioStream = await fetch(mediaData.url, {
                  headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                const arrayBuffer = await audioStream.arrayBuffer();

                const formData = new globalThis.FormData();
                const blob     = new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' });
                formData.append('file',     blob, 'voice.ogg');
                formData.append('model',    'whisper-large-v3-turbo');
                formData.append('language', 'ur');
                // [F10] Explicit Faisalabad mention — fixes Whisper "Faizabad" error
                formData.append('prompt',   'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');

                const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                  method:  'POST',
                  headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
                  body:    formData
                });

                if (groqRes.ok) {
                  const groqData  = await groqRes.json();
                  userMessageText = fixCities((groqData.text || '').trim()); // [F9]
                  console.log('[STEP A SUCCESS] Transcribed:', userMessageText.slice(0, 80));
                } else {
                  console.error('[STEP A FAIL] Groq status:', groqRes.status);
                  userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                }
              }
            }
          }

        } else if (message.type === 'image')    { userMessageText = '[Customer ne ek image bheji hai — poochein kya dekhna chahte hain]'; }
          else if (message.type === 'sticker')  { userMessageText = '[Customer ne sticker bheja — friendly acknowledgment do]'; }
          else if (message.type === 'document') { userMessageText = '[Customer ne document bheja — poochein kya chahiye]'; }
          else                                  { userMessageText = '[Customer ne kuch bheja — poochein kya chahiye]'; }

        if (!userMessageText.trim()) userMessageText = 'السلام علیکم';

        // ── Load conversation history ─────────────────────────────────────
        let history = [];
        // Try Neon DB first [F14], fallback to in-memory
        const dbData = await dbGet(DATABASE_URL, fromNumber);
        if (dbData) {
          history = dbData.history || [];
        } else {
          if (!chatHistories.has(fromNumber)) chatHistories.set(fromNumber, []);
          history = chatHistories.get(fromNumber);
        }
        const MAX_HISTORY = 20;

        const geminiContents = [
          ...history,
          { role: 'user', parts: [{ text: (customerName ? `Customer name: ${customerName}\n` : '') + userMessageText }] }
        ];
        const oaiMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.map(c => ({ role: c.role==='model'?'assistant':'user', content: c.parts?.[0]?.text||'' })),
          { role: 'user', content: (customerName ? `Customer name: ${customerName}\n` : '') + userMessageText }
        ];

        let aiReply = '';

        // ══════════════════════════════════════════════════════════════════
        // STEP B: AI CHAIN — same logic as base + 429 handling + fallbacks
        // ══════════════════════════════════════════════════════════════════

        // Tier 1+2: Gemini (primary — best Urdu quality)
        if (!aiReply && GEMINI_API_KEY) {
          const models = ['gemini-3.7-flash', 'gemini-3.6-flash'];
          for (const model of models) {
            if (aiReply) break;
            const cbKey = `g:${model}`;
            if (isBlocked(cbKey)) { console.warn('[SKIP]', cbKey); continue; }

            for (let attempt = 1; attempt <= 2; attempt++) {
              if (aiReply) break;
              const controller = new AbortController();
              // [F4] Timeout raised to 20s
              const timeoutId  = setTimeout(() => controller.abort(), 20000);
              try {
                console.log(`[STEP B] Querying ${model} (attempt ${attempt})...`);
                const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                  { method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal,
                    body:JSON.stringify({system_instruction:{parts:[{text:SYSTEM_PROMPT}]},contents:geminiContents,generationConfig:{temperature:0.7,maxOutputTokens:800}}) }
                );
                if (r.ok) {
                  const d   = await r.json();
                  const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                  if (raw) aiReply = raw.replace(/[*_~`#]/g,'').trim();
                  console.log(`[STEP B SUCCESS] ${model} (attempt ${attempt})`);
                  break;
                }
                // [F3] 429 circuit breaker
                if (r.status === 429) { blockFor(cbKey, 5*60*1000); break; }
                if (r.status === 503 && attempt < 2) {
                  console.warn(`[STEP B 503] ${model} overloaded, retry in 2s...`);
                  await sleep(2000); continue;
                }
                const et = await r.text().catch(()=>'');
                console.error(`[STEP B FAIL] ${model} ${r.status}:`, et.slice(0,150));
                break;
              } catch(e) {
                // [F4] Abort retry once
                const isAbort = e?.name==='AbortError' || String(e?.message||'').includes('abort');
                if (isAbort && attempt < 2) { console.warn(`[STEP B TIMEOUT] ${model} retry...`); await sleep(2000); continue; }
                console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
                break;
              } finally { clearTimeout(timeoutId); }
            }
          }
        }

        // Tier 3: Cerebras llama-3.3-70b [F6] — optional, 2100 tok/s, free
        if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cerebras')) {
          try {
            console.log('[STEP B] Trying Cerebras...');
            const r = await oaiChat({url:'https://api.cerebras.ai/v1',key:CEREBRAS_API_KEY,model:'llama-3.3-70b',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log('[STEP B SUCCESS] Cerebras'); }
            else if (r.status===429) blockFor('cerebras',5*60*1000);
            else console.error('[STEP B FAIL] Cerebras:', r.status);
          } catch(e) { console.error('[STEP B EXC] Cerebras:', e.message); }
        }

        // Tier 4: Groq LLM [F5] — correct 2026 model names
        if (!aiReply && GROQ_API_KEY) {
          for (const gm of ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']) {
            if (aiReply) break;
            const cbKey = `gr:${gm}`; if (isBlocked(cbKey)) continue;
            try {
              console.log(`[STEP B] Trying Groq ${gm}...`);
              const r = await oaiChat({url:'https://api.groq.com/openai/v1',key:GROQ_API_KEY,model:gm,messages:oaiMessages});
              if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log(`[STEP B SUCCESS] Groq:${gm}`); break; }
              if (r.status===429) { blockFor(cbKey,5*60*1000); break; }
              console.error(`[STEP B FAIL] Groq:${gm}`, r.status); break;
            } catch(e) { console.error(`[STEP B EXC] Groq:${gm}:`, e.message); break; }
          }
        }

        // Tier 5: OpenRouter [F7] — optional free fallback
        if (!aiReply && OPENROUTER_API_KEY && !isBlocked('or:mistral')) {
          try {
            console.log('[STEP B] Trying OpenRouter...');
            const r = await oaiChat({url:'https://openrouter.ai/api/v1',key:OPENROUTER_API_KEY,model:'mistralai/mistral-7b-instruct:free',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); console.log('[STEP B SUCCESS] OpenRouter'); }
            else if (r.status===429) blockFor('or:mistral',5*60*1000);
            else console.error('[STEP B FAIL] OpenRouter:', r.status);
          } catch(e) { console.error('[STEP B EXC] OpenRouter:', e.message); }
        }

        // All models failed
        if (!aiReply) {
          aiReply = 'Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏';
          console.warn('[STEP B FALLBACK] All models failed.');
        }

        // [F13] Google Sheets — save order if [ORDER:...] tag found
        const orderTag = parseOrderTag(aiReply);
        if (orderTag) {
          aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();
          saveToSheet(GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, orderTag, fromNumber).catch(()=>{});
          console.log('[ORDER] Saved to sheet:', orderTag.product, orderTag.city);
        }

        // [F9] City fix on AI reply
        aiReply = fixCities(aiReply);
        if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

        // ── Save turn to history ──────────────────────────────────────────
        history.push({ role: 'user',  parts: [{ text: userMessageText }] });
        history.push({ role: 'model', parts: [{ text: aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

        // Update in-memory Map (always keep in sync)
        if (!chatHistories.has(fromNumber)) chatHistories.set(fromNumber, []);
        chatHistories.set(fromNumber, history);

        // Save to Neon DB async [F14]
        dbSave(DATABASE_URL, fromNumber, customerName, history).catch(()=>{});

        // ── STEP C: ElevenLabs TTS → WhatsApp Voice Note ─────────────────
        // SAME LOGIC AS BASE: if customer sent audio → try voice reply
        // [F11] Flash v2.5 + language_code:ur for better Urdu
        let voiceSentSuccess = false;

        if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] Converting to voice via ElevenLabs...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method:  'POST',
              headers: {
                'xi-api-key':   ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept':       'audio/mpeg'
              },
              body: JSON.stringify({
                text:           aiReply,
                model_id:       'eleven_flash_v2_5',  // [F11] faster + better Urdu than multilingual_v2
                language_code:  'ur',                 // [F11] explicit Urdu
                voice_settings: {
                  stability:         0.75,            // consistent Urdu accent
                  similarity_boost:  0.85,            // stay close to voice character
                  style:             0.4,             // natural, not over-dramatic
                  use_speaker_boost: true             // clearer output
                }
              })
            });

            if (ttsRes.ok) {
              const arrayBuffer   = await ttsRes.arrayBuffer();
              const mediaFormData = new globalThis.FormData();
              const audioBlob     = new globalThis.Blob([arrayBuffer], { type: 'audio/mpeg' });
              mediaFormData.append('messaging_product', 'whatsapp');
              mediaFormData.append('file', audioBlob, 'voice.mp3');
              mediaFormData.append('type', 'audio/mpeg');

              const uploadRes  = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                method:  'POST',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                body:    mediaFormData
              });
              const uploadData = await uploadRes.json();

              if (uploadData?.id) {
                const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                  method:  'POST',
                  headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    recipient_type:    'individual',
                    to:                fromNumber,
                    type:              'audio',
                    audio:             { id: uploadData.id }
                  })
                });
                if (sendVoiceRes.ok) {
                  voiceSentSuccess = true;
                  console.log('[STEP C SUCCESS] Voice note sent!');
                } else {
                  const errBody = await sendVoiceRes.text();
                  console.error('[STEP C FAIL] Voice send:', errBody.slice(0,150));
                }
              } else {
                console.error('[STEP C FAIL] Upload failed:', JSON.stringify(uploadData));
              }

            } else if (ttsRes.status === 429) {
              // [F17] 429 → clean text fallback (was crashing before)
              console.warn('[STEP C] ElevenLabs quota 429 — falling back to text');
            } else {
              console.error('[STEP C FAIL] ElevenLabs status:', ttsRes.status);
            }
          } catch (err) {
            console.error('[STEP C ERROR]:', err.message);
          }
        }

        // ── STEP D: Text Fallback (only if voice NOT sent) ────────────────
        if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type:    'individual',
              to:                fromNumber,
              type:              'text',
              text:              { preview_url: false, body: aiReply }
            })
          });
          if (textRes.ok) console.log('[STEP D SUCCESS] Text message sent.');
          else { const e=await textRes.text().catch(()=>''); console.error('[STEP D FAIL]:', textRes.status, e.slice(0,150)); }
        }

      } catch (err) {
        console.error('[FATAL ERROR]:', err.message, err.stack);
      }
    })();

    // [F2] Send 200 to Meta immediately, keep processing in background
    if (waitUntilFn) { waitUntilFn(processPromise); return res.status(200).send('EVENT_RECEIVED'); }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
