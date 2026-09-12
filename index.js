// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  BASE: commit 8a9f7aa (fully working voice + text)
//  UPGRADES added on top (no regressions):
//
//  [U1]  Dedup by message.id — stops Meta retry duplicate messages
//  [U2]  Send 200 to Meta immediately — prevents retry storm
//  [U3]  Circuit breaker per model — 429 → block 5 min
//  [U4]  Self-heal — if ALL models blocked → force clear
//  [U5]  Midnight PKT reset — clears circuit breakers at quota refill
//  [U6]  Gemini timeout 15s→20s + abort retry once
//  [U7]  Gemini 429 handling (was missing in base)
//  [U8]  Groq LLM fallback (correct 2026 models: openai/gpt-oss-120b)
//  [U9]  Cerebras llama-3.3-70b fallback (optional, free, fast)
//  [U10] OpenRouter mistral:free fallback (optional)
//  [U11] City name correction — Faizabad→Faisalabad (Whisper STT fix)
//  [U12] Whisper prompt improved — explicit Faisalabad mention
//  [U13] ElevenLabs Flash v2.5 + language_code:ur (better Urdu voice)
//  [U14] PKT time injected into system prompt (correct time greetings)
//  [U15] maxOutputTokens 800→1200 (Urdu needs more tokens)
//  [U16] fromNumber validation — skip if missing
//  [U17] audioStream.ok check — crash fix
//  [U18] ElevenLabs 429 → clean text fallback (no crash)
//  [U19] Neon DB persistent memory (optional, fallback to in-memory)
//  [U20] Google Sheets order save via [ORDER:...] tag (hardened)
//  [U21] System prompt multilingual — English instructions, default Urdu script
//  [U22] Fallback messages in Urdu script (not Roman Urdu)
//  [U23] Order persistence validation + Sheets status/retry + duplicate fingerprinting
//
//  VOICE LOGIC (same as working base — NOT changed):
//  customer voice → Groq STT → Gemini → ElevenLabs → WhatsApp voice note
//  ElevenLabs fails → text fallback
//  customer text → Gemini → text reply
//
//  REQUIRED ENV:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//
//  OPTIONAL ENV (adds features):
//  ELEVENLABS_VOICE_ID   — default: 21m00Tcm4TlvDq8ikWAM (Rachel, free)
//  CEREBRAS_API_KEY      — extra AI fallback (free)
//  OPENROUTER_API_KEY    — extra AI fallback (free)
//  DATABASE_URL           — Neon PostgreSQL (persistent memory across cold starts)
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY — order logging
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

if (!global._cb) global._cb = new Map();
const isBlocked = k => Date.now() < (global._cb.get(k) || 0);
const blockFor = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

function selfHeal() {
  const keys = ['g:gemini-3.7-flash','g:gemini-3.6-flash','cerebras','gr:openai/gpt-oss-120b','gr:qwen/qwen3.6-27b','or:mistral'];
  if (keys.length > 0 && keys.every(k => isBlocked(k))) {
    keys.forEach(k => global._cb.delete(k));
    console.warn('[SELF-HEAL] All providers blocked → force cleared');
  }
}

function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Karachi', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date());
    const [h, m] = pkt.split(':').map(Number);
    if (h === 0 && m <= 5 && global._cb.size > 0) {
      global._cb.clear();
      console.log('[MIDNIGHT] Circuit breakers reset');
    }
  } catch (_) {}
}

if (!global._dedup) global._dedup = new Map();
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v <= now) global._dedup.delete(k);
  if ((global._dedup.get(msgId) || 0) > now) return true;
  global._dedup.set(msgId, now + 10 * 60 * 1000);
  return false;
}

function getPKT() {
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Karachi', weekday:'long', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date())) p[x.type] = x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch (e) { return 'PKT unavailable'; }
}

const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()] || w) : t;

let _neonSql = null;
function getNeon(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  if (!_neonSql) { try { const {neon} = require('@neondatabase/serverless'); _neonSql = neon(dbUrl); } catch(e) { return null; } }
  return _neonSql;
}
const _dbCache = new Map();
async function dbGet(dbUrl, phone) {
  if (_dbCache.has(phone)) return _dbCache.get(phone);
  const sql = getNeon(dbUrl); if (!sql) return null;
  try {
    const rows = await sql`SELECT history, customer_name FROM zara_conversations WHERE phone_number = ${phone} LIMIT 1`;
    if (rows?.length) {
      const d = { history: rows[0].history || [], customerName: rows[0].customer_name || '' };
      if (_dbCache.size >= 200) _dbCache.delete(_dbCache.keys().next().value);
      _dbCache.set(phone, d);
      return d;
    }
  } catch(e) { console.error('[DB GET]', e.message); }
  return null;
}
async function dbSave(dbUrl, phone, customerName, history) {
  if (_dbCache.size >= 200) _dbCache.delete(_dbCache.keys().next().value);
  _dbCache.set(phone, { history, customerName });
  const sql = getNeon(dbUrl); if (!sql) return;
  try {
    await sql`
      INSERT INTO zara_conversations (phone_number, customer_name, history, last_seen, msg_count)
      VALUES (${phone}, ${customerName || ''}, ${JSON.stringify(history.slice(-20))}::jsonb, NOW(), ${history.length})
      ON CONFLICT (phone_number) DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        history       = EXCLUDED.history,
        last_seen     = NOW(),
        msg_count     = EXCLUDED.msg_count
    `;
  } catch(e) { console.error('[DB SAVE]', e.message); }
}

const chatHistories = new Map();

let _gTok = { token: null, exp: 0 };
async function getGToken(email, key) {
  if (_gTok.token && Date.now() < _gTok.exp - 300000) return _gTok.token;
  try {
    const now = Math.floor(Date.now()/1000);
    const b64 = s => Buffer.from(s).toString('base64url');
    const h = b64(JSON.stringify({ alg:'RS256', typ:'JWT' }));
    const p = b64(JSON.stringify({ iss:email, scope:'https://www.googleapis.com/auth/spreadsheets', aud:'https://oauth2.googleapis.com/token', exp:now+3600, iat:now }));
    const s = crypto.createSign('RSA-SHA256'); s.update(`${h}.${p}`);
    const sig = s.sign(key.replace(/\\n/g, '\n'), 'base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}` });
    const d = await r.json();
    if (d.access_token) { _gTok = { token: d.access_token, exp: Date.now() + (d.expires_in||3600)*1000 }; return _gTok.token; }
  } catch(e) { console.error('[GTOKEN]', e.message); }
  return null;
}
function parseOrderTag(text) {
  const m = String(text || '').match(/\[ORDER:([^\]]+)\]/i); if (!m) return null;
  const o = {};
  for (const p of m[1].split('|')) {
    const [k,...v] = p.split('=');
    if (k && v.length) o[k.trim().toLowerCase()] = v.join('=').trim();
  }
  return Object.keys(o).length ? o : null;
}

function normalizeOrder(order, phone) {
  if (!order || !phone) return null;
  const out = {
    name: String(order.name || '').trim(),
    product: String(order.product || '').trim(),
    qty: String(order.qty || '').trim(),
    price: String(order.price || '').replace(/[^\d.]/g, '').trim(),
    payment: String(order.payment || '').trim(),
    address: fixCities(String(order.address || '').trim()),
    city: fixCities(String(order.city || '').trim()),
  };
  if (!out.name || !out.product || !out.qty || !out.price || !out.payment || !out.address || !out.city) return null;
  if (!/^\d+(?:\.\d+)?$/.test(out.qty) || Number(out.qty) < 1 || Number(out.qty) > 100) return null;
  if (!/^\d+(?:\.\d+)?$/.test(out.price) || Number(out.price) <= 0 || Number(out.price) > 1000000) return null;
  if (!/^(?:cod|cash on delivery|jazzcash|easypaisa)$/i.test(out.payment)) return null;
  if (out.address.length < 8 || out.address.length > 500 || out.city.length < 2 || out.city.length > 80) return null;
  return out;
}

function orderFingerprint(order, phone) {
  return crypto.createHash('sha256')
    .update([phone, order.name, order.product, order.qty, order.price, order.payment.toLowerCase(), order.address.toLowerCase(), order.city.toLowerCase()].join('|'))
    .digest('hex')
    .slice(0, 20);
}

if (!global._savedOrderFingerprints) global._savedOrderFingerprints = new Map();

async function saveToSheet(sid, email, key, order, phone) {
  const normalized = normalizeOrder(order, phone);
  if (!sid || !email || !key) {
    console.warn('[ORDER SAVE] Not configured; order not persisted.');
    return { ok:false, reason:'not_configured' };
  }
  if (!normalized) {
    console.error('[ORDER SAVE] Validation failed; refusing incomplete/invalid order.');
    return { ok:false, reason:'validation' };
  }

  const fingerprint = orderFingerprint(normalized, phone);
  const now = Date.now();
  for (const [fp, expiresAt] of global._savedOrderFingerprints) {
    if (expiresAt <= now) global._savedOrderFingerprints.delete(fp);
  }
  if (global._savedOrderFingerprints.has(fingerprint)) {
    console.log('[ORDER SAVE] Duplicate suppressed:', fingerprint);
    return { ok:true, duplicate:true };
  }

  try {
    const tok = await getGToken(email, key);
    if (!tok) throw new Error('Google access token unavailable');

    // RAW prevents customer-controlled strings from being interpreted as Sheets formulas.
    const row = [
      new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),
      normalized.name,
      phone,
      normalized.product,
      normalized.qty,
      normalized.price,
      normalized.payment,
      normalized.address,
      normalized.city,
      'Pending'
    ];

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Sheet1!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const retryable = new Set([408,429,500,502,503,504]);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(url, {
        method:'POST',
        headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},
        body:JSON.stringify({values:[row]})
      });

      if (r.ok) {
        global._savedOrderFingerprints.set(fingerprint, Date.now() + 30 * 60 * 1000);
        console.log('[ORDER SAVE] Success:', fingerprint);
        return { ok:true, duplicate:false, fingerprint };
      }

      const body = await r.text().catch(() => '');
      console.error(`[ORDER SAVE] Google Sheets ${r.status} attempt ${attempt}:`, body.slice(0,200));
      if (!retryable.has(r.status) || attempt === 3) {
        return { ok:false, reason:`sheets_${r.status}` };
      }
      await sleep(1000 * attempt);
    }
  } catch (e) {
    console.error('[ORDER SAVE] Exception:', e?.message || e);
    return { ok:false, reason:'exception' };
  }
  return { ok:false, reason:'unknown' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function oaiChat({ url, key, model, messages, maxTokens=1200, timeout=20000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(`${url}/chat/completions`, { method:'POST', signal:ctrl.signal, headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'}, body:JSON.stringify({model, messages, temperature:0.7, max_tokens:maxTokens}) }); }
  finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();
  selfHeal();

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

  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding sales agent of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or software.

CURRENT TIME (Asia/Karachi): ${getPKT()}

=== CRITICAL: LANGUAGE MATCHING ===
You are MULTILINGUAL. Detect customer's language and always reply in the SAME language and script.

Rules:
- Customer writes Urdu script (e.g. "مجھے کپڑا چاہیے") → reply in Urdu script: "جی آپی، ضرور! 😊"
- Customer writes Roman Urdu (e.g. "mujhe kapra chahiye") → reply in Roman Urdu: "Ji aapi, zaroor! 😊"
- Customer writes English (e.g. "I want fabric") → reply in English: "Of course! 😊"
- Customer sends voice note → match language of transcribed text

DEFAULT when unsure: Urdu script (اردو حروف) — NOT Roman Urdu
NEVER mix languages. NEVER switch unless customer switches first.
Tone: warm Pakistani — pure Urdu accent, not Hindi, not English accent.

=== CITY NAMES (always correct) ===
Faisalabad — NEVER write Faizabad or Faizaabad
Others: Lahore • Karachi • Islamabad • Rawalpindi • Multan • Gujranwala

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a caring colleague, not a call-center script
- Use customer's name in EVERY message (if known). If unknown, ask once.
- Max 2-3 emojis per message. Every message must feel personal.
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== TIME-BASED GREETING (use CURRENT TIME above) ===
06:00–12:00 → صبح بخیر! 🌅
12:00–17:00 → خیریت سے ہیں؟ ☀️
17:00–21:00 → شام بخیر! ✨
21:00–06:00 → السلام علیکم! (brief, full answer next morning)
Use greeting on FIRST message only.

=== CAPABILITIES ===
You handle text messages AND voice notes (transcribed to text). Reply naturally to both.

=== SEASON & FESTIVAL AWARENESS ===
WINTER (Nov–Feb) → Marina, Velvet, Dhanak, Karandi first
SUMMER (Apr–Sep) → Lawn, Linen/Khaddar, Printed Suits first
EID UL FITR (Ramadan last 10 days) → Embroidered, Fancy, Kotail
EID UL ADHA (Zul Hijja 1–10) → Embroidered, Velvet, Kotail
WEDDING SEASON (Oct–Dec, Mar–Apr) → Embroidered, Velvet, Fancy

=== PRODUCTS — ALL UNSTITCHED ===
1. Lawn/Printed    — summer, light, breathable
2. Embroidered     — weddings, celebrations, fancy
3. Linen/Khaddar   — classic, mid-season comfort
4. Kotail          — premium, formal occasions
5. Karandi         — soft, popular mid-season
6. Marina          — warm, cozy, winter
7. Velvet          — rich, luxurious, winter
8. Dhanak          — soft, warm, winter
Describe feel + season + occasion FIRST. Price only when asked.

=== UPSELL LOGIC ===
After any product question, add ONE natural suggestion:
Lawn → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں — بہت خوبصورت ہے"
Retail → mention wholesale if reseller likely: "کیا آپ دکان کے لیے لے رہی ہیں؟ wholesale میں اچھی rate مل سکتی ہے"
One suggestion only. Feel natural, never pushy.

=== PRICING ===
RETAIL: PKR 3,600/suit | delivery extra | no minimum
WHOLESALE (10+ suits): PKR 2,999/suit | 10 suits = 29,990 | city delivery FREE

=== HAGGLING ===
1st: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — اتنی quality اس price میں کہیں نہیں ملتی 🎨"
2nd: "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے 😊"
3rd: "آپی، discount تو boss کا اختیار ہے — میں ابھی ان سے پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT METHODS ===
1. JazzCash  → ${JAZZCASH_NUMBER || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD       → payment on delivery
• COD: full address + phone + alternate phone
• JazzCash/EasyPaisa: share number, ask screenshot
• Screenshot → alert boss IMMEDIATELY
• Never confirm order without payment/COD

=== DELIVERY ===
City: 1-2 working days | Outside city: 3-5 working days
Wholesale city: FREE | After order: ask full address

=== RETURN / EXCHANGE ===
No returns — all sales final
Exchange ONLY: genuine defect or wrong item | within 24hrs | photo proof | boss decides

=== BUSINESS HOURS ===
Mon–Sun: OPEN ✅ | Friday 11AM–3PM: CLOSED (Juma)
After 10PM: brief reply, full answer next morning

=== ORDER PROCESS ===
1. Alert boss: name + product + retail/wholesale
2. Confirm: product name + price + payment options
3. Ask full delivery address + city
4. Confirm payment method

When order fully confirmed (address + payment both received), you MUST write this tag on its own line:
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]
Write it ONCE only, and ONLY after every field above is actually confirmed by the customer. Never invent missing fields. Always spell city correctly.

=== BOSS ALERT — IMMEDIATELY ===
🚨 Angry/rude customer | 🛍️ Wholesale 10+ | 💰 PKR 10,000+
✅ Payment screenshot | 🔄 Exchange request | 🏷️ 3rd discount | ❓ Unusual situation

=== SITUATION DETECTION ===
1 New Customer: Warm welcome, introduce Fatima Arts.
2 Existing Customer: Name + last product context + upsell.
3 Order Placed: Confirm + price + payment + ask address.
4 Payment Done: Thank + delivery timeline.
5 Complaint: Apology first + boss alert + photo proof.
6 Haggling: 3-step sequence. Never give discount yourself.
7 Wholesale: Alert boss immediately.
10 Voice Note: Treat transcribed text as normal — reply naturally.

=== TRUST BUILDING ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں اور ہمارے پرانے گاہک ہی ہماری سب سے بڑی سفارش ہیں 🙏"
Color fading: "آپی! یہ premium quality fabric ہے — رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"

=== COD RISK MANAGEMENT ===
Get full address (house no, street, area, city) + landmark + alternate phone + confirm receiver available.
If COD not confirmed: hold order + alert boss.

=== MESSAGE LENGTH ===
Max 5-6 lines. Split into 2 if more info needed.

=== SMALL BULK ORDER (2–9 suits) ===
Still retail rate. Always mention: "آپی! اگر 10 suits لیں تو wholesale rate میں بہت فرق پڑتا ہے — 2,999 فی سوٹ اور city delivery مفت 😊"
If 5+ suits: alert boss.

=== MALE CUSTOMER ===
Never say "آپی". Use "بھائی جان" or "جناب" or "Sir".

=== MEMORY ===
Remember full conversation. Use context. Never repeat answered questions.

=== NEVER DO ===
❌ Say you are AI, bot, or automated
❌ Use any name other than Zara
❌ Give discount without boss approval
❌ Mention competitors
❌ Confirm order without payment/COD
❌ Message after 10PM PKT (outbound)
❌ Message during Friday Juma 11AM–3PM`;

  if (req.method === 'GET') {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url = new URL(req.url, `${protocol}://${host}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log('[VERIFICATION SUCCESS] Webhook verified');
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

    const entry = body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        const message = messages[0];
        if (!message) return;

        const msgId = message?.id;
        if (alreadyProcessed(msgId)) { console.log('[DEDUP] Skip:', msgId); return; }

        const fromNumber = message.from;
        if (!fromNumber) { console.error('[ERROR] message.from missing'); return; }

        const isAudioIncoming = message.type === 'audio' || message.type === 'voice';
        const contact = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
        const customerName = (contact?.profile?.name || '').trim();

        let userMessageText = '';

        if (message.type === 'text') {
          userMessageText = fixCities(message.text?.body || '');
        } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
          console.log('[STEP A] Fetching audio from Meta...');
          const mediaId = message.audio?.id || message.voice?.id;

          if (!mediaId) {
            userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
          } else {
            const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            if (!mediaRes.ok) {
              console.error('[STEP A FAIL] Media fetch:', mediaRes.status);
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              const mediaData = await mediaRes.json();
              if (!mediaData?.url) {
                console.error('[STEP A FAIL] No URL in mediaData');
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const audioStream = await fetch(mediaData.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                if (!audioStream.ok) {
                  console.error('[STEP A FAIL] Audio download:', audioStream.status);
                  userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                } else {
                  const arrayBuffer = await audioStream.arrayBuffer();
                  const formData = new globalThis.FormData();
                  const blob = new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' });
                  formData.append('file', blob, 'voice.ogg');
                  formData.append('model', 'whisper-large-v3-turbo');
                  formData.append('language', 'ur');
                  formData.append('prompt', 'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');

                  const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                    method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: formData
                  });

                  if (groqRes.ok) {
                    const groqData = await groqRes.json();
                    userMessageText = fixCities((groqData.text || '').trim());
                    console.log('[STEP A SUCCESS] Transcribed:', userMessageText.slice(0, 80));
                  } else {
                    console.error('[STEP A FAIL] Groq STT:', groqRes.status);
                    userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                  }
                }
              }
            }
          }
        } else if (message.type === 'image') userMessageText = '[Customer ne ek image bheji hai — poochein kya dekhna chahte hain]';
          else if (message.type === 'sticker') userMessageText = '[Customer ne sticker bheja — friendly acknowledgment do]';
          else if (message.type === 'document') userMessageText = '[Customer ne document bheja — poochein kya chahiye]';
          else userMessageText = '[Customer ne kuch bheja — poochein kya chahiye]';

        if (!userMessageText.trim()) userMessageText = 'السلام علیکم';

        let history = [];
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
          ...history.map(c => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts?.[0]?.text || '' })),
          { role: 'user', content: (customerName ? `Customer name: ${customerName}\n` : '') + userMessageText }
        ];

        let aiReply = '';

        if (!aiReply && GEMINI_API_KEY) {
          for (const model of ['gemini-3.7-flash', 'gemini-3.6-flash']) {
            if (aiReply) break;
            const cbKey = `g:${model}`;
            if (isBlocked(cbKey)) { console.warn('[SKIP]', cbKey); continue; }

            for (let attempt = 1; attempt <= 2; attempt++) {
              if (aiReply) break;
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 20000);
              try {
                console.log(`[STEP B] Querying ${model} (attempt ${attempt})...`);
                const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                  {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                    body: JSON.stringify({
                      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                      contents: geminiContents,
                      generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
                    })
                  }
                );

                if (r.ok) {
                  const d = await r.json();
                  const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                  if (raw) aiReply = raw.replace(/[*_~`#]/g, '').trim();
                  console.log(`[STEP B SUCCESS] ${model} (attempt ${attempt})`);
                  break;
                }
                if (r.status === 429) { blockFor(cbKey,5*60*1000); console.warn(`[STEP B 429] ${model} quota`); break; }
                if (r.status === 503 && attempt < 2) {
                  await r.text().catch(() => '');
                  console.warn(`[STEP B 503] ${model} overloaded, retry in 2s...`);
                  await sleep(2000); continue;
                }
                const et = await r.text().catch(() => '');
                console.error(`[STEP B FAIL] ${model} ${r.status}:`, et.slice(0,150));
                break;
              } catch (e) {
                const isAbort = e?.name === 'AbortError' || String(e?.message || '').includes('abort');
                if (isAbort && attempt < 2) { console.warn(`[STEP B TIMEOUT] ${model} retry...`); await sleep(2000); continue; }
                console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
                break;
              } finally { clearTimeout(timeoutId); }
            }
          }
        }

        if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cerebras')) {
          for (let att = 1; att <= 2; att++) {
            if (aiReply) break;
            try {
              console.log(`[STEP B] Cerebras att${att}...`);
              const r = await oaiChat({ url:'https://api.cerebras.ai/v1', key:CEREBRAS_API_KEY, model:'llama-3.3-70b', messages:oaiMessages });
              if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();} console.log('[STEP B SUCCESS] Cerebras'); break; }
              if (r.status===429) { blockFor('cerebras',5*60*1000); break; }
              if (r.status===503&&att<2) { await sleep(4000); continue; }
              console.error('[STEP B FAIL] Cerebras', r.status); break;
            } catch(e) { const ab=e?.name==='AbortError'||String(e?.message||'').includes('abort'); if(ab&&att<2){await sleep(2000);continue;} console.error('[STEP B EXC] Cerebras:', e.message); break; }
          }
        }

        if (!aiReply && GROQ_API_KEY) {
          for (const gm of ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']) {
            if (aiReply) break;
            const cbKey = `gr:${gm}`;
            if (isBlocked(cbKey)) continue;
            try {
              console.log(`[STEP B] Groq ${gm}...`);
              const r = await oaiChat({ url:'https://api.groq.com/openai/v1', key:GROQ_API_KEY, model:gm, messages:oaiMessages });
              if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();} console.log(`[STEP B SUCCESS] Groq:${gm}`); break; }
              if (r.status===429) { blockFor(cbKey,5*60*1000); break; }
              console.error(`[STEP B FAIL] Groq:${gm}`, r.status); break;
            } catch(e) { console.error(`[STEP B EXC] Groq:${gm}:`, e.message); break; }
          }
        }

        if (!aiReply && OPENROUTER_API_KEY && !isBlocked('or:mistral')) {
          try {
            console.log('[STEP B] OpenRouter...');
            const r = await oaiChat({ url:'https://openrouter.ai/api/v1', key:OPENROUTER_API_KEY, model:'mistralai/mistral-7b-instruct:free', messages:oaiMessages });
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();} console.log('[STEP B SUCCESS] OpenRouter'); }
            else if (r.status===429) blockFor('or:mistral',5*60*1000);
            else console.error('[STEP B FAIL] OpenRouter', r.status);
          } catch(e) { console.error('[STEP B EXC] OpenRouter:', e.message); }
        }

        if (!aiReply) {
          aiReply = 'تھوڑی دیر میں واپس آتی ہوں، ابھی سسٹم مصروف ہے۔ شکریہ صبر کا 🙏';
          console.warn('[STEP B FALLBACK] All models failed.');
        }

        const orderTag = parseOrderTag(aiReply);
        if (orderTag) {
          aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();
          const saveResult = await saveToSheet(
            GOOGLE_SHEETS_ID,
            GOOGLE_SA_EMAIL,
            GOOGLE_SA_KEY,
            orderTag,
            fromNumber
          );
          if (!saveResult.ok && !saveResult.duplicate) {
            console.error('[ORDER SAVE] Persistence not confirmed:', saveResult.reason);
          }
        }

        aiReply = fixCities(aiReply);
        if (!aiReply.trim()) aiReply = 'تھوڑی دیر میں واپس آتی ہوں۔ شکریہ 🙏';

        history.push({ role: 'user', parts: [{ text: userMessageText }] });
        history.push({ role: 'model', parts: [{ text: aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

        chatHistories.set(fromNumber, history);
        dbSave(DATABASE_URL, fromNumber, customerName, history).catch(() => {});

        let voiceSentSuccess = false;

        if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] Converting to voice via ElevenLabs...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method:'POST',
              headers:{'xi-api-key':ELEVENLABS_API_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
              body:JSON.stringify({
                text:aiReply,
                model_id:'eleven_flash_v2_5',
                language_code:'ur',
                voice_settings:{stability:0.75,similarity_boost:0.85,style:0.4,use_speaker_boost:true}
              })
            });

            if (ttsRes.ok) {
              const arrayBuffer = await ttsRes.arrayBuffer();
              const mediaFormData = new globalThis.FormData();
              const audioBlob = new globalThis.Blob([arrayBuffer], { type:'audio/mpeg' });
              mediaFormData.append('messaging_product','whatsapp');
              mediaFormData.append('file',audioBlob,'voice.mp3');
              mediaFormData.append('type','audio/mpeg');

              const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                method:'POST',headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`},body:mediaFormData
              });
              const uploadData = await uploadRes.json();

              if (uploadData?.id) {
                const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                  method:'POST',
                  headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},
                  body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:fromNumber,type:'audio',audio:{id:uploadData.id}})
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
              console.warn('[STEP C] ElevenLabs quota 429 → text fallback');
            } else {
              console.error('[STEP C FAIL] ElevenLabs status:', ttsRes.status);
            }
          } catch (err) {
            console.error('[STEP C ERROR]:', err.message);
          }
        }

        if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method:'POST',
            headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},
            body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:fromNumber,type:'text',text:{preview_url:false,body:aiReply}})
          });
          if (textRes.ok) console.log('[STEP D SUCCESS] Text message sent.');
          else { const errBody=await textRes.text(); console.error('[STEP D FAIL]:',errBody.slice(0,150)); }
        }
      } catch (err) {
        console.error('[FATAL ERROR]:', err.message, err.stack);
      }
    })();

    if (waitUntilFn) { waitUntilFn(processPromise); return res.status(200).send('EVENT_RECEIVED'); }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};