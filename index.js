// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Webhook — Fatima Arts / Zara AI Agent
//  Updated: 2026-09-03
//
//  Fixes (new updates):
//  [N1] Vercel reliability: do NOT end response before async work unless waitUntil() is used
//       - If @vercel/functions waitUntil available → ACK immediately + continue safely
//       - Else → run work synchronously, then ACK (fallback)
//  [N2] Gemini Abort/timeout handled — retry once, then fallback model
//  [N3] clearTimeout moved to finally (prevents timer leaks / late abort)
//  [N4] Gemini 429 uses Retry-After header when available
//  [N5] cleanup() enforced inside getHistory() too (TTL/MAX_USERS always applied)
// ─────────────────────────────────────────────────────────────────────────────

// ── Vercel post-response work helper (optional; no hard dependency) ───────────
let waitUntilFn = null;
try {
  const vf = require('@vercel/functions');
  if (vf && typeof vf.waitUntil === 'function') waitUntilFn = vf.waitUntil;
} catch (_) {
  // Not installed/available → fallback to synchronous processing
}

// ── In-memory stores (reset on cold start — Vercel hobby tier limitation) ────
const chatHistories     = new Map(); // fromNumber → { history: [], lastSeen: ms }
const processedMsgIds   = new Map(); // messageId  → expiresAtMs

const MAX_HISTORY    = 20;
const DEDUP_TTL_MS   = 10 * 60 * 1000;         // 10 min
const USER_TTL_MS    = 24 * 60 * 60 * 1000;    // 24 hr
const MAX_USERS      = 500;

// ── Cleanup old entries ───────────────────────────────────────────────────────
function cleanup() {
  const now = Date.now();

  for (const [id, exp] of processedMsgIds) {
    if (exp <= now) processedMsgIds.delete(id);
  }

  for (const [num, obj] of chatHistories) {
    const lastSeen = obj?.lastSeen || 0;
    if ((lastSeen + USER_TTL_MS) <= now) chatHistories.delete(num);
  }

  if (chatHistories.size > MAX_USERS) {
    const sorted = [...chatHistories.entries()].sort((a, b) => (a[1]?.lastSeen || 0) - (b[1]?.lastSeen || 0));
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
  cleanup(); // NEW: enforce TTL/MAX_USERS even if msgId missing
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

// NEW: parse Retry-After header (seconds or http-date)
function getRetryAfterMs(resp, fallbackMs) {
  try {
    const ra = resp?.headers?.get?.('retry-after');
    if (!ra) return fallbackMs;

    const secs = Number(ra);
    if (!Number.isNaN(secs) && secs >= 0) return Math.min(secs * 1000, 30000);

    const dt = Date.parse(ra);
    if (!Number.isNaN(dt)) {
      const ms = dt - Date.now();
      return Math.min(Math.max(ms, 0), 30000);
    }
    return fallbackMs;
  } catch {
    return fallbackMs;
  }
}

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

=== PAYMENT METHODS ===
1. JazzCash  → ${JAZZCASH_NUMBER  || 'boss se confirm karein'}
2. EasyPaisa → ${EASYPAISA_NUMBER || 'boss se confirm karein'}
3. COD       → payment on delivery

... (keep the rest of your prompt exactly as you already have it) ...

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

    if (!messages.length) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('[CONFIG] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const processPromise = (async () => {
      try {
        for (const message of messages) {
          const messageId = message?.id;

          // Deduplication — skip if already processed (Meta retry)
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
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
                      body: formData
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

          // ── STEP B: Gemini with 429/503/timeout retry + model fallback ────────
          if (GEMINI_API_KEY) {
            const candidateModels = ['gemini-3.7-flash', 'gemini-3.6-flash'];

            for (const model of candidateModels) {
              if (aiReply) break;

              for (let attempt = 1; attempt <= 2; attempt++) {
                if (aiReply) break;

                const controller = new AbortController();
                const timeoutMs  = 20000; // UPDATED: 15s → 20s
                const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

                try {
                  console.log(`[STEP B] ${model} attempt ${attempt}...`);

                  const maxTokens = attempt === 1 ? 800 : 650;

                  const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      signal: controller.signal,
                      body: JSON.stringify({
                        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                        contents:           geminiContents,
                        generationConfig:   { temperature: 0.7, maxOutputTokens: maxTokens }
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

                  if (geminiRes.status === 429 && attempt < 2) {
                    const waitMs = getRetryAfterMs(geminiRes, 3000);
                    console.warn(`[STEP B 429] ${model} rate limited — retry in ${waitMs}ms...`);
                    await delay(waitMs + Math.floor(Math.random() * 250));
                    continue;
                  }

                  if (geminiRes.status === 503 && attempt < 2) {
                    console.warn(`[STEP B 503] ${model} overloaded — retry in 2000ms...`);
                    await delay(2000 + Math.floor(Math.random() * 250));
                    continue;
                  }

                  const errText = await geminiRes.text().catch(() => '');
                  console.error(`[STEP B FAIL] ${model} ${geminiRes.status} attempt ${attempt}:`, errText.slice(0, 150));
                  break;

                } catch (e) {
                  const msg = String(e?.message || '');
                  const isAbort = e?.name === 'AbortError' || msg.toLowerCase().includes('aborted');

                  if (isAbort && attempt < 2) {
                    console.warn(`[STEP B TIMEOUT] ${model} aborted after ${timeoutMs}ms — retry in 2000ms...`);
                    await delay(2000 + Math.floor(Math.random() * 250));
                    continue;
                  }

                  console.error(`[STEP B EXCEPTION] ${model} attempt ${attempt}:`, e?.message);
                  break;

                } finally {
                  clearTimeout(timeoutId); // UPDATED: always clear
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
          let voiceSentSuccess = false;

          if (sendVoice && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
            try {
              console.log('[STEP C] TTS start...');
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
                const audioBlob     = new globalThis.Blob([arrayBuffer], { type: 'audio/mpeg' });

                mediaFormData.append('messaging_product', 'whatsapp');
                mediaFormData.append('file', audioBlob, 'voice.mp3');
                mediaFormData.append('type', 'audio/mpeg');

                const uploadRes  = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                  body: mediaFormData
                });

                const uploadData = await uploadRes.json().catch(() => ({}));

                if (uploadRes.ok && uploadData?.id) {
                  const voiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      messaging_product: 'whatsapp',
                      recipient_type: 'individual',
                      to: fromNumber,
                      type: 'audio',
                      audio: { id: uploadData.id }
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
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: fromNumber,
                type: 'text',
                text: { preview_url: false, body: aiReply }
              })
            });

            if (textRes.ok) {
              console.log('[STEP D SUCCESS] Text sent. msgId:', messageId || 'n/a');
            } else {
              const errBody = await textRes.text().catch(() => '');
              console.error('[STEP D FAIL] status:', textRes.status, errBody.slice(0, 150));
            }
          }
        }
      } catch (err) {
        console.error('[FATAL]:', err.message, err.stack);
      }
    })();

    // NEW: Preferred Vercel behavior (ACK fast + keep work alive)
    if (waitUntilFn) {
      waitUntilFn(processPromise);
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Fallback: ensure work completes (slower but reliable)
    await processPromise;
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).send('Method Not Allowed');
};
