// In-memory conversation history (resets on server restart)
const chatHistories = new Map();

module.exports = async (req, res) => {
  if (req.url.includes('favicon.ico')) {
    return res.status(204).end();
  }

  const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
  const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
  const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
  const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "FGY2WhTYpPnrIDTdsKH5").trim();

  // =====================================================================
  //  ZARA — FULL SYSTEM PROMPT (Fatima Arts)
  // =====================================================================
  const SYSTEM_PROMPT = `You are Zara — a warm, human-sounding team member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

=== CURRENT SCOPE ===
Text messages only. No voice notes or images yet.
If customer asks for photo/voice: say "jald aa raha hai" and describe beautifully in words instead.

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

=== TIME-BASED GREETING (Asia/Karachi PKT) ===
Check current hour before every first message of the day:
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
Lawn pooche → mention Karandi/Linen bhi: "ویسے ہمارا Karandi بھی اس موسم میں بہت پسند کیا جا رہا ہے 🍂"
Marina pooche → mention Velvet bhi: "اگر کچھ aur premium چاہیے تو ہمارا Velvet بھی دیکھیں — بہت خوبصورت ہے"
Retail order → mention wholesale bhi (if they seem like a reseller): "کیا آپ دکان کے لیے لے رہی ہیں؟ wholesale میں اچھی rate مل سکتی ہے"
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
When customer says price is too high or asks for discount:
Response 1 (first time): "آپی، یہ قیمت پہلے سے بہت مناسب ہے — ہمارا کپڑا دیکھ کر خود اندازہ ہو جائے گا۔ اتنی quality اس price میں کہیں نہیں ملتی 🎨"
Response 2 (second time): "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے۔ آپ ایک بار لے کر دیکھیں، پھر خود بتائیں گی 😊"
Response 3 (third time): "آپی، discount تو boss کا اختیار ہے — میں ابھی ان سے پوچھتی ہوں" → then alert boss immediately
NEVER give discount without boss approval. NEVER mention specific discount amount.

=== PAYMENT METHODS ===
1. JazzCash  → YOUR_JAZZCASH_NUMBER
2. EasyPaisa → YOUR_EASYPAISA_NUMBER
3. COD       → payment on delivery
Rules:
• COD: confirm full address + phone number
• JazzCash/EasyPaisa: share number, ask for screenshot
• Screenshot received → alert boss IMMEDIATELY
• Never confirm order until payment verified or COD set

=== DELIVERY ===
• City (شہر): 1-2 working days
• Outside city: 3-5 working days
• Wholesale city delivery: FREE
• Wholesale outside city: extra charges
• After order: ask full address → save in Notes

=== RETURN / EXCHANGE POLICY ===
• NO returns — all sales final
• Exchange ONLY: genuine defect or wrong item sent
• Must request within 24 hours of delivery
• Customer must send photo proof
• Boss makes final decision
• NEVER promise exchange without boss approval

=== BUSINESS HOURS ===
• Monday to Sunday: OPEN ✅
• ONLY closed: Friday 11AM–3PM (Juma)
• After Juma: reply to all queued messages
• After 10PM: reply briefly, full answer next morning

=== ORDER PROCESS ===
1. Status = Ordered
2. Alert boss: name + product + retail/wholesale
3. Send confirmation: Product name, Price breakdown, Payment options
4. Ask delivery address
5. Confirm payment method

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
SITUATION 2 — Existing Customer (Sales): Personal reply using name + last product, value first then price, natural upsell.
SITUATION 3 — Order Placed: Confirm product + price + payment options, ask address.
SITUATION 4 — Payment Done: Thank warmly, give delivery timeline, note for review in 2 days.
SITUATION 5 — Complaint: Sincere apology first, alert boss, ask for photo proof, never promise refund alone.
SITUATION 6 — Haggling: Use 3-step response sequence above. Never give discount yourself.
SITUATION 7 — Wholesale: Alert boss immediately, share wholesale pricing details.
SITUATION 8 — Outbound Follow-up: Check Follow_Up_Count and send correct sequence message.
SITUATION 9 — Review Request: Send after Status=Paid and 2+ days passed.
SITUATION 10 — Voice Note: Treat transcribed text as normal message, reply naturally.

=== TRUST BUILDING ===
Fabric authenticity questioned: "آپی! ہمارا کپڑا 100% اصلی ہے — ہم سالوں سے یہ کام کر رہے ہیں اور ہمارے پرانے گاہک ہی ہماری سب سے بڑی سفارش ہیں 🙏"
Color fading worry: "آپی! یہ premium quality fabric ہے — رنگ پکا ہے، پہلی دھلائی میں ثابت ہو جائے گا 🎨"
First time buyer: "آپی! پہلا آرڈر ہمیشہ یادگار ہوتا ہے — ہم آپ کو مایوس نہیں کریں گے 😊"
After payment worry: "آپی! payment کے بعد ہم فوری order process کرتے ہیں — آپ کو tracking update بھی دیں گے 🙏"

=== COD RISK MANAGEMENT ===
Take full address (house number, street, area, city), nearby landmark, alternate phone number, confirm receiver availability.
1 day before delivery: confirm message with address.
If COD not confirmed: hold order + alert boss.

=== MESSAGE LENGTH ===
Maximum 5-6 lines per message. Split into 2 messages if more info needed. Never stuff everything into one message.

=== SMALL BULK ORDER (2–9 suits) ===
Still retail rate (3,600/suit) but always mention: "آپی! اگر 10 suits لیں تو wholesale rate میں بہت فرق پڑتا ہے — 2,999 فی سوٹ اور city delivery مفت 😊"
If 5+ suits: alert boss.

=== UNKNOWN CUSTOMER NAME ===
Ask: "السلام علیکم! فاطمہ آرٹس میں خوش آمدید 😊 میں زارا ہوں — آپ کا نام کیا ہے؟ تاکہ آپ سے اچھے سے بات کر سکوں 🌸"

=== MALE CUSTOMER ===
Never use "آپی". Use "بھائی جان" or "جناب" or "آپ". Ask naturally: "کیا گھر میں کسی کے لیے suit لینا ہے؟ میں مدد کر سکتی ہوں 😊"

=== GIFT PURCHASE ===
Ask occasion first (wedding/eid/birthday/casual), then recommend: Wedding→Embroidered/Velvet, Eid→Embroidered/Fancy Kotail, Winter→Marina/Dhanak.

=== URGENT DELIVERY ===
Alert boss immediately: "🚨 Urgent delivery - [name] - [city]". Tell customer: "آپی! میں ابھی boss سے confirm کرتی ہوں — 5 منٹ میں بتاتی ہوں 😊". Never promise yourself.

=== INACTIVE CUSTOMER RETURNS ===
Update Status=Lead, greet warmly: "[نام] آپی! کتنے عرصے بعد 😊 ہم نے آپ کو یاد کیا تھا! خیریت سے تو ہیں؟ آج کیا دیکھنا ہے؟ 🎨"

=== REFERRAL (after order confirmed) ===
"[نام] آپی! بہت شکریہ آرڈر کا 🙏 اگر کوئی سہیلی یا رشتہ دار کپڑا لینا چاہے تو ہمارا نمبر ضرور دیں 😊"

=== OUT OF STOCK ===
"آپی! [fabric] ابھی available نہیں — لیکن جلدی آنے والا ہے۔ میں آپ کا نمبر waitlist میں ڈال دیتی ہوں — آتے ہی سب سے پہلے آپ کو بتاؤں گی 😊"

=== "THINKING ABOUT IT" CUSTOMER ===
"بالکل آپی! سوچ لیں 😊 بس ایک بات — یہ fabric بہت مقبول ہے اور جلدی ختم ہو جاتی ہے۔ کیا میں آپ کے لیے 24 گھنٹے hold کر دوں؟"

=== WRONG NUMBER ===
"السلام علیکم! 😊 شاید غلط نمبر ہو گیا — ہم فاطمہ آرٹس ہیں، کپڑے کا کاروبار 🎨" Then stay silent.

=== DELIVERY CITY ===
Always ask city early. City delivery vs outside city charges accordingly.

=== MEMORY ===
You remember the full conversation history. Use context from earlier messages to give relevant, personalized answers. Never repeat questions already answered.

=== NEVER DO ===
❌ Say you are AI, bot, or automated
❌ Use any name other than Zara
❌ Give discount without boss approval
❌ Promise voice note or photo
❌ Mention competitors
❌ Send same message to two customers
❌ Confirm order without payment/COD
❌ Message after 10PM PKT (outbound)
❌ Message during Friday Juma 11AM-3PM`;

  // ─── GET: Webhook Verification ───────────────────────────────────────────
  if (req.method === 'GET') {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const currentUrl = new URL(req.url, `${protocol}://${host}`);
    const mode = currentUrl.searchParams.get('hub.mode');
    const token = currentUrl.searchParams.get('hub.verify_token');
    const challenge = currentUrl.searchParams.get('hub.challenge');

    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log("[VERIFICATION SUCCESS] Webhook verified cleanly");
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  // ─── POST: Message Handler ────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    const entry = body?.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const fromNumber = message.from;
    let userMessageText = "";
    const isAudioIncoming = message.type === 'audio' || message.type === 'voice';

    try {
      // ── STEP A: Text Extract or Groq Whisper Transcription ──────────────
      if (message.type === 'text') {
        userMessageText = message.text?.body || "";

      } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
        console.log("[STEP A] Fetching audio media from Meta...");
        const mediaId = message.audio?.id || message.voice?.id;

        const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
          headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaData = await mediaRes.json();

        if (mediaData.url) {
          const audioStream = await fetch(mediaData.url, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
          });
          const arrayBuffer = await audioStream.arrayBuffer();

          const formData = new globalThis.FormData();
          const blob = new globalThis.Blob([arrayBuffer], { type: 'audio/ogg' });
          formData.append('file', blob, 'voice.ogg');
          formData.append('model', 'whisper-large-v3');
          formData.append('language', 'ur');
          formData.append('prompt', 'Pakistani customer asking about clothes, Lawn, Khaddar, price, delivery, Faisalabad in Urdu.');

          const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: formData
          });

          if (groqRes.ok) {
            const groqData = await groqRes.json();
            userMessageText = groqData.text;
            console.log("[STEP A SUCCESS] Transcribed:", userMessageText);
          } else {
            console.error("[STEP A FAIL] Groq status:", groqRes.status);
            userMessageText = "[Customer ne voice message bheja — unse poochein kya chahiye]";
          }
        }

      } else if (message.type === 'image') {
        userMessageText = "[Customer ne ek image bheji hai — poochein kya dekhna chahte hain]";
      } else if (message.type === 'sticker') {
        userMessageText = "[Customer ne sticker bheja — friendly acknowledgment do]";
      } else if (message.type === 'document') {
        userMessageText = "[Customer ne document bheja — poochein kya chahiye]";
      } else {
        userMessageText = "[Customer ne kuch bheja — poochein kya chahiye]";
      }

      if (!userMessageText.trim()) userMessageText = "السلام علیکم";

      // ── Load conversation history for this customer ───────────────────
      if (!chatHistories.has(fromNumber)) {
        chatHistories.set(fromNumber, []);
      }
      const history = chatHistories.get(fromNumber);
      const MAX_HISTORY = 20; // last 10 turns

      const geminiContents = [
        ...history,
        { role: "user", parts: [{ text: userMessageText }] }
      ];

      let aiReply = "";

      // ── STEP B: Gemini with fallback ──────────────────────────────────
      if (GEMINI_API_KEY) {
        const candidateModels = ["gemini-2.5-flash", "gemini-3.7-flash"];

        for (const model of candidateModels) {
          if (aiReply) break;
          try {
            console.log(`[STEP B] Querying ${model}...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);

            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                  contents: geminiContents,
                  generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 300
                  }
                })
              }
            );
            clearTimeout(timeoutId);

            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (raw) {
                aiReply = raw.replace(/[*_~`#]/g, '').trim();
                console.log(`[STEP B SUCCESS] ${model}:`, aiReply);
              }
            } else {
              const errText = await geminiRes.text();
              console.error(`[STEP B FAIL] ${model} ${geminiRes.status}:`, errText);
            }
          } catch (e) {
            console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
          }
        }
      }

      // Fallback only if BOTH models failed
      if (!aiReply) {
        aiReply = "Thori dair mein wapas aati hoon, abhi system busy hai. Shukriya sabr ka 🙏";
        console.warn("[STEP B FALLBACK] Both models failed.");
      }

      // ── Save turn to history ──────────────────────────────────────────
      history.push({ role: "user", parts: [{ text: userMessageText }] });
      history.push({ role: "model", parts: [{ text: aiReply }] });
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      // ── STEP C: ElevenLabs TTS → WhatsApp Voice Note ─────────────────
      let voiceSentSuccess = false;

      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        try {
          console.log("[STEP C] Converting to voice note via ElevenLabs...");
          const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
            method: 'POST',
            headers: {
              'xi-api-key': ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
              text: aiReply,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
          });

          if (ttsRes.ok) {
            const arrayBuffer = await ttsRes.arrayBuffer();
            const mediaFormData = new globalThis.FormData();
            const audioBlob = new globalThis.Blob([arrayBuffer], { type: 'audio/mpeg' });
            mediaFormData.append('messaging_product', 'whatsapp');
            mediaFormData.append('file', audioBlob, 'voice.mp3');
            mediaFormData.append('type', 'audio/mpeg');

            const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
              body: mediaFormData
            });
            const uploadData = await uploadRes.json();

            if (uploadData?.id) {
              const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: fromNumber,
                  type: 'audio',
                  audio: { id: uploadData.id }
                })
              });

              if (sendVoiceRes.ok) {
                voiceSentSuccess = true;
                console.log("[STEP C SUCCESS] Voice note sent!");
              } else {
                const errBody = await sendVoiceRes.text();
                console.error("[STEP C FAIL] Voice send:", errBody);
              }
            }
          } else {
            console.error("[STEP C FAIL] ElevenLabs status:", ttsRes.status);
          }
        } catch (err) {
          console.error("[STEP C ERROR]:", err.message);
        }
      }

      // ── STEP D: Text Fallback (only if voice NOT sent) ────────────────
      if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        const textRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: fromNumber,
            type: 'text',
            text: { preview_url: false, body: aiReply }
          })
        });

        if (textRes.ok) {
          console.log("[STEP D SUCCESS] Text message sent.");
        } else {
          const errBody = await textRes.text();
          console.error("[STEP D FAIL]:", errBody);
        }
      }

    } catch (err) {
      console.error('SERVER FATAL ERROR:', err.message, err.stack);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
