// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent (Strict Multilingual Version)
//  Required Env Vars:
//  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN
//  GEMINI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
//  JAZZCASH_NUMBER, EASYPAISA_NUMBER, DATABASE_URL
//  GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Vercel waitUntil ──────────────────────────────────────────────────────────
let waitUntilFn = null;
try { const vf = require('@vercel/functions'); if (vf?.waitUntil) waitUntilFn = vf.waitUntil; } catch (_) {}

// ── Circuit breaker ───────────────────────────────────────────────────────────
if (!global._cb) global._cb = new Map();
const isBlocked = k      => Date.now() < (global._cb.get(k) || 0);
const blockFor  = (k, ms) => { global._cb.set(k, Date.now() + ms); console.warn(`[CB] ${k} blocked ${Math.round(ms/1000)}s`); };

// ── Midnight PKT reset ────────────────────────────────────────────────────────
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

// ── Neon DB persistent memory ────────────────────────────────────────────────
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

// ── City name correction ──────────────────────────────────────────────────────
const CITY_FIX = {
  faizabad:'فیصل آباد', faizaabad:'فیصل آباد', faisalabaad:'فیصل آباد',
  faisalbad:'فیصل آباد', fisalabad:'فیصل آباد', lahroe:'لاہور',
  lhaore:'لاہور', karaachi:'کراچی', karachy:'کراچی',
  rwalpindi:'راولپنڈی', gujranwla:'گوجرانوالہ',
};
const fixCities = t => t ? t.replace(/\b([A-Za-z]+)\b/g, w => CITY_FIX[w.toLowerCase()]||w) : t;

// ── Google Sheets ─────────────────────────────────────────────────────────────
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

const chatHistories = new Map();

// ═════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  if (req.url?.includes('favicon.ico')) return res.status(204).end();
  midnightReset();

  const WHATSAPP_TOKEN     = (process.env.WHATSAPP_TOKEN     ||'').trim();
  const PHONE_NUMBER_ID    = (process.env.PHONE_NUMBER_ID    ||'').trim();
  const VERIFY_TOKEN       = (process.env.VERIFY_TOKEN       ||'').trim();
  const GEMINI_API_KEY     = (process.env.GEMINI_API_KEY     ||'').trim();
  const GROQ_API_KEY       = (process.env.GROQ_API_KEY       ||'').trim();
  const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY ||'').trim();
  const ELEVENLABS_VOICE_ID= (process.env.ELEVENLABS_VOICE_ID||'EXAVITQu4vr4xnSDxMaL').trim();
  const JAZZCASH_NUMBER    = (process.env.JAZZCASH_NUMBER    ||'').trim();
  const EASYPAISA_NUMBER   = (process.env.EASYPAISA_NUMBER   ||'').trim();
  const CEREBRAS_API_KEY   = (process.env.CEREBRAS_API_KEY   ||'').trim();
  const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ||'').trim();
  const DATABASE_URL       = (process.env.DATABASE_URL       ||'').trim();
  const GOOGLE_SHEETS_ID   = (process.env.GOOGLE_SHEETS_ID   ||''.trim());
  const GOOGLE_SA_EMAIL    = (process.env.GOOGLE_SA_EMAIL    ||'').trim();
  const GOOGLE_SA_KEY      = (process.env.GOOGLE_SA_KEY      ||'').trim();

  // ── GET: Webhook Verification ───────────────────────────────────────────
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

  // ── POST: Message Handler ────────────────────────────────────────────────
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
        const contact         = contacts.find(c=>c?.wa_id===fromNumber)||contacts[0]||null;
        const customerName    = (contact?.profile?.name||'').trim();

        // ── Load history ───────────────────────────────────────────────
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
          userMessageText = fixCities(message.text?.body||'');

        } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
          console.log('[STEP A] Fetching audio from Meta...');
          const mediaId = message.audio?.id || message.voice?.id;

          if (!mediaId) {
            userMessageText = 'Voice note received — please specify your query';
          } else {
            const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
              headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
            });
            if (!mediaRes.ok) {
              console.error('[STEP A FAIL] Media fetch:', mediaRes.status);
              userMessageText = 'Voice note received — please specify your query';
            } else {
              const mediaData = await mediaRes.json();
              if (!mediaData?.url) {
                console.error('[STEP A FAIL] mediaData.url missing:', JSON.stringify(mediaData));
                userMessageText = 'Voice note received — please specify your query';
              } else {
                const audioStream = await fetch(mediaData.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                const arrayBuffer = await audioStream.arrayBuffer();

                const formData = new globalThis.FormData();
                const blob     = new globalThis.Blob([arrayBuffer], { type:'audio/ogg' });
                formData.append('file',     blob, 'voice.ogg');
                formData.append('model',    'whisper-large-v3-turbo');
                formData.append('language', 'ur');
                formData.append('prompt', 'Fatima Arts, Zara, فیصل آباد, لاہور, کراچی, لان, کھद्दर, مرینا, ویلویٹ, قیمت, ڈلیوری');

                const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                  method:'POST', headers:{ Authorization: `Bearer ${GROQ_API_KEY}` }, body: formData
                });
                if (groqRes.ok) {
                  const groqData  = await groqRes.json();
                  userMessageText = fixCities((groqData.text||'').trim());
                  console.log('[STEP A SUCCESS] Transcribed:', userMessageText.slice(0,80));
                } else {
                  console.error('[STEP A FAIL] Groq:', groqRes.status);
                  userMessageText = 'Voice note received — please specify your query';
                }
              }
            }
          }

        } else if (message.type==='image')    { userMessageText='Image received — please ask your question'; }
          else if (message.type==='sticker')  { userMessageText='Sticker received'; }
          else if (message.type==='document') { userMessageText='Document received'; }
          else                                { userMessageText='Message received'; }

        if (!userMessageText.trim()) userMessageText = 'Salam';

        // ── System Prompt (STRICT LANGUAGE / SCRIPT MIRRORING) ────────────────
        const SYSTEM_PROMPT = `You are Zara — the customer care and sales agent for Fatima Arts, a premium unstitched fabric brand in Pakistan. You are not a robot and should never reveal yourself as AI, a bot, or software.

Current Time (PKT): ${getPKT()}

=== CRITICAL LANGUAGE & SCRIPT MATCHING RULES (MUST FOLLOW) ===
You must strictly mirror the language and writing script used by the customer in their latest message:
1. **Roman Urdu Input:** If the customer writes in Roman Urdu (e.g., "mujhe suit chahiye", "price kya hai?"), you MUST reply ONLY in natural **Roman Urdu**. DO NOT use Urdu script (اردو) under any circumstances.
2. **Urdu Script Input:** If the customer writes in Urdu script (e.g., "مجھے سوٹ چاہیے"), you MUST reply in clear **Urdu script**.
3. **English Input:** If the customer writes in English, you MUST reply in friendly **English**.
4. **Default Safe Language:** If the customer's input is a sticker, image, audio, or ambiguous, default strictly to **Roman Urdu**.
Tone: Professional, warm, and friendly Pakistani customer care.

=== CITY SPELLING CORRECTION ===
Always use correct spellings: فیصل آباد (not Faizabad), لاہور, کراچی, اسلام آباد, راولپنڈی, ملتان, گوجرانوالہ, پشاور, کوئٹہ.

=== IDENTITY & BEHAVIOR ===
Name: Zara — Fatima Arts Team Member.
Try to address the customer by name if known.
Use maximum 2 to 3 emojis per message.

=== PRODUCTS (All Unstitched) ===
1. Lawn/Printed • 2. Embroidered • 3. Linen/Khaddar • 4. Cotton • 5. Karandi • 6. Marina • 7. Velvet • 8. Dhanak

=== PRICING ===
Retail: 1 Suit = Rs. 3,600 | Delivery charges apply | No minimum order limit.
Wholesale (10 or more suits): Rs. 2,999 per suit | 10 Suits = Rs. 29,990 | Free delivery nationwide.

=== PAYMENT METHODS ===
1. JazzCash → ${JAZZCASH_NUMBER  ||'Confirm with boss'}
2. EasyPaisa → ${EASYPAISA_NUMBER ||'Confirm with boss'}
3. Cash on Delivery (COD)

=== ORDER FORMAT ===
When an order is fully confirmed, include this tag at the very end of your message:
[ORDER:name=CustomerName|product=Product|qty=1|price=3600|payment=COD|address=Full Address|city=Faisalabad]

=== STRICT RESTRICTIONS ===
❌ Never call yourself AI or a bot.
❌ Never offer unauthorized discounts.
❌ Never mention competitor brands.`;

        const geminiContents = [
          ...history,
          { role:'user', parts:[{ text:(customerName?`Customer Name: ${customerName}\n`:'')+userMessageText }] }
        ];
        const oaiMessages = [
          { role:'system', content:SYSTEM_PROMPT },
          ...history.map(c=>({ role:c.role==='model'?'assistant':'user', content:c.parts?.[0]?.text||'' })),
          { role:'user', content:(customerName?`Customer Name: ${customerName}\n`:'')+userMessageText }
        ];

        let aiReply = '';

        // ── STEP B: AI CHAIN ──────────────────────────────────────────────────
        if (!aiReply && GEMINI_API_KEY) {
          for (const model of ['gemini-3.7-flash','gemini-3.6-flash']) {
            if (aiReply) break;
            const cbKey = `g:${model}`;
            if (isBlocked(cbKey)) continue;

            for (let att=1; att<=2; att++) {
              if (aiReply) break;
              const ctrl=new AbortController();
              const tid=setTimeout(()=>ctrl.abort(), 20000);
              try {
                const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                  { method:'POST', headers:{'Content-Type':'application/json'}, signal:ctrl.signal,
                    body:JSON.stringify({ system_instruction:{parts:[{text:SYSTEM_PROMPT}]}, contents:geminiContents,
                      generationConfig:{temperature:0.7, maxOutputTokens:800} }) }
                );
                if (r.ok) {
                  const d=await r.json();
                  const raw=d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                  if (raw) aiReply=raw.replace(/[*_~`#]/g,'').trim();
                  break;
                }
                if (r.status===429) { blockFor(cbKey,5*60*1000); break; }
                if (r.status===503 && att<2) { await sleep(2000); continue; }
                break;
              } catch(e) {
                const abort=e?.name==='AbortError'||String(e?.message||'').includes('abort');
                if (abort&&att<2) { await sleep(2000); continue; }
                break;
              } finally { clearTimeout(tid); }
            }
          }
        }

        // Tier 3: Cerebras
        if (!aiReply && CEREBRAS_API_KEY && !isBlocked('cerebras')) {
          try {
            const r=await oaiChat({url:'https://api.cerebras.ai/v1',key:CEREBRAS_API_KEY,model:'llama-3.3-70b',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); }
            else if (r.status===429) blockFor('cerebras',5*60*1000);
          } catch(e) {}
        }

        // Tier 4: Groq
        if (!aiReply && GROQ_API_KEY) {
          for (const gm of ['openai/gpt-oss-120b','qwen/qwen3.6-27b']) {
            if (aiReply) break;
            const cbKey=`gr:${gm}`; if(isBlocked(cbKey)) continue;
            try {
              const r=await oaiChat({url:'https://api.groq.com/openai/v1',key:GROQ_API_KEY,model:gm,messages:oaiMessages});
              if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); break; }
              if (r.status===429) { blockFor(cbKey,5*60*1000); break; }
              break;
            } catch(e) { break; }
          }
        }

        // Tier 5: OpenRouter
        if (!aiReply && OPENROUTER_API_KEY && !isBlocked('or:mistral')) {
          try {
            const r=await oaiChat({url:'https://openrouter.ai/api/v1',key:OPENROUTER_API_KEY,model:'mistralai/mistral-7b-instruct:free',messages:oaiMessages});
            if (r.ok) { const d=await r.json(); const raw=d.choices?.[0]?.message?.content?.trim(); if(raw) aiReply=raw.replace(/[*_~`#]/g,'').trim(); }
            else if (r.status===429) blockFor('or:mistral',5*60*1000);
          } catch(e) {}
        }

        if (!aiReply) {
          aiReply = 'System masroof hai, thori dair baad rabta krien.';
        }

        const orderTag = parseOrderTag(aiReply);
        if (orderTag) {
          aiReply = aiReply.replace(/\[ORDER:[^\]]+\]/gi,'').trim();
          saveToSheet(GOOGLE_SHEETS_ID, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, orderTag, fromNumber).catch(()=>{});
        }

        aiReply = fixCities(aiReply);
        if (!aiReply.trim()) aiReply = 'Shukriya! 🙏';

        history.push({ role:'user',  parts:[{ text:userMessageText }] });
        history.push({ role:'model', parts:[{ text:aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length-MAX_HISTORY);

        chatHistories.set(fromNumber, history);
        dbSave(DATABASE_URL, fromNumber, customerName, history).catch(()=>{});

        // ── STEP C: ElevenLabs TTS → WhatsApp Voice Note ────────────────────
        let voiceSentSuccess = false;

        if (isAudioIncoming && ELEVENLABS_API_KEY && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] ElevenLabs TTS...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method: 'POST',
              headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
              },
              body: JSON.stringify({
                text: aiReply,
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
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
                  console.log('[STEP C SUCCESS] ElevenLabs Voice note sent!');
                }
              }
            } else {
              const errBody = await ttsRes.text();
              console.error('[STEP C FAIL] ElevenLabs:', ttsRes.status, errBody.slice(0, 100));
            }
          } catch(e) { console.error('[STEP C EXC]', e?.message); }
        }

        // Fallback to text if voice failed or text incoming
        if (!voiceSentSuccess) {
          await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method:'POST',
            headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
            body: JSON.stringify({ messaging_product:'whatsapp', to:fromNumber, type:'text', text:{ body:aiReply } })
          });
          console.log('[STEP D SUCCESS] Text sent.');
        }

      } catch (err) {
        console.error('[CRITICAL ERROR]', err?.message);
      }
    })();

    if (waitUntilFn) {
      waitUntilFn(processPromise);
    } else {
      await processPromise;
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(200).send('OK');
};
