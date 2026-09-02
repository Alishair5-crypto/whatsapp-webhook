// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  2026-09-02 — Production ready
//
//  Fixes:
//  [F1] Gemini 429 (rate limit) handled — retry with delay, then fallback model
//  [F2] Gemini 503 (overload) — retry once after 2s
//  [F3] Gemini models: gemini-3.7-flash primary, gemini-3.6-flash fallback
//  [F4] Message deduplication by message.id (stops Meta retry duplicates)
//  [F5] PKT time injected into system prompt (Zara greets correctly)
//  [F6] Customer name from WhatsApp contacts injected into prompt
//  [F7] mediaData.url missing → proper fallback with log
//  [F8] fromNumber missing → skip safely
//  [F9] Voice/text routing: [VOICE]/[TEXT] tag from Gemini
//       uneducated + voice → voice reply
//       educated + voice   → text reply
//       text message       → always text
//  [F10] ElevenLabs 429 quota → auto text fallback
//  [F11] maxOutputTokens 800 (Urdu needs more tokens)
//  [F12] Payment numbers from env vars
//  [F13] Cleanup of old chat histories (max 500 users, 24h TTL)
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory stores (reset on cold start — Vercel hobby tier limitation) ────
const chatHistories     = new Map(); // fromNumber → { history: [], lastSeen: ms }
const processedMsgIds   = new Map(); // messageId  → expiresAtMs

const MAX_HISTORY    = 20;
const DEDUP_TTL_MS   = 10 * 60 * 1000;  // 10 min
const USER_TTL_MS    = 24 * 60 * 60 * 1000; // 24 hr
const MAX_USERS      = 500;

// ── Cleanup old entries ───────────────────────────────────────────────────────
function cleanup() {
  const now = Date.now();
  for (const [id, exp] of processedMsgIds) if (exp <= now) processedMsgIds.delete(id);
  for (const [num, obj] of chatHistories) if ((obj.lastSeen + USER_TTL_MS) <= now) chatHistories.delete(num);
  if (chatHistories.size > MAX_USERS) {
    const sorted = [...chatHistories.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    sorted.slice(0, chatHistories.size - MAX_USERS).forEach(([k]) => chatHistories.delete(k));
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function alreadyProcessed(msgId) {
  if (!msgId) return false;
  cleanup();
  const now = Date.now();
  if ((processedMsgIds.get(msgId) || 0) > now) return true;
  processedMsgIds.set(msgId, now + DEDUP_TTL_MS);
  return false;
}

// ── History helpers ───────────────────────────────────────────────────────────
function getHistory(fromNumber) {
  if (!chatHistories.has(fromNumber)) chatHistories.set(fromNumber, { history: [], lastSeen: Date.now() });
  const obj = chatHistories.get(fromNumber);
  obj.lastSeen = Date.now();
  return obj.history;
}

// ── PKT time for system prompt ────────────────────────────────────────────────
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
  } catch (e) {
    return 'PKT time unavailable';
  }
}

// ── Delay helper ──────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.url && req.url.includes('favicon.ico')) return res.status(204).end();

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

  // ── System Prompt ─────────────────────────────────────────────────────────
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
After answering any product question, ALWAYS add one natural suggestion:
Lawn pooche → "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina pooche → "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں — بہت خوبصورت ہے"
Retail order → mention wholesale if reseller: "کیا آپ دکان کے لیے لے رہی ہیں؟ wholesale میں اچھی rate مل سکتی ہے"
Upsell must feel NATURAL, never pushy. One suggestion per message max.

=== PRICING ===
RETAIL:
• 1 suit = PKR 3,600
• Delivery charges extra
• No minimum order

WHOLESALE:
• Minimum 10 suits
• PKR 2,999 per suit / 10 suits = PKR 29,990
• City delivery FREE / Outside city = extra

=== HAGGLING ===
Response 1: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — ہمارا کپڑا دیکھ کر خود اندازہ ہو جائے گا۔ اتنی quality اس price میں کہیں نہیں ملتی 🎨"
Response 2: "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے۔ آپ ایک بار لے کر دیکھیں، پھر خود بتائیں گی 😊"
Response 3: "آپی، discount تو boss کا اختیار ہے — میں ابھی ان سے پوچھتی ہوں" → alert boss
NEVER give discount without boss approval.

=== PAYMENT METHODS ===
1. JazzCash  → ${JAZZCASH_NUMBER  || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD       → payment on delivery
• COD: confirm full address + phone
• JazzCash/EasyPaisa: share number, ask for screenshot
• Screenshot → alert boss IMMEDIATELY
• Never confirm order until payment verified or COD set

=== DELIVERY ===
• City: 1-2 working days
• Outside city: 3-5 working days
• Wholesale city: FREE / Outside city: extra
• After order: ask full address

=== RETURN / EXCHANGE POLICY ===
• NO returns — all sales final
• Exchange ONLY: genuine defect or wrong item
• Within 24 hours of delivery + photo proof
• Boss decides — NEVER promise alone

=== BUSINESS HOURS ===
• Mon–Sun: OPEN ✅
• Closed: Friday 11AM–3PM (Juma)
• After 10PM: brief reply, full answer next morning

=== ORDER PROCESS ===
1. Alert boss: name + product + retail/wholesale
2. Confirm: product, price, payment options
3. Ask delivery address
4. Confirm payment method

=== BOSS ALERT ===
🚨 Customer angry/rude/complaining
🛍️ Wholesale inquiry (10+ suits)
💰 Retail order PKR 10,000+
✅ Payment screenshot received
🔄 Exchange request
🏷️ Discount asked 3rd time
❓ Unusual situation

=== SITUATION DETECTION ===
1 New Customer: Warm welcome, introduce Fatima Arts.
2 Existing Customer: Personal reply + last product context + upsell.
3 Order Placed: Confirm product + price + payment + ask address.
4 Payment Done: Thank + delivery timeline.
5 Complaint: Sincere apology + boss alert + photo proof.
6 Haggling: 3-step sequence. Never give discount.
7 Wholesale: Alert boss immediately.
10 Voice Note: Treat transcribed text as normal, reply naturally.

=== TRUST BUILDING ===
Authenticity: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں 🙏"
Color fading: "آپی! رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
First buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"

=== MESSAGE LENGTH ===
Max 5-6 lines. Split into 2 messages if needed.

=== MALE CUSTOMER ===
Never use "آپی". Use "بھائی جان" or "جناب".

=== MEMORY ===
You remember full conversation history. Use context. Never repeat questions already answered.

=== NEVER DO ===
❌ Say you are AI, bot, or automated
❌ Use any name other than Zara
❌ Give discount without boss approval
❌ Mention competitors
❌ Confirm order without payment/COD
❌ Message after 10PM PKT (outbound)
❌ Message during Friday Juma 11AM–3PM

=== REPLY ROUTING TAG (MANDATORY — MUST BE VERY LAST LINE) ===
After your reply, on its own line at the very end, write ONE tag:
[VOICE] = customer uneducated: only voice notes, broken/no-punctuation text, not text-comfortable
[TEXT]  = customer educated: proper sentences, punctuation, text-comfortable

Rules:
- Voice note + uneducated customer → [VOICE]
- Voice note + educated customer   → [TEXT]
- Text message (any)               → [TEXT]
- First interaction / unsure       → [VOICE]

The tag must be the absolute last line. Nothing after it.`;

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

    // Always 200 to Meta first — prevents retry storm
    res.status(200).send('EVENT_RECEIVED');

    if (!messages.length) return;
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return;
    }

    try {
      for (const message of messages) {
        const messageId = message?.id;

        // [F4] Deduplication — skip if already processed (Meta retry)
        if (alreadyProcessed(messageId)) {
          console.log('[DEDUP] Already processed:', messageId);
          continue;
        }

        const fromNumber = message.from;
        if (!fromNumber) { console.error('[ERROR] message.from missing'); continue; }

        const isAudioIncoming = message.type === 'audio' || message.type === 'voice';

        // Customer name from WhatsApp contact info
        const contact      = contacts.find(c => c?.wa_id === fromNumber) || contacts[0] || null;
        const customerName = (contact?.profile?.name || '').trim();

        let userMessageText = '';

        // ── STEP A: Extract text or transcribe voice ────────────────────
        if (message.type === 'text') {
          userMessageText = message.text?.body || '';

        } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
          const mediaId = message.audio?.id || message.voice?.id;
          if (!mediaId) {
            userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
          } else {
            console.log('[STEP A] Fetching audio mediaId:', mediaId);
            const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });

            if (!mediaRes.ok) {
              console.error('[STEP A FAIL] Media metadata status:', mediaRes.status);
              userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
            } else {
              const mediaData = await mediaRes.json().catch(() => ({}));
              if (!mediaData?.url) {
                console.error('[STEP A FAIL] mediaData.url missing');
                userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
              } else {
                const audioStream = await fetch(mediaData.url, {
                  headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                if (!audioStream.ok) {
                  console.error('[STEP A FAIL] Audio download status:', audioStream.status);
                  userMessageText = '[Customer ne voice message bheja — unse poochein kya chahiye]';
                } else {
                  const arrayBuffer = await audioStream.arrayBuffer();
                  const formData    = new globalThis.FormData();
                  const blob        = new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' });
                  formData.append('file',     blob, 'voice.ogg');
                  formData.append('model',    'whisper-large-v3-turbo');
                  formData.append('language', 'ur');
                  formData.append('prompt',   'فاطمہ آرٹس، زارہ، لان، کھدر، مارینہ، ویلوٹ، دھنک، کرندی، کوٹیل، قیمت، ڈیلیوری، فیصل آباد، پاکستانی گاہک، کپڑے کی دکان');

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

        if (!userMessageText.trim()) {
          console.warn('[STEP A] Empty message — using default');
          userMessageText = 'السلام علیکم';
        }

        // ── Load history ──────────────────────────────────────────────
        const history = getHistory(fromNumber);

        const geminiContents = [
          ...history,
          {
            role: 'user',
            parts: [{
              text: (customerName ? `Customer name: ${customerName}\n` : '') + `Message:\n${userMessageText}`
            }]
          }
        ];

        let aiReply = '';

        // ── STEP B: Gemini with 429/503 retry + model fallback ────────
        if (GEMINI_API_KEY) {
          const candidateModels = ['gemini-3.7-flash', 'gemini-3.6-flash'];

          for (const model of candidateModels) {
            if (aiReply) break;

            for (let attempt = 1; attempt <= 2; attempt++) {
              if (aiReply) break;
              try {
                console.log(`[STEP B] ${model} attempt ${attempt}...`);
                const controller = new AbortController();
                const timeoutId  = setTimeout(() => controller.abort(), 15000);

                const geminiRes = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                      contents:           geminiContents,
                      generationConfig:   { temperature: 0.7, maxOutputTokens: 800 }
                    })
                  }
                );
                clearTimeout(timeoutId);

                if (geminiRes.ok) {
                  const data = await geminiRes.json().catch(() => ({}));
                  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                  if (raw) aiReply = raw.replace(/[*_~`#]/g, '').trim();
                  console.log(`[STEP B SUCCESS] ${model} attempt ${attempt}`);
                  break;
                }

                // [F1] 429 rate limit — wait 3s then retry, then next model
                if (geminiRes.status === 429 && attempt < 2) {
                  console.warn(`[STEP B 429] ${model} rate limited — retry in 3s...`);
                  await delay(3000);
                  continue;
                }

                // [F2] 503 overload — wait 2s then retry, then next model
                if (geminiRes.status === 503 && attempt < 2) {
                  console.warn(`[STEP B 503] ${model} overloaded — retry in 2s...`);
                  await delay(2000);
                  continue;
                }

                const errText = await geminiRes.text().catch(() => '');
                console.error(`[STEP B FAIL] ${model} ${geminiRes.status} attempt ${attempt}:`, errText.slice(0, 150));
                break;

              } catch (e) {
                console.error(`[STEP B EXCEPTION] ${model} attempt ${attempt}:`, e.message);
                break;
              }
            }
          }
        }

        if (!aiReply) {
          aiReply = 'Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏';
          console.warn('[STEP B FALLBACK] All models failed.');
        }

        // ── STEP B2: Extract routing tag [VOICE]/[TEXT] ───────────────
        let sendVoice = false;
        const replyLines = aiReply.trim().split('\n');
        const lastLine   = replyLines[replyLines.length - 1].trim();

        if (lastLine === '[VOICE]' || lastLine === '[TEXT]') {
          aiReply = replyLines.slice(0, -1).join('\n').trim();
          if (!isAudioIncoming) {
            sendVoice = false;
            console.log('[ROUTING] Text in → TEXT reply');
          } else if (lastLine === '[VOICE]') {
            sendVoice = true;
            console.log('[ROUTING] Voice + uneducated → VOICE reply');
          } else {
            sendVoice = false;
            console.log('[ROUTING] Voice + educated → TEXT reply');
          }
        } else {
          sendVoice = isAudioIncoming; // safe default
          console.log('[ROUTING] No tag — default:', sendVoice ? 'VOICE' : 'TEXT');
        }

        if (!aiReply.trim()) aiReply = 'Thori dair mein wapas aati hoon. Shukriya 🙏';

        // ── Save to history ───────────────────────────────────────────
        history.push({ role: 'user',  parts: [{ text: userMessageText }] });
        history.push({ role: 'model', parts: [{ text: aiReply }] });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

        // ── STEP C: ElevenLabs TTS → Voice Note ──────────────────────
        // Only if sendVoice=true (uneducated customer sent voice note)
        let voiceSentSuccess = false;

        if (sendVoice && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          try {
            console.log('[STEP C] TTS start...');
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
              method: 'POST',
              headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
              body: JSON.stringify({
                text: aiReply, model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
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
                if (voiceRes.ok) {
                  voiceSentSuccess = true;
                  console.log('[STEP C SUCCESS] Voice sent');
                } else {
                  console.error('[STEP C FAIL] Voice send status:', voiceRes.status);
                }
              } else {
                console.error('[STEP C FAIL] Upload status:', uploadRes.status);
              }

            } else if (ttsRes.status === 429) {
              // [F10] ElevenLabs quota exhausted — fall through to text
              console.warn('[STEP C] ElevenLabs quota 429 — falling back to text');
            } else {
              console.error('[STEP C FAIL] ElevenLabs status:', ttsRes.status);
            }
          } catch (err) {
            console.error('[STEP C ERROR]:', err.message);
          }
        }

        // ── STEP D: Text reply (always if voice not sent) ─────────────
        if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
          const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp', recipient_type: 'individual',
              to: fromNumber, type: 'text', text: { preview_url: false, body: aiReply }
            })
          });

          if (textRes.ok) {
            console.log('[STEP D SUCCESS] Text sent. msgId:', messageId || 'n/a');
          } else {
            const errBody = await textRes.text().catch(() => '');
            console.error('[STEP D FAIL] status:', textRes.status, errBody.slice(0, 150));
          }
        }
      } // end for messages loop

    } catch (err) {
      console.error('[FATAL]:', err.message, err.stack);
    }

    // Note: res already sent (200) at top of POST handler
    return;
  }

  return res.status(405).send('Method Not Allowed');
};
