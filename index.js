// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  Updated: 2026-09-03
//
//  [N1] Vercel waitUntil() used if available, else sync fallback
//  [N2] Gemini abort/timeout → retry once on same model
//  [N3] clearTimeout in finally (no timer leaks)
//  [N4] Gemini 429 → 5min circuit breaker (no useless retry)
//  [N5] cleanup() inside getHistory()
//  [N6] Groq LLM final fallback — FIXED model names:
//       llama-3.3-70b-versatile DEPRECATED Aug 16 2026
//       Now using: openai/gpt-oss-120b (primary) → qwen/qwen3.6-27b (fallback)
//  [N7] Routing tag: case-insensitive + last 3 lines scan
//  [N8] 503 retry delay 4s
// ─────────────────────────────────────────────────────────────────────────────

// ── Vercel post-response work helper ─────────────────────────────────────────
let waitUntilFn = null;
try {
  const vf = require('@vercel/functions');
  if (vf && typeof vf.waitUntil === 'function') waitUntilFn = vf.waitUntil;
} catch (_) {}

// ── Quota circuit breaker ─────────────────────────────────────────────────────
if (!global._quotaFailures) global._quotaFailures = new Map();
function isQuotaFailed(model) { return Date.now() < (global._quotaFailures.get(model) || 0); }
function markQuotaFailed(model) {
  global._quotaFailures.set(model, Date.now() + 5 * 60 * 1000);
  console.warn(`[QUOTA] ${model} marked exhausted for 5 min`);
}

// ── In-memory stores ──────────────────────────────────────────────────────────
const chatHistories   = new Map();
const processedMsgIds = new Map();

const MAX_HISTORY  = 20;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const USER_TTL_MS  = 24 * 60 * 60 * 1000;
const MAX_USERS    = 500;

function cleanup() {
  const now = Date.now();
  for (const [id, exp] of processedMsgIds) if (exp <= now) processedMsgIds.delete(id);
  for (const [num, obj] of chatHistories) if (((obj?.lastSeen || 0) + USER_TTL_MS) <= now) chatHistories.delete(num);
  if (chatHistories.size > MAX_USERS) {
    [...chatHistories.entries()]
      .sort((a, b) => (a[1]?.lastSeen || 0) - (b[1]?.lastSeen || 0))
      .slice(0, chatHistories.size - MAX_USERS)
      .forEach(([k]) => chatHistories.delete(k));
  }
}

function alreadyProcessed(msgId) {
  if (!msgId) return false;
  cleanup();
  const now = Date.now();
  if ((processedMsgIds.get(msgId) || 0) > now) return true;
  processedMsgIds.set(msgId, now + DEDUP_TTL_MS);
  return false;
}

function getHistory(fromNumber) {
  cleanup();
  if (!chatHistories.has(fromNumber)) chatHistories.set(fromNumber, { history: [], lastSeen: Date.now() });
  const obj = chatHistories.get(fromNumber);
  obj.lastSeen = Date.now();
  return obj.history;
}

function getPKTTime() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PKT`;
  } catch (e) { return 'PKT time unavailable'; }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url && req.url.includes('favicon.ico')) return res.status(204).end();

  const WHATSAPP_TOKEN      = (process.env.WHATSAPP_TOKEN      || '').trim();
  const PHONE_NUMBER_ID     = (process.env.PHONE_NUMBER_ID     || '').trim();
  const VERIFY_TOKEN        = (process.env.VERIFY_TOKEN        || '').trim();
  const GEMINI_API_KEY      = (process.env.GEMINI_API_KEY      || '').trim();
  const GROQ_API_KEY        = (process.env.GROQ_API_KEY        || '').trim();
  const ELEVENLABS_API_KEY  = (process.env.ELEVENLABS_API_KEY  || '').trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim();
  const JAZZCASH_NUMBER     = (process.env.JAZZCASH_NUMBER     || '').trim();
  const EASYPAISA_NUMBER    = (process.env.EASYPAISA_NUMBER    || '').trim();

  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding sales agent of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

CURRENT TIME: ${getPKTTime()}

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a helpful colleague, not a call-center script
- Use customer's name in EVERY message (if known). If unknown, ask once — never invent a name.
- Max 2-3 emojis per message
- Every message must feel personal, never copy-pasted
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== CAPABILITIES ===
You handle: text messages, voice notes (transcribed to text), images, and all customer queries.
Reply naturally to transcribed voice content exactly like text.

=== LANGUAGE — AUTO DETECT ===
- Urdu script in   → Urdu script out
- English in       → English out
- Roman Urdu in    → Roman Urdu out
- Never switch language unless customer switches first

=== TIME-BASED GREETING (Asia/Karachi PKT) ===
Use CURRENT TIME above to decide greeting:
06:00 – 12:00 → صبح بخیر! 🌅
12:00 – 17:00 → خیریت سے ہیں؟ ☀️
17:00 – 21:00 → شام بخیر! ✨
21:00 – 06:00 → السلام علیکم! (brief reply, full answer next morning)
Use greeting only on FIRST message of conversation, not every reply.

=== SEASON & FESTIVAL AWARENESS ===
WINTER (Nov–Feb) → Promote first: Marina, Velvet, Dhanak, Karandi
SUMMER (Apr–Sep) → Promote first: Lawn, Linen/Khaddar, Printed Suits
EID UL FITR (Ramadan last 10 days) → Promote: Embroidered, Fancy, Kotail
EID UL ADHA (Zul Hijja 1–10) → Promote: Embroidered, Velvet, Kotail
WEDDING SEASON (Oct–Dec, Mar–Apr) → Promote: Embroidered, Velvet, Fancy
Always mention season/occasion naturally in conversation, not as a sales pitch.

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
Lawn pooche → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina pooche → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں — بہت خوبصورت ہے"
Retail order → mention wholesale if reseller: "کیا آپ دکان کے لیے لے رہی ہیں؟ wholesale میں اچھی rate مل سکتی ہے"
Upsell must feel NATURAL, never pushy. One suggestion per message max.

=== PRICING ===
RETAIL: 1 suit = PKR 3,600 • Delivery extra • No minimum
WHOLESALE: Min 10 suits • PKR 2,999/suit • 10 suits = PKR 29,990 • City delivery FREE

=== HAGGLING ===
Response 1: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — ہمارا کپڑا دیکھ کر خود اندازہ ہو جائے گا۔ اتنی quality اس price میں کہیں نہیں ملتی 🎨"
Response 2: "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے 😊"
Response 3: "آپی، discount تو boss کا اختیار ہے — میں ابھی ان سے پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT METHODS ===
1. JazzCash  → ${JAZZCASH_NUMBER  || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD       → payment on delivery
• JazzCash/EasyPaisa: share number, ask for screenshot → alert boss IMMEDIATELY
• Never confirm order until payment verified or COD set

=== DELIVERY ===
• City: 1-2 working days • Outside city: 3-5 working days
• Wholesale city: FREE • After order: ask full address

=== RETURN / EXCHANGE ===
• NO returns • Exchange ONLY: defect or wrong item • Within 24hrs + photo proof • Boss decides

=== BUSINESS HOURS ===
Mon–Sun OPEN ✅ • Closed: Friday 11AM–3PM • After 10PM: brief reply, full answer next morning

=== ORDER PROCESS ===
1. Alert boss: name + product + retail/wholesale
2. Confirm: product, price, payment options
3. Ask delivery address + confirm payment method

=== BOSS ALERT ===
🚨 Angry/rude customer | 🛍️ Wholesale 10+ suits | 💰 Retail PKR 10,000+ | ✅ Payment screenshot | 🔄 Exchange | 🏷️ 3rd discount ask | ❓ Unusual situation

=== SITUATION DETECTION ===
1 New Customer: Warm welcome, introduce Fatima Arts.
2 Existing Customer: Personal reply + context + upsell.
3 Order Placed: Confirm product + price + payment + ask address.
4 Payment Done: Thank + delivery timeline.
5 Complaint: Sincere apology + boss alert + photo proof.
6 Haggling: 3-step. Never give discount.
7 Wholesale: Alert boss immediately.
10 Voice Note: Treat transcribed text normally.

=== TRUST BUILDING ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
Color fading: "آپی! رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"

=== MALE CUSTOMER === Never use "آپی". Use "بھائی جان" or "جناب".

=== MEMORY === Full conversation history. Use context. Never repeat answered questions.

=== NEVER DO ===
❌ Say AI/bot/automated | ❌ Give discount without boss | ❌ Mention competitors
❌ Confirm order without payment/COD | ❌ Message after 10PM | ❌ Message during Juma 11AM–3PM

=== REPLY ROUTING TAG (MANDATORY — ABSOLUTE LAST LINE) ===
[VOICE] = customer is voice-note user / uneducated texter
[TEXT]  = customer is comfortable with text
- Voice note + uneducated → [VOICE]
- Voice note + educated   → [TEXT]
- Text message (any)      → [TEXT]
- First interaction       → [VOICE]
Tag must be the very last line. Nothing after it.`;

  // ─── GET: Webhook Verification ───────────────────────────────────────────
  if (req.method === 'GET') {
    const protocol   = req.headers['x-forwarded-proto'] || 'https';
    const host       = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const currentUrl = new URL(req.url, `${protocol}://${host}`);
    const mode       = currentUrl.searchParams.get('hub.mode');
    const token      = currentUrl.searchParams.get('hub.verify_token');
    const challenge  = currentUrl.searchParams.get('hub.challenge');
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log('[VERIFY] Webhook verified');
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
          if (alreadyProcessed(messageId)) { console.log('[DEDUP] Skip:', messageId); continue; }

          const fromNumber = message.from;
          if (!fromNumber) { console.error('[ERROR] message.from missing'); continue; }

          const isAudioIncoming = message.type === 'audio' || message.type === 'voice';
          const contact      = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
          const customerName = (contact?.profile?.name || '').trim();
          let userMessageText = '';

          // ── STEP A: Extract text or transcribe voice ──────────────────
          if (message.type === 'text') {
            userMessageText = message.text?.body || '';

          } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
            const mediaId = message.audio?.id || message.voice?.id;
            if (!mediaId) {
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              console.log('[STEP A] mediaId:', mediaId);
              const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
              });
              if (!mediaRes.ok) {
                console.error('[STEP A FAIL] Media status:', mediaRes.status);
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const mediaData = await mediaRes.json().catch(() => ({}));
                if (!mediaData?.url) {
                  console.error('[STEP A FAIL] mediaData.url missing');
                  userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                } else {
                  const audioStream = await fetch(mediaData.url, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
                  if (!audioStream.ok) {
                    console.error('[STEP A FAIL] Audio download:', audioStream.status);
                    userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                  } else {
                    const arrayBuffer = await audioStream.arrayBuffer();
                    const formData    = new globalThis.FormData();
                    const blob        = new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' });
                    formData.append('file', blob, 'voice.ogg');
                    formData.append('model', 'whisper-large-v3-turbo');
                    formData.append('language', 'ur');
                    formData.append('prompt', 'فاطمہ آرٹس، زارہ، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، فیصل آباد، پاکستانی گاہک، کپڑے کی دکان');
                    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }, body: formData
                    });
                    if (groqRes.ok) {
                      const groqData  = await groqRes.json().catch(() => ({}));
                      userMessageText = (groqData.text || '').trim();
                      console.log('[STEP A SUCCESS] Transcribed length:', userMessageText.length);
                    } else {
                      console.error('[STEP A FAIL] Groq status:', groqRes.status);
                      userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                    }
                  }
                }
              }
            }
          } else if (message.type === 'image')    { userMessageText = '[Customer ne image bheji — poochein kya dekhna chahte hain]'; }
            else if (message.type === 'sticker')  { userMessageText = '[Customer ne sticker bheja — friendly acknowledgment do]'; }
            else if (message.type === 'document') { userMessageText = '[Customer ne document bheja — poochein kya chahiye]'; }
            else                                  { userMessageText = '[Customer ne kuch bheja — poochein kya chahiye]'; }

          if (!userMessageText.trim()) { console.warn('[STEP A] Empty → default'); userMessageText = 'السلام علیکم'; }

          // ── Load history ──────────────────────────────────────────────
          const history = getHistory(fromNumber);
          const geminiContents = [
            ...history,
            { role: 'user', parts: [{ text: (customerName ? `Customer name: ${customerName}\n` : '') + `Message:\n${userMessageText}` }] }
          ];

          let aiReply = '';

          // ── STEP B: Gemini — primary AI ───────────────────────────────
          if (GEMINI_API_KEY) {
            const candidateModels = ['gemini-3.7-flash', 'gemini-3.6-flash'];
            for (const model of candidateModels) {
              if (aiReply) break;
              if (isQuotaFailed(model)) { console.warn(`[STEP B SKIP] ${model} quota-failed`); continue; }

              for (let attempt = 1; attempt <= 2; attempt++) {
                if (aiReply) break;
                const controller = new AbortController();
                const timeoutMs  = 20000;
                const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

                try {
                  console.log(`[STEP B] ${model} attempt ${attempt}...`);
                  const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                    {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                      body: JSON.stringify({
                        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                        contents: geminiContents,
                        generationConfig: { temperature: 0.7, maxOutputTokens: attempt === 1 ? 800 : 650 }
                      })
                    }
                  );

                  if (geminiRes.ok) {
                    const data = await geminiRes.json().catch(() => ({}));
                    const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (raw) aiReply = raw.replace(/[*_~`#]/g, '').trim();
                    console.log(`[STEP B SUCCESS] ${model} attempt ${attempt}`);
                    break;
                  }
                  if (geminiRes.status === 429) { markQuotaFailed(model); console.warn(`[STEP B 429] ${model} — next model`); break; }
                  if (geminiRes.status === 503 && attempt < 2) {
                    console.warn(`[STEP B 503] ${model} — retry in 4s`);
                    await delay(4000 + Math.floor(Math.random() * 500)); continue;
                  }
                  const errText = await geminiRes.text().catch(() => '');
                  console.error(`[STEP B FAIL] ${model} ${geminiRes.status}:`, errText.slice(0, 150));
                  break;

                } catch (e) {
                  const isAbort = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted');
                  if (isAbort && attempt < 2) {
                    console.warn(`[STEP B TIMEOUT] ${model} ${timeoutMs}ms — retry in 2s`);
                    await delay(2000 + Math.floor(Math.random() * 250)); continue;
                  }
                  console.error(`[STEP B EXCEPTION] ${model} attempt ${attempt}:`, e?.message);
                  break;
                } finally {
                  clearTimeout(timeoutId);
                }
              }
            }
          }

          // ── STEP B3: Groq LLM — final fallback ───────────────────────
          // [N6 FIX] llama-3.3-70b-versatile deprecated Aug 16 2026
          // Official Groq replacements: openai/gpt-oss-120b → qwen/qwen3.6-27b
          if (!aiReply && GROQ_API_KEY) {
            const groqFallbackModels = ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'];

            for (const groqModel of groqFallbackModels) {
              if (aiReply) break;
              console.warn(`[STEP B3] Gemini failed — trying Groq: ${groqModel}`);

              const groqController = new AbortController();
              const groqTimeoutId  = setTimeout(() => groqController.abort(), 20000);

              try {
                const groqMessages = [
                  { role: 'system', content: SYSTEM_PROMPT },
                  ...geminiContents.map(c => ({
                    role:    c.role === 'model' ? 'assistant' : 'user',
                    content: c.parts?.[0]?.text || ''
                  }))
                ];

                const groqLLMRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                  signal: groqController.signal,
                  body: JSON.stringify({ model: groqModel, messages: groqMessages, temperature: 0.7, max_tokens: 800 })
                });

                if (groqLLMRes.ok) {
                  const groqData = await groqLLMRes.json().catch(() => ({}));
                  const raw      = groqData.choices?.[0]?.message?.content?.trim();
                  if (raw) {
                    aiReply = raw.replace(/[*_~`#]/g, '').trim();
                    console.log(`[STEP B3 SUCCESS] ${groqModel}`);
                  }
                } else {
                  const errText = await groqLLMRes.text().catch(() => '');
                  console.error(`[STEP B3 FAIL] ${groqModel} ${groqLLMRes.status}:`, errText.slice(0, 150));
                }
              } catch (e) {
                console.error(`[STEP B3 EXCEPTION] ${groqModel}:`, e?.message);
              } finally {
                clearTimeout(groqTimeoutId);
              }
            }
          }

          if (!aiReply) {
            aiReply = 'Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏';
            console.warn('[FALLBACK] All models failed.');
          }

          // ── STEP B2: Extract routing tag ──────────────────────────────
          let sendVoice    = false;
          const replyLines = aiReply.trim().split('\n');
          const lastFew    = replyLines.slice(-3).map(l => l.trim().toUpperCase());
          const hasVoice   = lastFew.some(l => l === '[VOICE]');
          const hasText    = lastFew.some(l => l === '[TEXT]');

          if (hasVoice || hasText) {
            let cutAt = replyLines.length;
            for (let i = replyLines.length - 1; i >= 0; i--) {
              const u = replyLines[i].trim().toUpperCase();
              if (u === '[VOICE]' || u === '[TEXT]' || u === '') cutAt = i;
              else break;
            }
            aiReply = replyLines.slice(0, cutAt).join('\n').trim();
            if (!isAudioIncoming)   { sendVoice = false; console.log('[ROUTING] Text in → TEXT'); }
            else if (hasVoice)      { sendVoice = true;  console.log('[ROUTING] Voice + uneducated → VOICE'); }
            else                    { sendVoice = false; console.log('[ROUTING] Voice + educated → TEXT'); }
          } else {
            sendVoice = isAudioIncoming;
            console.log('[ROUTING] No tag — default:', sendVoice ? 'VOICE' : 'TEXT');
          }

          if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

          // ── Save to history ───────────────────────────────────────────
          history.push({ role: 'user',  parts: [{ text: userMessageText }] });
          history.push({ role: 'model', parts: [{ text: aiReply }] });
          if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

          // ── STEP C: ElevenLabs TTS → Voice Note ──────────────────────
          let voiceSentSuccess = false;
          if (sendVoice && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
            try {
              console.log('[STEP C] TTS start...');
              const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
                method: 'POST',
                headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
                body: JSON.stringify({ text: aiReply, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
              });

              if (ttsRes.ok) {
                const arrayBuffer   = await ttsRes.arrayBuffer();
                const mediaFormData = new globalThis.FormData();
                const audioBlob     = new globalThis.Blob([arrayBuffer], { type: 'audio/mpeg' });
                mediaFormData.append('messaging_product', 'whatsapp');
                mediaFormData.append('file', audioBlob, 'voice.mp3');
                mediaFormData.append('type', 'audio/mpeg');

                const uploadRes  = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                  method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }, body: mediaFormData
                });
                const uploadData = await uploadRes.json().catch(() => ({}));

                if (uploadRes.ok && uploadData?.id) {
                  const voiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      messaging_product: 'whatsapp', recipient_type: 'individual',
                      to: fromNumber, type: 'audio', audio: { id: uploadData.id }
                    })
                  });
                  if (voiceRes.ok) { voiceSentSuccess = true; console.log('[STEP C SUCCESS] Voice sent'); }
                  else console.error('[STEP C FAIL] Voice send:', voiceRes.status);
                } else console.error('[STEP C FAIL] Upload:', uploadRes.status);
              } else if (ttsRes.status === 429) {
                console.warn('[STEP C] ElevenLabs quota 429 → text fallback');
              } else console.error('[STEP C FAIL] ElevenLabs:', ttsRes.status);
            } catch (err) { console.error('[STEP C ERROR]:', err.message); }
          }

          // ── STEP D: Text reply ────────────────────────────────────────
          if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
            const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messaging_product: 'whatsapp', recipient_type: 'individual',
                to: fromNumber, type: 'text', text: { preview_url: false, body: aiReply }
              })
            });
            if (textRes.ok) console.log('[STEP D SUCCESS] Text sent. msgId:', messageId || 'n/a');
            else { const e = await textRes.text().catch(() => ''); console.error('[STEP D FAIL]', textRes.status, e.slice(0, 150)); }
          }

        } // end for messages
      } catch (err) { console.error('[FATAL]:', err.message, err.stack); }
    })();

    if (waitUntilFn) { waitUntilFn(processPromise); return res.status(200).send('EVENT_RECEIVED'); }
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).send('Method Not Allowed');
};
