// ─────────────────────────────────────────────────────────────────────────────
//   WhatsApp Webhook — Fatima Arts / Zara AI Agent
//   BASE: Fully Audited Production Version (Max Tokens 8192 + Neon DB + Sheets)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Circuit breaker — per model, in-memory ───────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = k      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) { global._cb.clear(); console.log('[CB] Midnight reset — quota refilled'); }
  } catch (_) {}
}

// Deduplication store
if (!global._dedup) global._dedup = new Map();
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v <= now) global._dedup.delete(k);
  if ((global._dedup.get(msgId)||0) > now) return true;
  global._dedup.set(msgId, now + 10*60*1000); // 10 min TTL
  return false;
}

// ── Neon DB — Persistent Memory ──────────────────────────────────────────────
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
  _dbCache.set(phone, {history, customerName});
  const sql = getSql(dbUrl); if (!sql) return;
  try {
    const trimmedHistory = history.slice(-20);
    const historyJson = JSON.stringify(trimmedHistory);
    await sql`
      INSERT INTO zara_conversations(phone_number, customer_name, history, last_seen, msg_count) 
      VALUES (${phone}, ${customerName || ''}, ${historyJson}::jsonb, NOW()::timestamptz, ${history.length}) 
      ON CONFLICT(phone_number) 
      DO UPDATE SET 
        customer_name = EXCLUDED.customer_name, 
        history = EXCLUDED.history, 
        last_seen = NOW()::timestamptz, 
        msg_count = EXCLUDED.msg_count
    `;
    console.log('[DB SAVE] Success for:', phone);
  } catch(e) { 
    console.error('[DB SAVE ERROR DETAIL]:', e.message, e.detail || ''); 
  }
}

const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()] || w) : t;

// ── Google Sheets via Apps Script Web App ─────────────────────────────────────
async function saveToSheet(webAppUrl, order, phone) {
  if (!webAppUrl) {
    console.error('[SHEET ERROR] SHEET_WEB_APP_URL is missing in environment variables!');
    return;
  }
  try {
    const payload = {
      timestamp: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }),
      name: order.name || 'N/A',
      phone: phone || 'N/A',
      product: order.product || 'N/A',
      qty: order.qty || '1',
      price: order.price || '3600',
      payment: order.payment || 'COD',
      address: order.address || 'N/A',
      city: order.city || 'Faisalabad',
      status: 'Pending'
    };

    const response = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const resText = await response.text();
    console.log('[SHEET] Order successfully saved via Web App ✓', resText);
  } catch(e) { 
    console.error('[SHEET EXCEPTION]:', e.message); 
  }
}

function parseOrderTag(text) {
  const m=text.match(/\[ORDER:([^\]]+)\]/i); if(!m) return null;
  const o={};
  for(const p of m[1].split('|')){const[k,...v]=p.split('=');if(k&&v.length)o[k.trim().toLowerCase()]=v.join('=').trim();}
  return Object.keys(o).length?o:null;
}

function getPKT() {
  try {
    const p={};
    for(const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT unavailable'; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function oaiChat({url,key,model,messages,maxTokens=8192,timeout=20000}) {
  const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),timeout);
  try { return await fetch(`${url}/chat/completions`,{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.7,max_tokens:maxTokens})}); }
  finally { clearTimeout(t); }
}

const chatHistories = new Map();

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();

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
  const DATABASE_URL        = (process.env.DATABASE_URL        || '').trim();
  const SHEET_WEB_APP_URL   = (process.env.SHEET_WEB_APP_URL   || '').trim();

  const SYSTEM_PROMPT = `You are Zara — a warm, human-speaking boutique staff member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI or automation.

CURRENT TIME (Asia/Karachi): ${getPKT()}

=== IDENTITY & TONE ===
- Name: Zara — Fatima Arts team member
- Tone: Extremely warm, polite, natural Pakistani boutique sales representative style.
- Use customer's name respectfully when available.
- Max 2 emojis per message. Keep sentences clear and complete (do not cut off mid-sentence).

=== LANGUAGE & TALFUZ (STRICT ROMAN URDU) ===
- Main Language: **Pure, natural Roman Urdu** only. Speak fluently like a real local person in Faisalabad/Lahore.
- **NEVER WRITE ENGLISH SENTENCES.** Do not switch to English.

=== ORDER & FABRIC ACKNOWLEDGMENT (CRITICAL) ===
- **Mandatory Fabric Check:** Whenever the customer mentions a fabric or clothing item (e.g., marina, lawn, khaddar, suit), you MUST immediately acknowledge and confirm it in your reply. Never ignore what the customer asked or chose!
- **Memory Retention:** Always remember what the customer asked in previous messages. Never ask for details already provided.
- **Step-by-Step Order Flow:** If customer wants to order, collect missing details one by one smoothly:
  1. Product & Color confirmation
  2. Quantity
  3. Full Delivery Address & City
  4. Payment Method (COD / JazzCash / EasyPaisa)
- **Order Tag:** Only generate the \`[ORDER:...]\` tag when ALL required details are fully confirmed.

=== CITY NAMES ===
⚠️ Faisalabad (NOT Faizabad) — always spell correctly.

=== PRODUCTS (UNSTITCHED) ===
1. Lawn/Printed, 2. Embroidered, 3. Linen/Khaddar, 4. Kotail, 5. Karandi, 6. Marina, 7. Velvet, 8. Dhanak.
Prices: Retail 1 suit = PKR 3,600 + delivery. Wholesale min 10 suits = PKR 2,999/suit.

=== PAYMENT & DELIVERY ===
- JazzCash: ${JAZZCASH_NUMBER || 'boss se confirm karein'}
- EasyPaisa: ${EASYPAISA_NUMBER || 'boss se confirm karein'}
- Delivery: City 1-2 days, Outside 3-5 days.

If order fully confirmed, include this tag on its own line:
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]`;

  if (req.method === 'GET') {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host     = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url      = new URL(req.url, `${protocol}://${host}`);
    const mode     = url.searchParams.get('hub.mode');
    const token    = url.searchParams.get('hub.verify_token');
    const challenge= url.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

    const entry   = body?.entry?.[0];
    const value   = entry?.changes?.[0]?.value;
    const messages= Array.isArray(value?.messages) ? value.messages : [];
    const contacts= Array.isArray(value?.contacts) ? value.contacts : [];

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return res.status(200).send('EVENT_RECEIVED');

    try {
      const message = messages[0];
      if (!message) return res.status(200).send('EVENT_RECEIVED');

      const msgId = message?.id;
      if (alreadyProcessed(msgId)) return res.status(200).send('EVENT_RECEIVED');

      const fromNumber = message.from;
      if (!fromNumber) return res.status(200).send('EVENT_RECEIVED');

      const isAudioIncoming = message.type === 'audio' || message.type === 'voice';
      const contact       = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
      const customerName    = (contact?.profile?.name || '').trim();

      let userMessageText = '';

      if (message.type === 'text') {
        userMessageText = fixCities(message.text?.body || '');
      } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
        const mediaId = message.audio?.id || message.voice?.id;
        if (!mediaId) {
          userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
        } else {
          const mediaRes  = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
          if (mediaRes.ok) {
            const mediaData = await mediaRes.json();
            if (mediaData.url) {
              const audioStream = await fetch(mediaData.url, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
              const arrayBuffer = await audioStream.arrayBuffer();
              const formData = new globalThis.FormData();
              formData.append('file',     new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' }), 'voice.ogg');
              formData.append('model',    'whisper-large-v3-turbo');
              formData.append('language', 'ur');
              formData.append('prompt',   'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، پاکستانی گاہک، کپڑے کی دکان');

              const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method:  'POST',
                headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
                body:    formData
              });
              if (groqRes.ok) {
                const groqData  = await groqRes.json();
                userMessageText = fixCities((groqData.text || '').trim());
              }
            }
          }
        }
      }
      if (!userMessageText.trim()) userMessageText = 'السلام علیکم';

      let history = [];
      const dbData = await dbGet(DATABASE_URL, fromNumber);
      if (dbData && Array.isArray(dbData.history)) {
        history = dbData.history;
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

      if (!aiReply && GEMINI_API_KEY) {
        for (const model of ['gemini-3.7-flash', 'gemini-3.6-flash']) {
          if (aiReply) break;
          const cbKey = `g:${model}`;
          if (isBlocked(cbKey)) continue;

          for (let attempt = 1; attempt <= 2; attempt++) {
            if (aiReply) break;
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 20000);
            try {
              const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                { method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal,
                  body:JSON.stringify({system_instruction:{parts:[{text:SYSTEM_PROMPT}]},contents:geminiContents,generationConfig:{temperature:0.7,maxOutputTokens:8192}}) }
              );
              if (r.ok) {
                const d   = await r.json();
                const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (raw) aiReply = raw.replace(/[*_~`#]/g,'').trim();
                break;
              }
              if (r.status === 429) { blockFor(cbKey, 5*60*1000); break; }
              if (r.status === 503 && attempt < 2) { await sleep(2000); continue; }
              break;
            } catch(e) {
              if (attempt < 2) { await sleep(2000); continue; }
              break;
            } finally { clearTimeout(timeoutId); }
          }
        }
      }

      if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cerebras')) {
        try {
          const r = await oaiChat({url:'https://api.cerebras.ai/v1',key:CEREBRAS_API_KEY,model:'llama-3.3-70b',messages:oaiMessages,maxTokens:8192});
          if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); }
          else if (r.status===429) blockFor('cerebras',5*60*1000);
        } catch(e) {}
      }

      if (!aiReply) aiReply = 'Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏';

      const orderTag = parseOrderTag(aiReply);
      if (orderTag) {
        aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi, '').trim();
        saveToSheet(SHEET_WEB_APP_URL, orderTag, fromNumber).catch(()=>{});
      }

      aiReply = fixCities(aiReply);
      if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

      history.push({ role: 'user',  parts: [{ text: userMessageTest }] });
      history.push({ role: 'model', parts: [{ text: aiReply }] });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

      chatHistories.set(fromNumber, history);
      dbSave(DATABASE_URL, fromNumber, customerName, history).catch(()=>{});

      let voiceSentSuccess = false;

      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        try {
          const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
            method:  'POST',
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
            body: JSON.stringify({ text: aiReply, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.75, similarity_boost: 0.85 } })
          });

          if (ttsRes.ok) {
            const audioBuffer = await ttsRes.arrayBuffer();
            const audioBlob   = new globalThis.Blob([audioBuffer], { type: 'audio/mpeg' });

            const mediaFormData = new globalThis.FormData();
            mediaFormData.append('messaging_product', 'whatsapp');
            mediaFormData.append('file', audioBlob, 'response.mp3');
            mediaFormData.append('type', 'audio/mpeg');

            const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
              method:  'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
              body:    mediaFormData
            });

            if (uploadRes.ok) {
              const uploadData = await uploadRes.json();
              const mediaId = uploadData?.id;

              if (mediaId) {
                const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                  method:  'POST',
                  headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: fromNumber, type: 'audio', audio: { id: mediaId } })
                });

                if (sendVoiceRes.ok) voiceSentSuccess = true;
              }
            }
          }
        } catch (e) {}
      }

      if (!voiceSentSuccess) {
        await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ messaging_product: 'whatsapp', to: fromNumber, type: 'text', text: { body: aiReply } })
        });
      }

    } catch (err) {
      console.error('[PROCESS ERROR]', err);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(200).send('Method Not Allowed');
};
