// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  2026-09-03 — PRODUCTION READY
//
//  AI PROVIDER CHAIN (all free, auto-failover):
//  1. Gemini 3.7-flash    (Google AI Studio — primary, best quality)
//  2. Gemini 3.6-flash    (Google AI Studio — fallback)
//  3. Cerebras llama-3.3-70b (2100 tok/s, 1M/day free)
//  4. Groq openai/gpt-oss-120b
//  5. OpenRouter mistralai/mistral-7b-instruct:free
//
//  NEW FEATURES:
//  [G1] Google Sheets auto-save — order saved when Zara confirms [ORDER] tag
//  [G2] Faisalabad fix — Whisper prompt + text correction + system prompt
//
//  REQUIRED ENV VARS:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY
//
//  OPTIONAL ENV VARS (more fallback AI):
//  CEREBRAS_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_VOICE_ID
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Vercel waitUntil ──────────────────────────────────────────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── Circuit breaker ───────────────────────────────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked  = (k) => Date.now() < (global._cb.get(k) || 0);
const blockFor   = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

// Midnight PKT reset — clears all circuit breakers when daily quota refills
function maybeResetAtMidnight() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Karachi', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h === 0 && m <= 5 && global._cb.size > 0) { global._cb.clear(); console.log('[CB] Midnight reset'); }
  } catch (_) {}
}

// ── In-memory stores ──────────────────────────────────────────────────────────
const chatHistories   = new Map();
const processedMsgIds = new Map();
const MAX_HISTORY = 20, DEDUP_TTL = 10*60*1000, USER_TTL = 24*60*60*1000, MAX_USERS = 500;

function cleanup() {
  const now = Date.now();
  for (const [id,exp] of processedMsgIds) if (exp<=now) processedMsgIds.delete(id);
  for (const [n,o] of chatHistories) if (((o?.lastSeen||0)+USER_TTL)<=now) chatHistories.delete(n);
  if (chatHistories.size > MAX_USERS) {
    [...chatHistories.entries()].sort((a,b)=>(a[1]?.lastSeen||0)-(b[1]?.lastSeen||0))
      .slice(0, chatHistories.size-MAX_USERS).forEach(([k])=>chatHistories.delete(k));
  }
}
function alreadyProcessed(id) {
  if (!id) return false; cleanup(); const now=Date.now();
  if ((processedMsgIds.get(id)||0)>now) return true;
  processedMsgIds.set(id, now+DEDUP_TTL); return false;
}
function getHistory(num) {
  cleanup();
  if (!chatHistories.has(num)) chatHistories.set(num,{history:[],lastSeen:Date.now()});
  const o=chatHistories.get(num); o.lastSeen=Date.now(); return o.history;
}

// ── PKT time ──────────────────────────────────────────────────────────────────
function getPKTTime() {
  try {
    const p={};
    for (const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT time unavailable'; }
}

// [G2] Pakistani city name correction (Whisper STT common errors)
const CITY_CORRECTIONS = {
  'faizabad':'Faisalabad', 'faizaabad':'Faisalabad', 'faizabad':'Faisalabad',
  'faisalabaad':'Faisalabad', 'faisalabab':'Faisalabad', 'faisalbad':'Faisalabad',
  'lahroe':'Lahore', 'lhaore':'Lahore', 'karaachi':'Karachi', 'karachy':'Karachi',
  'islamabad':'Islamabad', 'rwalpindi':'Rawalpindi', 'rawalpndi':'Rawalpindi',
  'multan':'Multan', 'gujranwala':'Gujranwala', 'gujranwla':'Gujranwala',
  'peshawar':'Peshawar', 'quetta':'Quetta', 'sialkot':'Sialkot',
};
function fixCityNames(text) {
  if (!text) return text;
  return text.replace(/\b([A-Za-z]+)\b/g, (word) => {
    const lower = word.toLowerCase();
    return CITY_CORRECTIONS[lower] || word;
  });
}

// ── Google Sheets API ─────────────────────────────────────────────────────────
// [G1] Saves order rows to Google Sheet using service account (no extra packages)
async function getGoogleToken(email, privateKey) {
  try {
    const now = Math.floor(Date.now()/1000);
    const toB64 = (s) => Buffer.from(s).toString('base64url');
    const header  = toB64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const payload = toB64(JSON.stringify({
      iss: email, scope:'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', exp: now+3600, iat: now
    }));
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(privateKey.replace(/\\n/g,'\n'), 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const d = await r.json();
    return d.access_token || null;
  } catch(e) { console.error('[SHEETS] Token error:', e.message); return null; }
}

async function saveOrderToSheet({ sheetsId, saEmail, saKey, orderData }) {
  if (!sheetsId || !saEmail || !saKey) { console.warn('[SHEETS] Missing credentials — skipping save'); return; }
  try {
    const token = await getGoogleToken(saEmail, saKey);
    if (!token) { console.error('[SHEETS] Could not get token'); return; }

    const now  = new Date().toLocaleString('en-PK', { timeZone:'Asia/Karachi' });
    const row  = [
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

    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/Sheet1!A:J:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method:'POST',
        headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
        body: JSON.stringify({ values:[row] })
      }
    );
    if (res.ok) console.log('[SHEETS] Order saved ✓');
    else { const e=await res.text(); console.error('[SHEETS] Save failed:', res.status, e.slice(0,150)); }
  } catch(e) { console.error('[SHEETS] Save error:', e.message); }
}

// Parse [ORDER:...] tag from AI reply
function parseOrderTag(text) {
  // Format: [ORDER:name=X|product=X|qty=X|price=X|payment=X|address=X|city=X]
  const match = text.match(/\[ORDER:([^\]]+)\]/i);
  if (!match) return null;
  const obj = {};
  for (const part of match[1].split('|')) {
    const [key, ...val] = part.split('=');
    if (key && val.length) obj[key.trim().toLowerCase()] = val.join('=').trim();
  }
  return Object.keys(obj).length ? obj : null;
}

// ── OpenAI-compatible fetch helper ────────────────────────────────────────────
async function openaiChat({ baseUrl, apiKey, model, messages, maxTokens=800, timeoutMs=20000 }) {
  const ctrl = new AbortController();
  const t    = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method:'POST', signal:ctrl.signal,
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({model, messages, temperature:0.7, max_tokens:maxTokens})
    });
  } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  maybeResetAtMidnight();

  // ── Env vars ──────────────────────────────────────────────────────────────
  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      ||'').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     ||'').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        ||'').trim();
  const GEMINI_API_KEY      = (process.env.GEMINI_API_KEY      ||'').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        ||'').trim();
  const CEREBRAS_API_KEY    = (process.env.CEREBRAS_API_KEY    ||'').trim();
  const OPENROUTER_API_KEY  = (process.env.OPENROUTER_API_KEY  ||'').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  ||'').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID ||'21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     ||'').trim();
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    ||'').trim();
  // [G1] Google Sheets
  const GOOGLE_SHEETS_ID    = (process.env.GOOGLE_SHEETS_ID    ||'').trim();
  const GOOGLE_SA_EMAIL     = (process.env.GOOGLE_SA_EMAIL     ||'').trim();
  const GOOGLE_SA_KEY       = (process.env.GOOGLE_SA_KEY       ||'').trim();

  // ── System Prompt ─────────────────────────────────────────────────────────
  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding sales agent of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

CURRENT TIME: ${getPKTTime()}

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
⚠️ فیصل آباد = Faisalabad (NOT Faizabad, NOT Faizaabad)
⚠️ Always spell Pakistani city names correctly:
  Faisalabad • Lahore • Karachi • Islamabad • Rawalpindi
  Multan • Gujranwala • Peshawar • Quetta • Sialkot
If customer says Faisalabad, ALWAYS write Faisalabad — NEVER Faizabad or any variant.

=== SEASON ===
WINTER (Nov–Feb): Marina, Velvet, Dhanak, Karandi first
SUMMER (Apr–Sep): Lawn, Linen/Khaddar, Printed Suits first

=== PRODUCTS (all unstitched) ===
Lawn/Printed | Embroidered | Linen/Khaddar | Kotail | Karandi | Marina | Velvet | Dhanak
Describe feel + season + occasion FIRST. Price only when asked.

=== UPSELL (one, natural) ===
Lawn → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں 😊"

=== PRICING ===
Retail: PKR 3,600/suit | Wholesale (10+ suits): PKR 2,999/suit, city delivery FREE

=== HAGGLING ===
1st: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — اتنی quality اس price میں کہیں نہیں ملتی 🎨"
2nd: "آپی! ہم quality میں کبھی compromise نہیں کرتے 😊"
3rd: "آپی، discount تو boss کا اختیار ہے — میں ابھی پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT ===
1. JazzCash → ${JAZZCASH_NUMBER||'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER||'boss se confirm karein'}
3. COD — confirm address + phone
Ask screenshot, alert boss on screenshot. Never confirm without payment/COD.

=== DELIVERY ===
City: 1-2 days | Outside city: 3-5 days | Wholesale city: FREE | After order: ask full address

=== RETURNS === No returns. Exchange: defect/wrong item, 24hrs, photo proof, boss decides.

=== HOURS === Mon–Sun open. Friday 11AM–3PM closed. After 10PM: brief reply, full next morning.

=== ORDER PROCESS ===
1. Alert boss (name+product+type)
2. Confirm product+price+payment options
3. Ask delivery address + city
4. Confirm payment method

=== BOSS ALERT ===
🚨 Angry | 🛍️ Wholesale 10+ | 💰 PKR 10,000+ | ✅ Screenshot | 🔄 Exchange | 🏷️ 3rd discount | ❓ Unusual

=== TRUST ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے 😊"

=== MALE CUSTOMER === Never "آپی". Use "بھائی جان" or "جناب".
=== MEMORY === Full conversation history. Use context. Never repeat answered questions.

=== NEVER DO ===
❌ AI/bot/automated | ❌ Discount without boss | ❌ Competitors
❌ Confirm order without payment/COD | ❌ After 10PM outbound | ❌ Juma 11AM–3PM

=== GOOGLE SHEETS ORDER SAVE TAG ===
When customer confirms full address AND payment method (order is complete), add this tag on its own line:
[ORDER:name=CustomerName|product=ProductName|qty=1|price=3600|payment=COD|address=Full Address|city=CityName]
Use exact values from conversation. Only add this tag ONCE when order is first confirmed. Never add it again.
IMPORTANT: city must be spelled correctly (e.g. Faisalabad, NOT Faizabad).

=== REPLY ROUTING TAG (MANDATORY — VERY LAST LINE) ===
[VOICE] = customer uneducated: voice-only, broken/no-punctuation text
[TEXT]  = customer educated: proper sentences, text-comfortable
- Voice note + uneducated → [VOICE] | Voice note + educated → [TEXT]
- Any text message → [TEXT] | First interaction → [VOICE]
This tag must be the ABSOLUTE last line. Nothing after it.`;

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
        console.log('[VERIFY] OK'); return res.status(200).send(challenge);
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

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN||!PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        for (const message of messages) {
          const messageId = message?.id;
          if (alreadyProcessed(messageId)) { console.log('[DEDUP] Skip:', messageId); continue; }

          const fromNumber      = message.from;
          if (!fromNumber) { console.error('[ERROR] message.from missing'); continue; }

          const isAudioIncoming = message.type==='audio'||message.type==='voice';
          const contact         = contacts.find(c=>c?.wa_id===fromNumber)||contacts[0]||null;
          const customerName    = (contact?.profile?.name||'').trim();
          let userMessageText   = '';

          // ── STEP A: Extract text or transcribe voice ──────────────────
          if (message.type==='text') {
            userMessageText = fixCityNames(message.text?.body||''); // [G2] fix city names in text too

          } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
            const mediaId = message.audio?.id||message.voice?.id;
            if (!mediaId) {
              userMessageText='[Customer ne voice message bheja]';
            } else {
              console.log('[A] mediaId:', mediaId);
              const mr = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
                headers:{'Authorization':`Bearer ${WHATSAPP_TOKEN}`}
              });
              if (!mr.ok) { console.error('[A FAIL] Media:', mr.status); userMessageText='[Customer ne voice bheja]'; }
              else {
                const md = await mr.json().catch(()=>({}));
                if (!md?.url) { console.error('[A FAIL] No URL'); userMessageText='[Customer ne voice bheja]'; }
                else {
                  const ar = await fetch(md.url, {headers:{'Authorization':`Bearer ${WHATSAPP_TOKEN}`}});
                  if (!ar.ok) { console.error('[A FAIL] Audio download:', ar.status); userMessageText='[Customer ne voice bheja]'; }
                  else {
                    const buf = await ar.arrayBuffer();
                    const fd  = new globalThis.FormData();
                    fd.append('file', new globalThis.Blob([buf],{type:'audio/ogg'}), 'voice.ogg');
                    fd.append('model', 'whisper-large-v3-turbo');
                    fd.append('language', 'ur');
                    // [G2] Updated prompt: explicitly includes Faisalabad to prevent Faizabad error
                    fd.append('prompt', 'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad), لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');
                    const gr = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                      method:'POST', headers:{'Authorization':`Bearer ${GROQ_API_KEY}`}, body:fd
                    });
                    if (gr.ok) {
                      const gd = await gr.json().catch(()=>({}));
                      userMessageText = fixCityNames((gd.text||'').trim()); // [G2] fix after transcription
                      console.log('[A SUCCESS] len:', userMessageText.length, '| text:', userMessageText.slice(0,60));
                    } else {
                      console.error('[A FAIL] Groq STT:', gr.status);
                      userMessageText='[Customer ne voice bheja]';
                    }
                  }
                }
              }
            }
          } else if (message.type==='image')    { userMessageText='[Customer ne image bheji]'; }
            else if (message.type==='sticker')  { userMessageText='[Customer ne sticker bheja — friendly acknowledgment]'; }
            else if (message.type==='document') { userMessageText='[Customer ne document bheja]'; }
            else                                { userMessageText='[Customer ne kuch bheja]'; }

          if (!userMessageText.trim()) userMessageText='السلام علیکم';

          // ── Load history ──────────────────────────────────────────────
          const history = getHistory(fromNumber);
          const historyGemini = [
            ...history,
            { role:'user', parts:[{ text:(customerName?`Customer name: ${customerName}\n`:'')+`Message:\n${userMessageText}` }] }
          ];
          const historyOAI = [
            { role:'system', content:SYSTEM_PROMPT },
            ...history.map(c=>({ role:c.role==='model'?'assistant':'user', content:c.parts?.[0]?.text||'' })),
            { role:'user', content:(customerName?`Customer name: ${customerName}\n`:'')+`Message:\n${userMessageText}` }
          ];

          let aiReply = '', usedProvider = '';

          // ══════════════════════════════════════════════════════════════
          // STEP B: 5-TIER PROVIDER CHAIN
          // ══════════════════════════════════════════════════════════════

          // Tier 1+2: Gemini
          if (!aiReply && GEMINI_API_KEY) {
            for (const model of ['gemini-3.7-flash','gemini-3.6-flash']) {
              if (aiReply) break;
              if (isBlocked(`g:${model}`)) { console.warn(`[SKIP] g:${model}`); continue; }
              for (let att=1; att<=2; att++) {
                if (aiReply) break;
                const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),20000);
                try {
                  console.log(`[B] g:${model} att${att}`);
                  const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                    { method:'POST', headers:{'Content-Type':'application/json'}, signal:ctrl.signal,
                      body:JSON.stringify({ system_instruction:{parts:[{text:SYSTEM_PROMPT}]}, contents:historyGemini,
                        generationConfig:{temperature:0.7, maxOutputTokens:att===1?800:650} }) }
                  );
                  if (r.ok) {
                    const d=await r.json().catch(()=>({}));
                    const raw=d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (raw) { aiReply=raw.replace(/[*_~`#]/g,'').trim(); usedProvider=`g:${model}`; }
                    console.log(`[B OK] g:${model} att${att}`); break;
                  }
                  if (r.status===429) { blockFor(`g:${model}`,5*60*1000); break; }
                  if (r.status===503&&att<2) { await sleep(4000); continue; }
                  console.error(`[B FAIL] g:${model} ${r.status}`); break;
                } catch(e) {
                  const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort');
                  if (abort&&att<2) { await sleep(2000); continue; }
                  console.error(`[B EXC] g:${model}:`,e?.message); break;
                } finally { clearTimeout(t); }
              }
            }
          }

          // Tier 3: Cerebras
          if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cb')) {
            for (let att=1; att<=2; att++) {
              if (aiReply) break;
              try {
                console.log(`[B] cerebras att${att}`);
                const r=await openaiChat({baseUrl:'https://api.cerebras.ai/v1',apiKey:CEREBRAS_API_KEY,model:'llama-3.3-70b',messages:historyOAI});
                if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider='cerebras';} console.log('[B OK] cerebras'); break; }
                if (r.status===429) { blockFor('cb',5*60*1000); break; }
                if (r.status===503&&att<2) { await sleep(4000); continue; }
                console.error(`[B FAIL] cerebras ${r.status}`); break;
              } catch(e) { const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort'); if(abort&&att<2){await sleep(2000);continue;} console.error('[B EXC] cerebras:',e?.message); break; }
            }
          }

          // Tier 4: Groq
          if (!aiReply && GROQ_API_KEY) {
            for (const gm of ['openai/gpt-oss-120b','qwen/qwen3.6-27b']) {
              if (aiReply) break;
              if (isBlocked(`gr:${gm}`)) continue;
              try {
                console.log(`[B] groq:${gm}`);
                const r=await openaiChat({baseUrl:'https://api.groq.com/openai/v1',apiKey:GROQ_API_KEY,model:gm,messages:historyOAI});
                if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider=`groq:${gm}`;} console.log(`[B OK] groq:${gm}`); break; }
                if (r.status===429) { blockFor(`gr:${gm}`,5*60*1000); break; }
                console.error(`[B FAIL] groq:${gm} ${r.status}`); break;
              } catch(e) { console.error(`[B EXC] groq:${gm}:`,e?.message); break; }
            }
          }

          // Tier 5: OpenRouter
          if (!aiReply && OPENROUTER_API_KEY && !isBlocked('or')) {
            for (const orm of ['mistralai/mistral-7b-instruct:free','meta-llama/llama-3.1-8b-instruct:free']) {
              if (aiReply) break;
              if (isBlocked(`or:${orm}`)) continue;
              try {
                console.log(`[B] openrouter:${orm}`);
                const r=await openaiChat({baseUrl:'https://openrouter.ai/api/v1',apiKey:OPENROUTER_API_KEY,model:orm,messages:historyOAI});
                if (r.ok) { const d=await r.json().catch(()=>({})); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw){aiReply=raw.replace(/[*_~`#]/g,'').trim();usedProvider=`or:${orm}`;} console.log(`[B OK] or:${orm}`); break; }
                if (r.status===429) { blockFor(`or:${orm}`,5*60*1000); break; }
                console.error(`[B FAIL] or:${orm} ${r.status}`); break;
              } catch(e) { console.error(`[B EXC] or:${orm}:`,e?.message); break; }
            }
          }

          if (!aiReply) {
            aiReply='Thori dair mein wapas aati hoon, abhi system thoda busy hai. Shukriya sabr ka 🙏';
            console.warn('[B FALLBACK] All providers failed.');
          } else {
            console.log(`[B DONE] provider=${usedProvider}`);
          }

          // [G1] Extract and save order to Google Sheets
          const orderTag = parseOrderTag(aiReply);
          if (orderTag && GOOGLE_SHEETS_ID) {
            console.log('[SHEETS] Order detected:', JSON.stringify(orderTag));
            aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim(); // remove tag from reply
            saveOrderToSheet({
              sheetsId: GOOGLE_SHEETS_ID,
              saEmail:  GOOGLE_SA_EMAIL,
              saKey:    GOOGLE_SA_KEY,
              orderData: { ...orderTag, phone: fromNumber, customerName: orderTag.name||customerName }
            }).catch(e=>console.error('[SHEETS] Async error:', e.message));
          }

          // [G2] Apply city name correction to AI reply too
          aiReply = fixCityNames(aiReply);

          // Extract routing tag [VOICE]/[TEXT]
          let sendVoice = false;
          const lines   = aiReply.trim().split('\n');
          const lastFew = lines.slice(-3).map(l=>l.trim().toUpperCase());
          const hasVoice= lastFew.some(l=>l==='[VOICE]');
          const hasText = lastFew.some(l=>l==='[TEXT]');
          if (hasVoice||hasText) {
            let cut=lines.length;
            for (let i=lines.length-1;i>=0;i--) { const u=lines[i].trim().toUpperCase(); if(u==='[VOICE]'||u==='[TEXT]'||u==='') cut=i; else break; }
            aiReply=lines.slice(0,cut).join('\n').trim();
            if (!isAudioIncoming) { sendVoice=false; console.log('[ROUTE] Text→TEXT'); }
            else if (hasVoice)    { sendVoice=true;  console.log('[ROUTE] Uneducated→VOICE'); }
            else                  { sendVoice=false; console.log('[ROUTE] Educated→TEXT'); }
          } else { sendVoice=isAudioIncoming; console.log('[ROUTE] Default:', sendVoice?'VOICE':'TEXT'); }

          if (!aiReply.trim()) aiReply='Thori dair mein wapas aati hoon. Shukriya 🙏';

          // Save to history
          history.push({role:'user', parts:[{text:userMessageText}]});
          history.push({role:'model',parts:[{text:aiReply}]});
          if (history.length>MAX_HISTORY) history.splice(0,history.length-MAX_HISTORY);

          // ── STEP C: ElevenLabs TTS ────────────────────────────────────
          let voiceSent=false;
          if (sendVoice&&ELEVENLABS_API_KEY&&ELEVENLABS_VOICE_ID&&WHATSAPP_TOKEN&&PHONE_NUMBER_ID) {
            try {
              console.log('[C] TTS...');
              const tts=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,{
                method:'POST', headers:{'xi-api-key':ELEVENLABS_API_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
                body:JSON.stringify({text:aiReply,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.75}})
              });
              if (tts.ok) {
                const buf=await tts.arrayBuffer(), mfd=new globalThis.FormData();
                mfd.append('messaging_product','whatsapp');
                mfd.append('file',new globalThis.Blob([buf],{type:'audio/mpeg'}),'voice.mp3');
                mfd.append('type','audio/mpeg');
                const up=await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,{method:'POST',headers:{'Authorization':`Bearer ${WHATSAPP_TOKEN}`},body:mfd});
                const ud=await up.json().catch(()=>({}));
                if (up.ok&&ud?.id) {
                  const vr=await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,{
                    method:'POST',headers:{'Authorization':`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},
                    body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:fromNumber,type:'audio',audio:{id:ud.id}})
                  });
                  if (vr.ok) { voiceSent=true; console.log('[C SUCCESS]'); }
                  else console.error('[C FAIL] Send:', vr.status);
                } else console.error('[C FAIL] Upload:', up.status);
              } else if (tts.status===429) { console.warn('[C] ElevenLabs 429→text'); }
              else console.error('[C FAIL] ElevenLabs:', tts.status);
            } catch(e) { console.error('[C ERR]:', e.message); }
          }

          // ── STEP D: Text reply ────────────────────────────────────────
          if (!voiceSent&&WHATSAPP_TOKEN&&PHONE_NUMBER_ID) {
            const tr=await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,{
              method:'POST', headers:{'Authorization':`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},
              body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:fromNumber,type:'text',text:{preview_url:false,body:aiReply}})
            });
            if (tr.ok) console.log('[D SUCCESS] id:', messageId||'n/a');
            else { const e=await tr.text().catch(()=>''); console.error('[D FAIL]', tr.status, e.slice(0,120)); }
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
