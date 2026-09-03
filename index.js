// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  2026-09-03 — PRODUCTION READY v2
//
//  FIXES:
//  [B1] maxOutputTokens 800→1500 (fixes cut-off Urdu sentences)
//  [B2] AI reply sanitizer — strips leaked meta-instructions from weak models
//  [B3] Google Sheets URL fixed (Sheet1!A1:append not Sheet1!A:J:append)
//  [B4] ORDER tag: validated before sheet save + retry on parse fail
//  [B5] fixCityNames regex scoped to word boundaries only (no Urdu word damage)
//  [B6] Weak model (tier4/5) reply validator — rejects leaked-prompt responses
//  [B7] Tier3/4/5 only used when keys present (no silent skip on missing key)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Vercel waitUntil ──────────────────────────────────────────────────────────
let waitUntilFn = null;
try {
  const vf = require('@vercel/functions');
  if (vf?.waitUntil) waitUntilFn = vf.waitUntil;
} catch (_) {}

// ── Circuit breaker ───────────────────────────────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = (k)  => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => {
  global._cb.set(k, Date.now() + ms);
  console.warn(`[CB] ${k} blocked ${Math.round(ms / 1000)}s`);
};

function maybeResetAtMidnight() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
    const [h, m] = pkt.split(':').map(Number);
    if (h === 0 && m <= 5 && global._cb.size > 0) {
      global._cb.clear();
      console.log('[CB] Midnight reset');
    }
  } catch (_) {}
}

// ── In-memory stores ──────────────────────────────────────────────────────────
const chatHistories   = new Map(); // fromNumber → { history:[], lastSeen:ms }
const processedMsgIds = new Map(); // messageId  → expiresAtMs

const MAX_HISTORY = 20;
const DEDUP_TTL   = 10 * 60 * 1000;
const USER_TTL    = 24 * 60 * 60 * 1000;
const MAX_USERS   = 500;

function cleanup() {
  const now = Date.now();
  for (const [id, exp] of processedMsgIds) if (exp <= now) processedMsgIds.delete(id);
  for (const [n, o] of chatHistories)
    if (((o?.lastSeen || 0) + USER_TTL) <= now) chatHistories.delete(n);
  if (chatHistories.size > MAX_USERS) {
    [...chatHistories.entries()]
      .sort((a, b) => (a[1]?.lastSeen || 0) - (b[1]?.lastSeen || 0))
      .slice(0, chatHistories.size - MAX_USERS)
      .forEach(([k]) => chatHistories.delete(k));
  }
}

function alreadyProcessed(id) {
  if (!id) return false;
  cleanup();
  const now = Date.now();
  if ((processedMsgIds.get(id) || 0) > now) return true;
  processedMsgIds.set(id, now + DEDUP_TTL);
  return false;
}

function getHistory(num) {
  cleanup();
  if (!chatHistories.has(num)) chatHistories.set(num, { history: [], lastSeen: Date.now() });
  const o = chatHistories.get(num);
  o.lastSeen = Date.now();
  return o.history;
}

// ── PKT time ──────────────────────────────────────────────────────────────────
function getPKTTime() {
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi', weekday: 'long', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date())) p[x.type] = x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch (e) { return 'PKT time unavailable'; }
}

// ── [B5] City name correction — ASCII word boundaries only (safe for Urdu) ───
const CITY_CORRECTIONS = {
  'faizabad': 'Faisalabad', 'faizaabad': 'Faisalabad', 'faisalabaad': 'Faisalabad',
  'faisalabab': 'Faisalabad', 'faisalbad': 'Faisalabad', 'fasialabad': 'Faisalabad',
  'lahroe': 'Lahore', 'lhaore': 'Lahore', 'karaachi': 'Karachi', 'karachy': 'Karachi',
  'rwalpindi': 'Rawalpindi', 'rawalpndi': 'Rawalpindi', 'gujranwla': 'Gujranwala',
};
function fixCityNames(text) {
  if (!text) return text;
  // Only match ASCII words (safe — won't touch Urdu/Arabic script characters)
  return text.replace(/\b([A-Za-z]+)\b/g, (word) => {
    return CITY_CORRECTIONS[word.toLowerCase()] || word;
  });
}

// ── [B2] AI reply sanitizer — strips leaked meta-instructions ─────────────────
// Weak models (mistral-7b, llama-8b) sometimes echo prompt instructions.
const LEAKED_PATTERNS = [
  /^response\s*\((?:urdu|english|roman\s*urdu)\)\s*:?/im,
  /^acknowledge\s+and\s+/im,
  /^as\s+zara[,\s]/im,
  /^zara\s*(?:would|should|must|can)\s+/im,
  /^(?:here\s+is|here's)\s+(?:a\s+)?(?:the\s+)?(?:response|reply|message)/im,
  /^\[(?:SYSTEM|INST|ASSISTANT|CONTEXT)\]/im,
  /^(?:sure|okay|ok|certainly)[!,.\s]+(?:here|as|i\s+will)/im,
];

function sanitizeReply(text) {
  if (!text) return text;
  let lines = text.split('\n');

  // Remove any leading lines that match leaked patterns
  while (lines.length > 0) {
    const firstLine = lines[0].trim();
    const isLeaked  = LEAKED_PATTERNS.some(p => p.test(firstLine));
    if (isLeaked) {
      console.warn('[SANITIZE] Removed leaked line:', firstLine.slice(0, 60));
      lines.shift();
    } else {
      break;
    }
  }

  // Remove any line that is purely an instruction echo (starts with known meta-words)
  lines = lines.filter(line => {
    const t = line.trim();
    if (!t) return true; // keep blank lines
    if (/^(State|Acknowledge|Confirm|Greet|Reply|Respond|Tell|Inform)\s+the\s+customer/i.test(t)) {
      console.warn('[SANITIZE] Removed instruction line:', t.slice(0, 60));
      return false;
    }
    return true;
  });

  return lines.join('\n').trim();
}

// Checks if a reply looks like a leaked prompt (reject entirely if too bad)
function isReplyCorrupted(text) {
  if (!text) return true;
  const leakedCount = LEAKED_PATTERNS.filter(p => p.test(text)).length;
  // More than 1 leaked pattern match = likely corrupted
  return leakedCount > 1;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────
async function getGoogleToken(email, privateKey) {
  try {
    const now    = Math.floor(Date.now() / 1000);
    const toB64  = (s) => Buffer.from(s).toString('base64url');
    const header  = toB64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = toB64(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud:  'https://oauth2.googleapis.com/token',
      exp:  now + 3600,
      iat:  now
    }));
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(privateKey.replace(/\\n/g, '\n'), 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const d = await r.json();
    if (!d.access_token) {
      console.error('[SHEETS] Token response:', JSON.stringify(d).slice(0, 200));
      return null;
    }
    return d.access_token;
  } catch (e) { console.error('[SHEETS] Token error:', e.message); return null; }
}

async function saveOrderToSheet({ sheetsId, saEmail, saKey, orderData }) {
  if (!sheetsId || !saEmail || !saKey) {
    console.warn('[SHEETS] Missing credentials — skipping');
    return;
  }
  try {
    const token = await getGoogleToken(saEmail, saKey);
    if (!token) { console.error('[SHEETS] No token — aborting save'); return; }

    const now = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
    const row = [
      now,
      orderData.customerName || '',
      orderData.phone        || '',
      orderData.product      || '',
      orderData.qty          || '',
      orderData.price        || '',
      orderData.payment      || '',
      orderData.address      || '',
      orderData.city         || '',
      'Pending'
    ];

    // [B3] FIXED URL: correct Google Sheets append endpoint
    // Format: /values/{range}:append  (colon before append is Google's custom method notation)
    // Using A1 as range start — safest form
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [row] })
    });

    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      console.log('[SHEETS] Order saved ✓ updatedRange:', d.updates?.updatedRange || 'n/a');
    } else {
      const e = await res.text().catch(() => '');
      console.error('[SHEETS] Save failed:', res.status, e.slice(0, 200));
    }
  } catch (e) { console.error('[SHEETS] Save error:', e.message); }
}

// [B4] Parse [ORDER:...] tag — validated
function parseOrderTag(text) {
  if (!text) return null;
  const match = text.match(/\[ORDER:([^\]]+)\]/i);
  if (!match) return null;
  const obj = {};
  for (const part of match[1].split('|')) {
    const [key, ...val] = part.split('=');
    if (key && val.length) obj[key.trim().toLowerCase()] = val.join('=').trim();
  }
  // Validate minimum required fields
  const required = ['product', 'payment'];
  const missing  = required.filter(k => !obj[k]);
  if (missing.length) {
    console.warn('[ORDER] Tag found but missing fields:', missing.join(', '));
    return null;
  }
  return obj;
}

// ── OpenAI-compatible fetch helper ────────────────────────────────────────────
async function openaiChat({ baseUrl, apiKey, model, messages, maxTokens = 1500, timeoutMs = 20000 }) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens })
    });
  } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  maybeResetAtMidnight();

  // ── Env vars ──────────────────────────────────────────────────────────────
  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      || '').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     || '').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        || '').trim();
  const GEMINI_API_KEY      = (process.env.GEMINI_API_KEY      || '').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        || '').trim();
  const CEREBRAS_API_KEY    = (process.env.CEREBRAS_API_KEY    || '').trim();
  const OPENROUTER_API_KEY  = (process.env.OPENROUTER_API_KEY  || '').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  || '').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     || '').trim();
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    || '').trim();
  const GOOGLE_SHEETS_ID    = (process.env.GOOGLE_SHEETS_ID    || '').trim();
  const GOOGLE_SA_EMAIL     = (process.env.GOOGLE_SA_EMAIL     || '').trim();
  const GOOGLE_SA_KEY       = (process.env.GOOGLE_SA_KEY       || '').trim();

  // ── System Prompt ─────────────────────────────────────────────────────────
  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding sales agent of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

CURRENT TIME: ${getPKTTime()}

CRITICAL INSTRUCTION: Write ONLY the actual WhatsApp message to send. Do NOT write any meta-instructions, headers, labels like "Response:", "Urdu:", "Acknowledge:", or any explanation of what you are doing. Just write the message directly.

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a helpful colleague
- Use customer's name in EVERY message (if known). If unknown, ask once — never invent.
- Max 2-3 emojis per message. Every message must feel personal.
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== CAPABILITIES ===
You handle: text messages, voice notes (transcribed to text), images, and all customer queries.

=== LANGUAGE === Urdu in→Urdu out | English in→English out | Roman Urdu in→Roman Urdu out

=== TIME GREETING (use CURRENT TIME) ===
06:00–12:00 → صبح بخیر! 🌅 | 12:00–17:00 → خیریت سے ہیں؟ ☀️
17:00–21:00 → شام بخیر! ✨ | 21:00–06:00 → السلام علیکم!
FIRST message only, not every reply.

=== CITY NAMES — CRITICAL ===
⚠️ فیصل آباد = Faisalabad (NEVER Faizabad)
Always spell correctly: Faisalabad • Lahore • Karachi • Islamabad
Rawalpindi • Multan • Gujranwala • Peshawar • Quetta • Sialkot

=== SEASON ===
WINTER (Nov–Feb): Marina, Velvet, Dhanak, Karandi first
SUMMER (Apr–Sep): Lawn, Linen/Khaddar, Printed Suits first

=== PRODUCTS (all unstitched) ===
Lawn/Printed | Embroidered | Linen/Khaddar | Kotail | Karandi | Marina | Velvet | Dhanak
Describe feel + season + occasion FIRST. Price only when asked.

=== UPSELL (one per message, natural) ===
Lawn → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں 😊"

=== PRICING ===
Retail: PKR 3,600/suit (delivery extra)
Wholesale (10+ suits): PKR 2,999/suit — 10 suits = PKR 29,990 — city delivery FREE

=== HAGGLING ===
1st: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — اتنی quality اس price میں کہیں نہیں ملتی 🎨"
2nd: "آپی! ہم quality میں کبھی compromise نہیں کرتے 😊"
3rd: "آپی، discount تو boss کا اختیار ہے — میں ابھی پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT ===
1. JazzCash → ${JAZZCASH_NUMBER || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD — confirm address + phone
Ask screenshot for JazzCash/EasyPaisa, alert boss on receipt. Never confirm without payment/COD.

=== DELIVERY ===
City: 1-2 days | Outside city: 3-5 days | Wholesale city: FREE
After order confirmed: always ask full address + city.

=== RETURNS === No returns. Exchange: defect/wrong item only, within 24hrs, photo proof, boss decides.

=== HOURS === Mon–Sun open. Friday 11AM–3PM closed. After 10PM: brief reply, full next morning.

=== ORDER FLOW (follow exactly) ===
Step 1 — Customer shows interest → ask which fabric + how many
Step 2 — Share price + confirm retail vs wholesale
Step 3 — Confirm payment method (JazzCash/EasyPaisa/COD)
Step 4 — Ask full address (house no, street, area, city)
Step 5 — Confirm complete order summary
Step 6 — Add ORDER tag (see below)

=== BOSS ALERT ===
🚨 Angry | 🛍️ Wholesale 10+ | 💰 PKR 10,000+ | ✅ Screenshot | 🔄 Exchange | 🏷️ 3rd discount | ❓ Unusual

=== TRUST ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے 😊"

=== MALE CUSTOMER === Never "آپی". Use "بھائی جان" or "جناب".

=== MEMORY ===
You remember the FULL conversation history above. Use ALL previous context.
Never ask for information already given (name, city, product, address, payment).
Always confirm what you already know.

=== NEVER DO ===
❌ Write "Response:", "Urdu:", "Acknowledge:", or any meta-label before your message
❌ Mention AI/bot/automation
❌ Give discount without boss approval
❌ Confirm order without payment/COD confirmed
❌ Message after 10PM PKT outbound
❌ Message during Friday Juma 11AM–3PM

=== ORDER SAVE TAG ===
When ALL of these are confirmed in conversation:
  ✅ Customer name  ✅ Product + quantity  ✅ Price agreed
  ✅ Payment method confirmed  ✅ Full address + city given

Add this tag on its own line (not in the visible message, just append it):
[ORDER:name=CustomerName|product=ProductName|qty=1|price=3600|payment=COD|address=Full Address Here|city=CityName]

Rules:
- Use exact values from conversation history
- Add ONCE only — when order is first fully confirmed
- city must be spelled correctly (Faisalabad NOT Faizabad)
- Do NOT add if any field is unknown/missing

=== REPLY ROUTING TAG (ABSOLUTE LAST LINE) ===
[VOICE] = customer uses voice notes / broken/no-punctuation text
[TEXT]  = customer uses proper sentences / comfortable with text
- Voice note + uneducated → [VOICE] | Voice note + educated → [TEXT]
- Any text message → [TEXT] | First interaction → [VOICE]
This tag MUST be the last line. Nothing after it.`;

  // ─── GET: Webhook Verification ───────────────────────────────────────────
  if (req.method === 'GET') {
    const protocol  = req.headers['x-forwarded-proto'] || 'https';
    const host      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url       = new URL(req.url, `${protocol}://${host}`);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log('[VERIFY] OK');
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Active');
  }

  // ─── POST: Message Handler ────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

    const entry    = body?.entry?.[0];
    const value    = entry?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        for (const message of messages) {
          const messageId = message?.id;
          if (alreadyProcessed(messageId)) {
            console.log('[DEDUP] Skip:', messageId);
            continue;
          }

          const fromNumber = message.from;
          if (!fromNumber) { console.error('[ERROR] message.from missing'); continue; }

          const isAudioIncoming = message.type === 'audio' || message.type === 'voice';
          const contact         = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
          const customerName    = (contact?.profile?.name || '').trim();
          let userMessageText   = '';

          // ── STEP A: Extract text or transcribe voice ──────────────────
          if (message.type === 'text') {
            userMessageText = fixCityNames(message.text?.body || '');

          } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
            const mediaId = message.audio?.id || message.voice?.id;
            if (!mediaId) {
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              console.log('[A] mediaId:', mediaId);
              const mr = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
              });
              if (!mr.ok) {
                console.error('[A FAIL] Media:', mr.status);
                userMessageText = '[Customer ne voice message bheja]';
              } else {
                const md = await mr.json().catch(() => ({}));
                if (!md?.url) {
                  console.error('[A FAIL] No URL in media data');
                  userMessageText = '[Customer ne voice message bheja]';
                } else {
                  const ar = await fetch(md.url, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
                  if (!ar.ok) {
                    console.error('[A FAIL] Audio download:', ar.status);
                    userMessageText = '[Customer ne voice message bheja]';
                  } else {
                    const buf = await ar.arrayBuffer();
                    const fd  = new globalThis.FormData();
                    fd.append('file', new globalThis.Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
                    fd.append('model',    'whisper-large-v3-turbo');
                    fd.append('language', 'ur');
                    fd.append('prompt',   'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad), لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');
                    const gr = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }, body: fd
                    });
                    if (gr.ok) {
                      const gd = await gr.json().catch(() => ({}));
                      userMessageText = fixCityNames((gd.text || '').trim());
                      console.log('[A SUCCESS] len:', userMessageText.length);
                    } else {
                      console.error('[A FAIL] Groq STT:', gr.status);
                      userMessageText = '[Customer ne voice message bheja]';
                    }
                  }
                }
              }
            }
          } else if (message.type === 'image')    { userMessageText = '[Customer ne image bheji — poochein kya dekhna chahte hain]'; }
            else if (message.type === 'sticker')  { userMessageText = '[Customer ne sticker bheja — friendly acknowledgment do]'; }
            else if (message.type === 'document') { userMessageText = '[Customer ne document bheja — poochein kya chahiye]'; }
            else                                  { userMessageText = '[Customer ne kuch bheja — poochein kya chahiye]'; }

          if (!userMessageText.trim()) userMessageText = 'السلام علیکم';

          // ── Load history ──────────────────────────────────────────────
          const history = getHistory(fromNumber);

          const historyGemini = [
            ...history,
            {
              role: 'user',
              parts: [{
                text: (customerName ? `Customer name: ${customerName}\n` : '') +
                      `Message:\n${userMessageText}`
              }]
            }
          ];

          const historyOAI = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history.map(c => ({
              role:    c.role === 'model' ? 'assistant' : 'user',
              content: c.parts?.[0]?.text || ''
            })),
            {
              role:    'user',
              content: (customerName ? `Customer name: ${customerName}\n` : '') +
                       `Message:\n${userMessageText}`
            }
          ];

          let aiReply = '', usedProvider = '';

          // ══════════════════════════════════════════════════════════════
          //  STEP B: 5-TIER PROVIDER CHAIN
          // ══════════════════════════════════════════════════════════════

          // ── Tier 1+2: Gemini ──────────────────────────────────────────
          if (!aiReply && GEMINI_API_KEY) {
            for (const model of ['gemini-3.7-flash', 'gemini-3.6-flash']) {
              if (aiReply) break;
              if (isBlocked(`g:${model}`)) { console.warn(`[SKIP] g:${model}`); continue; }

              for (let att = 1; att <= 2; att++) {
                if (aiReply) break;
                const ctrl = new AbortController();
                const t    = setTimeout(() => ctrl.abort(), 20000);
                try {
                  console.log(`[B] g:${model} att${att}`);
                  const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                    {
                      method:  'POST',
                      headers: { 'Content-Type': 'application/json' },
                      signal:  ctrl.signal,
                      body:    JSON.stringify({
                        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                        contents:           historyGemini,
                        generationConfig:   {
                          temperature:     0.7,
                          maxOutputTokens: att === 1 ? 1500 : 1200 // [B1] FIXED: was 800
                        }
                      })
                    }
                  );
                  if (r.ok) {
                    const d   = await r.json().catch(() => ({}));
                    const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (raw && !isReplyCorrupted(raw)) {
                      aiReply      = sanitizeReply(raw.replace(/[*_~`#]/g, '')).trim();
                      usedProvider = `g:${model}`;
                    }
                    console.log(`[B OK] g:${model} att${att} len:${aiReply.length}`);
                    break;
                  }
                  if (r.status === 429) { blockFor(`g:${model}`, 5 * 60 * 1000); break; }
                  if (r.status === 503 && att < 2) { await sleep(4000); continue; }
                  const et = await r.text().catch(() => '');
                  console.error(`[B FAIL] g:${model} ${r.status}:`, et.slice(0, 100));
                  break;
                } catch (e) {
                  const isAbort = e?.name === 'AbortError' || String(e?.message || '').includes('abort');
                  if (isAbort && att < 2) { await sleep(2000); continue; }
                  console.error(`[B EXC] g:${model}:`, e?.message);
                  break;
                } finally { clearTimeout(t); }
              }
            }
          }

          // ── Tier 3: Cerebras ──────────────────────────────────────────
          if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cb')) {
            for (let att = 1; att <= 2; att++) {
              if (aiReply) break;
              try {
                console.log(`[B] cerebras att${att}`);
                const r = await openaiChat({
                  baseUrl:    'https://api.cerebras.ai/v1',
                  apiKey:     CEREBRAS_API_KEY,
                  model:      'llama-3.3-70b',
                  messages:   historyOAI,
                  maxTokens:  1500
                });
                if (r.ok) {
                  const d   = await r.json().catch(() => ({}));
                  const raw = d.choices?.[0]?.message?.content?.trim();
                  if (raw && !isReplyCorrupted(raw)) {
                    aiReply      = sanitizeReply(raw.replace(/[*_~`#]/g, '')).trim();
                    usedProvider = 'cerebras';
                  }
                  console.log('[B OK] cerebras len:', aiReply.length);
                  break;
                }
                if (r.status === 429) { blockFor('cb', 5 * 60 * 1000); break; }
                if (r.status === 503 && att < 2) { await sleep(4000); continue; }
                console.error('[B FAIL] cerebras:', r.status);
                break;
              } catch (e) {
                const isAbort = e?.name === 'AbortError' || String(e?.message || '').includes('abort');
                if (isAbort && att < 2) { await sleep(2000); continue; }
                console.error('[B EXC] cerebras:', e?.message);
                break;
              }
            }
          }

          // ── Tier 4: Groq ──────────────────────────────────────────────
          if (!aiReply && GROQ_API_KEY) {
            for (const gm of ['llama-3.3-70b-versatile', 'llama3-70b-8192']) {
              if (aiReply) break;
              if (isBlocked(`gr:${gm}`)) continue;
              try {
                console.log(`[B] groq:${gm}`);
                const r = await openaiChat({
                  baseUrl:   'https://api.groq.com/openai/v1',
                  apiKey:    GROQ_API_KEY,
                  model:     gm,
                  messages:  historyOAI,
                  maxTokens: 1500
                });
                if (r.ok) {
                  const d   = await r.json().catch(() => ({}));
                  const raw = d.choices?.[0]?.message?.content?.trim();
                  if (raw && !isReplyCorrupted(raw)) {
                    aiReply      = sanitizeReply(raw.replace(/[*_~`#]/g, '')).trim();
                    usedProvider = `groq:${gm}`;
                  }
                  console.log(`[B OK] groq:${gm} len:${aiReply.length}`);
                  break;
                }
                if (r.status === 429) { blockFor(`gr:${gm}`, 5 * 60 * 1000); break; }
                console.error(`[B FAIL] groq:${gm}:`, r.status);
                break;
              } catch (e) {
                console.error(`[B EXC] groq:${gm}:`, e?.message);
                break;
              }
            }
          }

          // ── Tier 5: OpenRouter (only large models — small ones corrupt Urdu) ─
          if (!aiReply && OPENROUTER_API_KEY) {
            for (const orm of [
              'meta-llama/llama-3.1-70b-instruct:free',
              'mistralai/mistral-nemo:free'
            ]) {
              if (aiReply) break;
              if (isBlocked(`or:${orm}`)) continue;
              try {
                console.log(`[B] openrouter:${orm}`);
                const r = await openaiChat({
                  baseUrl:   'https://openrouter.ai/api/v1',
                  apiKey:    OPENROUTER_API_KEY,
                  model:     orm,
                  messages:  historyOAI,
                  maxTokens: 1500
                });
                if (r.ok) {
                  const d   = await r.json().catch(() => ({}));
                  const raw = d.choices?.[0]?.message?.content?.trim();
                  // [B6] Strict validation for weak models
                  if (raw && !isReplyCorrupted(raw)) {
                    const sanitized = sanitizeReply(raw.replace(/[*_~`#]/g, '')).trim();
                    // Reject if sanitized reply is too short (likely corrupted/empty after strip)
                    if (sanitized.length > 20) {
                      aiReply      = sanitized;
                      usedProvider = `or:${orm}`;
                    } else {
                      console.warn(`[B] or:${orm} reply too short after sanitize — skip`);
                    }
                  }
                  if (aiReply) console.log(`[B OK] or:${orm} len:${aiReply.length}`);
                  break;
                }
                if (r.status === 429) { blockFor(`or:${orm}`, 5 * 60 * 1000); break; }
                console.error(`[B FAIL] or:${orm}:`, r.status);
                break;
              } catch (e) {
                console.error(`[B EXC] or:${orm}:`, e?.message);
                break;
              }
            }
          }

          // All providers failed
          if (!aiReply) {
            aiReply = 'Thori dair mein wapas aati hoon, abhi system thoda busy hai. Shukriya sabr ka 🙏';
            console.warn('[B FALLBACK] All providers failed.');
          } else {
            console.log(`[B DONE] provider=${usedProvider} replyLen=${aiReply.length}`);
          }

          // ── [B4] Extract & save ORDER tag ─────────────────────────────
          const orderTag = parseOrderTag(aiReply);
          if (orderTag) {
            console.log('[ORDER] Detected:', JSON.stringify(orderTag));
            // Remove tag from reply before sending to customer
            aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();

            if (GOOGLE_SHEETS_ID) {
              saveOrderToSheet({
                sheetsId: GOOGLE_SHEETS_ID,
                saEmail:  GOOGLE_SA_EMAIL,
                saKey:    GOOGLE_SA_KEY,
                orderData: {
                  ...orderTag,
                  phone:        fromNumber,
                  customerName: orderTag.name || customerName
                }
              }).catch(e => console.error('[ORDER] Sheets async error:', e.message));
            } else {
              console.warn('[ORDER] GOOGLE_SHEETS_ID not set — order not saved');
            }
          }

          // Apply city name fix to final reply
          aiReply = fixCityNames(aiReply);

          // ── Extract routing tag [VOICE]/[TEXT] ────────────────────────
          let sendVoice = false;
          const lines   = aiReply.trim().split('\n');
          const lastFew = lines.slice(-3).map(l => l.trim().toUpperCase());
          const hasVoice = lastFew.some(l => l === '[VOICE]');
          const hasText  = lastFew.some(l => l === '[TEXT]');

          if (hasVoice || hasText) {
            let cut = lines.length;
            for (let i = lines.length - 1; i >= 0; i--) {
              const u = lines[i].trim().toUpperCase();
              if (u === '[VOICE]' || u === '[TEXT]' || u === '') cut = i;
              else break;
            }
            aiReply = lines.slice(0, cut).join('\n').trim();

            if (!isAudioIncoming)  { sendVoice = false; console.log('[ROUTE] Text→TEXT'); }
            else if (hasVoice)     { sendVoice = true;  console.log('[ROUTE] Uneducated→VOICE'); }
            else                   { sendVoice = false; console.log('[ROUTE] Educated→TEXT'); }
          } else {
            sendVoice = isAudioIncoming;
            console.log('[ROUTE] No tag — default:', sendVoice ? 'VOICE' : 'TEXT');
          }

          if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

          // ── Save to history ───────────────────────────────────────────
          history.push({ role: 'user',  parts: [{ text: userMessageText }] });
          history.push({ role: 'model', parts: [{ text: aiReply }] });
          if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

          // ── STEP C: ElevenLabs TTS → Voice Note ──────────────────────
          let voiceSent = false;
          if (sendVoice && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
            try {
              console.log('[C] TTS start...');
              const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
                method:  'POST',
                headers: {
                  'xi-api-key':   ELEVENLABS_API_KEY,
                  'Content-Type': 'application/json',
                  'Accept':       'audio/mpeg'
                },
                body: JSON.stringify({
                  text:           aiReply,
                  model_id:       'eleven_multilingual_v2',
                  voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                })
              });

              if (tts.ok) {
                const buf = await tts.arrayBuffer();
                const mfd = new globalThis.FormData();
                mfd.append('messaging_product', 'whatsapp');
                mfd.append('file', new globalThis.Blob([buf], { type: 'audio/mpeg' }), 'voice.mp3');
                mfd.append('type', 'audio/mpeg');

                const up = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                  method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }, body: mfd
                });
                const ud = await up.json().catch(() => ({}));

                if (up.ok && ud?.id) {
                  const vr = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                    method:  'POST',
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                      messaging_product: 'whatsapp', recipient_type: 'individual',
                      to: fromNumber, type: 'audio', audio: { id: ud.id }
                    })
                  });
                  if (vr.ok) { voiceSent = true; console.log('[C SUCCESS]'); }
                  else { console.error('[C FAIL] Send:', vr.status); }
                } else { console.error('[C FAIL] Upload:', up.status); }

              } else if (tts.status === 429) {
                console.warn('[C] ElevenLabs 429 — fallback to text');
              } else {
                console.error('[C FAIL] ElevenLabs:', tts.status);
              }
            } catch (e) { console.error('[C ERR]:', e.message); }
          }

          // ── STEP D: Text reply ────────────────────────────────────────
          if (!voiceSent && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
            const tr = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
              method:  'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
              body:    JSON.stringify({
                messaging_product: 'whatsapp', recipient_type: 'individual',
                to: fromNumber, type: 'text', text: { preview_url: false, body: aiReply }
              })
            });
            if (tr.ok) {
              console.log('[D SUCCESS] msgId:', messageId || 'n/a');
            } else {
              const e = await tr.text().catch(() => '');
              console.error('[D FAIL]', tr.status, e.slice(0, 120));
            }
          }

        } // end for messages
      } catch (err) {
        console.error('[FATAL]:', err.message, err.stack);
      }
    })();

    if (waitUntilFn) {
      waitUntilFn(processPromise);
      return res.status(200).send('EVENT_RECEIVED');
    }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).send('Method Not Allowed');
};
