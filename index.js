// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent (Fully Audited & Fixed)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Vercel waitUntil ──────────────────────────────────────────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── Circuit Breaker ───────────────────────────────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = k      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

// ── Midnight PKT Reset ────────────────────────────────────────────────        
function midnightReset() {
  try {
    const pkt = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Karachi', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date());
    const [h,m] = pkt.split(':').map(Number);
    if (h===0 && m<=5 && global._cb.size>0) { global._cb.clear(); console.log('[CB] Midnight PKT reset — quota refilled'); }
  } catch (_) {}
}

// ── Deduplication ─────────────────────────────────────────────────────────────
if (!global._dedup) global._dedup = new Map();
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (global._dedup.size > 500) for (const [k,v] of global._dedup) if (v <= now) global._dedup.delete(k);
  if ((global._dedup.get(msgId)||0) > now) return true;
  global._dedup.set(msgId, now + 10*60*1000);
  return false;
}

// ── Neon DB Persistent Memory ─────────────────────────────────────────────────
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

// ── City Name Correction ──────────────────────────────────────────────────────
const CITY_FIX = {
  faizabad:'Faisalabad', faizaabad:'Faisalabad', faisalabaad:'Faisalabad',
  faisalbad:'Faisalabad', fisalabad:'Faisalabad', lahroe:'Lahore',
  lhaore:'Lahore', karaachi:'Karachi', karachy:'Karachi',
  rwalpindi:'Rawalpindi', gujranwla:'Gujranwala',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()]||w) : t;

// ── Google Sheets Integration (Fixed Endpoint & Auth) ─────────────────────────
let _gTok = {token:null, exp:0};
async function getGToken(email, key) {
  if (_gTok.token && Date.now() < _gTok.exp-300000) return _gTok.token;
  try {
    const now=Math.floor(Date.now()/1000), b64=s=>Buffer.from(s).toString('base64url');
    const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const p=b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    
    const formattedKey = key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;

    const s=crypto.createSign('RSA-SHA256'); 
    s.update(`${h}.${p}`);
    const sig=s.sign(formattedKey,'base64url');

    const r=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${sig}`
    });
    const d=await r.json();
    if (d.access_token) { _gTok={token:d.access_token,exp:Date.now()+(d.expires_in||3600)*1000}; return _gTok.token; }
    else { console.error('[GTOKEN ERROR RESPONSE]', JSON.stringify(d)); }
  } catch(e) { console.error('[GTOKEN EXCEPTION]',e.message); }
  return null;
}

function parseOrderTag(text) {
  if (!text) return null;
  const m = text.match(/\[ORDER:\s*([^\]]+)\]/i);
  if (!m) {
    console.warn('[SHEET WARN] AI response did not include [ORDER:...] tag. Response was:', text.slice(0, 150));
    return null;
  }
  const o = {};
  for (const p of m[1].split('|')) {
    const eqIdx = p.indexOf('=');
    if (eqIdx !== -1) {
      const k = p.slice(0, eqIdx).trim().toLowerCase();
      const v = p.slice(eqIdx + 1).trim();
      if (k) o[k] = v;
    }
  }
  return Object.keys(o).length ? o : null;
}

async function saveToSheet(sid, email, key, order, phone) {
  if(!sid||!email||!key) {
    console.error('[SHEET] Missing configuration parameters (sid, email, or key).');
    return;
  }
  try {
    const tok=await getGToken(email,key); 
    if(!tok) {
      console.error('[SHEET] Failed to acquire Google OAuth token.');
      return;
    }

    const orderId = `FA-${Math.floor(100000 + Math.random() * 900000)}`;
    const currentDate = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

    const row = [
      orderId,
      currentDate,
      '',
      order.name || 'Valued Customer',
      phone || '',
      order.product || 'Unstitched Suit',
      order.qty || '1',
      order.size || 'Unstitched',
      order.city || '',
      order.payment || 'COD'
    ];

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Sheet1!A1:J:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    });

    if(res.ok) {
      console.log('[SHEET] Order successfully saved to Google Sheet ✓ ID:', orderId);
    } else {
      const errText = await res.text();
      console.error('[SHEET FAIL]', res.status, errText);
    }
  } catch(e) { 
    console.error('[SHEET EXCEPTION]', e.message); 
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPKT() {
  try {
    const p={};
    for(const x of new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Karachi',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date())) p[x.type]=x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch(e) { return 'PKT unavailable'; }
}

const chatHistories = new Map();

// ── Cascading AI Reply Engine (Gemini -> Groq Fallback) ──────────────────────
async function getAiReply(systemInstruction, history, userMessage) {
  let aiReply = null;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;

  const geminiContents = [
    ...history,
    { role:'user', parts:[{ text:userMessage }] }
  ];

  // Tier 1: Gemini 2.0 Flash
  if (!aiReply && GEMINI_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction:{parts:[{text:systemInstruction}]}, contents:geminiContents, generationConfig:{temperature:0.7, maxOutputTokens:800} }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await res.json();
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (raw) aiReply = raw;
    } catch(e) { console.error('[GEMINI 2.0 ERR]:', e.message); }
  }

  // Tier 2: Gemini 1.5 Flash
  if (!aiReply && GEMINI_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction:{parts:[{text:systemInstruction}]}, contents:geminiContents, generationConfig:{temperature:0.7, maxOutputTokens:800} }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await res.json();
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (raw) aiReply = raw;
    } catch(e) { console.error('[GEMINI 1.5 ERR]:', e.message); }
  }

  // Tier 3: Groq Llama 3.3 Versatile
  if (!aiReply && GROQ_KEY) {
    try {
      const oaiMessages = [
        { role: 'system', content: systemInstruction },
        ...history.map(c => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts?.[0]?.text || '' })),
        { role: 'user', content: userMessage }
      ];
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: oaiMessages, temperature: 0.7 }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await res.json();
      const raw = d.choices?.[0]?.message?.content?.trim();
      if (raw) aiReply = raw;
    } catch(e) { console.error('[GROQ ERR]:', e.message); }
  }

  // Tier 4: Safe Fallback
  if (!aiReply) {
    aiReply = "Ji, main aap ki baat sun rahi hoon. Baraye meharbani apna sawal ya order details dobara bhejiye taake main foran process kar sakoon! 🙏";
  }

  return aiReply.replace(/[*_~`#]/g,'').trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN VERCEL EXPORT FUNCTION
// ═════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();

  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      ||'').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     ||'').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        ||'').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        ||'').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  ||'').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID ||'21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     ||'confirm').trim();
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    ||'confirm').trim();
  const DATABASE_URL        = (process.env.DATABASE_URL        ||'').trim();
  const GOOGLE_SHEETS_ID    = (process.env.GOOGLE_SHEETS_ID    ||'').trim();
  const GOOGLE_SA_EMAIL     = (process.env.GOOGLE_SA_EMAIL     ||'').trim();
  const GOOGLE_SA_KEY       = (process.env.GOOGLE_SA_KEY       ||'').trim();

  const SYSTEM_PROMPT = `آپ زارہ ہیں — فاطمہ آرٹس (Fatima Arts) کی گرم جوش سیلز ایجنٹ، پاکستان کا ایک premium unstitched fabric brand۔ آپ روبوٹ نہیں ہیں۔ کبھی AI، automation یا software کا ذکر نہ کریں۔

ابھی کا وقت (PKT): ${getPKT()}

=== زبان اور جواب کا طریقہ ===
🔴 DEFAULT زبان: ہمیشہ اردو script میں جواب دیں
1. Customer اردو script میں لکھے → اردو script میں جواب دیں ✅
2. Customer Roman Urdu میں لکھے → Roman Urdu میں جواب دیں ✅
3. Customer English میں لکھے → English میں جواب دیں ✅
4. Customer voice note بھیجے → transcribed text کی زبان دیکھ کر جواب دیں ✅

=== شہروں کے نام (لازمی درست لکھیں) ===
⚠️ Faisalabad (کبھی Faizabad یا Faizaabad نہیں لکھنا)
Lahore • Karachi • Islamabad • Rawalpindi • Multan • Gujranwala • Peshawar • Quetta

=== پہچان ===
نام: زارہ — فاطمہ آرٹس ٹیم ممبر
لہجہ: گرم، دوستانہ، پیشہ ورانہ
قیمت: ریٹیل 3,600 روپے/سوٹ | ہول سیل (10+ سوٹ) 2,999/سوٹ
ادائیگی: JazzCash (${JAZZCASH_NUMBER}) | EasyPaisa (${EASYPAISA_NUMBER}) | COD

⚠️ انتہائی اہم ہدایت (آرڈر سیو کرنے کے لیے):
جب customer اپنا نام، فون، مکمل پتہ (address)، اور شہر (city) بتا کر آرڈر confirm کرے، تو آپ کے جواب کے آخر میں یہ ٹیگ لازمی ہونا چاہیے (اس کے بغیر آرڈر گوگل شیٹ میں سیو نہیں ہوگا):
[ORDER:name=CustomerName|product=Product Name|qty=1|price=3600|payment=COD|address=Full Address|city=CityName]`;

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

    if (!messages.length) return res.status(200).send('EVENT_RECEIVED');
    if (!WHATSAPP_TOKEN||!PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        const message = messages[0];
        if (!message) return;

        if (alreadyProcessed(message?.id)) {
          console.log('[DEDUP] Skip:', message?.id);
          return;
        }

        const fromNumber = message.from;
        if (!fromNumber) { console.error('[ERROR] message.from missing'); return; }

        const isAudioIncoming = message.type==='audio' || message.type==='voice';
        const contact       = contacts.find(c=>c?.wa_id===fromNumber)||contacts[0]||null;
        const customerName    = (contact?.profile?.name||'').trim();

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

        if (message.type==='text') {
          userMessageText = fixCities(message.text?.body||'');
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
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              const mediaData = await mediaRes.json();
              if (!mediaData?.url) {
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const audioStream = await fetch(mediaData.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                const arrayBuffer = await audioStream.arrayBuffer();

                const formData = new globalThis.FormData();
                const blob     = new globalThis.Blob([arrayBuffer], { type:'audio/ogg' });
                formData.append('file',     blob, 'voice.ogg');
                formData.append('model',    'whisper-large-v3-turbo');
                formData.append('language', 'ur');
                formData.append('prompt', 'فاطمہ آرٹس، زارہ، فیصل آباد Faisalabad (NOT Faizabad)، لاہور Lahore، کراچی Karachi، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری');

                const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                  method:'POST', headers:{ Authorization: `Bearer ${GROQ_API_KEY}` }, body: formData
                });
                if (groqRes.ok) {
                  const groqData  = await groqRes.json();
                  userMessageText = fixCities((groqData.text||'').trim());
                } else {
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

        const contextualUserMsg = customerName ? `Customer name: ${customerName}\n${userMessageText}` : userMessageText;

        // Get AI Reply using Cascading Engine
        let aiReply = await getAiReply(SYSTEM_PROMPT, history, contextualUserMsg);

        // Parse and save order
        const orderTag = parseOrderTag(aiReply);
        if (orderTag) {
          aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi,'').trim();
          await saveToSheet(GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, orderTag, fromNumber);
        }

        aiReply = fixCities(aiReply);
        if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

        history.push({ role:'user',  parts:[{ text:userMessageText }] });
        history.push({ role:'model', parts:[{ text:aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length-MAX_HISTORY);

        chatHistories.set(fromNumber, history);
        dbSave(DATABASE_URL, fromNumber, customerName, history).catch(()=>{});

        // ── ElevenLabs TTS & WhatsApp Delivery ────────────────────────────────
        let voiceSentSuccess = false;

        if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] ElevenLabs TTS...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method:'POST',
              headers: { 'xi-api-key':ELEVENLABS_API_KEY, 'Content-Type':'application/json', 'Accept':'audio/mpeg' },
              body: JSON.stringify({
                text:           aiReply,
                model_id:       'eleven_flash_v2_5',
                voice_settings: { stability:0.75, similarity_boost:0.85, style:0.4, use_speaker_boost:true }
              })
            });

            if (!ttsRes.ok) {
              const errText = await ttsRes.text();
              console.error('[ELEVENLABS FAIL]', ttsRes.status, errText);
            } else {
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
                  body: JSON.stringify({ messaging_product:'whatsapp', recipient_type:'individual', to:fromNumber, type:'audio', audio:{ id:uploadData.id } })
                });
                if (sendVoiceRes.ok) {
                  voiceSentSuccess = true;
                  console.log('[STEP C SUCCESS] Voice note sent!');
                } else {
                  const sendErr = await sendVoiceRes.text();
                  console.error('[WHATSAPP VOICE SEND FAIL]', sendVoiceRes.status, sendErr);
                }
              } else {
                console.error('[WHATSAPP MEDIA UPLOAD FAIL]', JSON.stringify(uploadData));
              }
            }
          } catch(e) {
            console.error('[STEP C EXC]', e.message);
          }
        }

        if (!voiceSentSuccess) {
          await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method:'POST',
            headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
            body: JSON.stringify({ messaging_product:'whatsapp', recipient_type:'individual', to:fromNumber, type:'text', text:{ body:aiReply } })
          });
          console.log('[TEXT FALLBACK] Message sent as text.');
        }

      } catch(err) {
        console.error('[BACKGROUND ERROR]', err);
      }
    })();

    if (waitUntilFn) {
      waitUntilFn(processPromise);
      return res.status(200).send('EVENT_RECEIVED');
    } else {
      try { await processPromise; } catch(e) {}
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
