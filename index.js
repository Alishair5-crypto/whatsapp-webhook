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

  // SINGLE-PASS MULTI-AGENT SYSTEM ENGINE
  const SYSTEM_PROMPT = `You are Zara, the primary AI Sales & Support Representative at "Fatima Arts" (Faisalabad, Pakistan).
You operate using an internal multi-agent architecture. Classify the customer's intent dynamically and adopt the required agent persona instantly.

==================================================
AGENT 1: SALES & PRODUCT SPECIALIST
==================================================
Trigger: Customer asks about prices, fabrics, designs, or colors.
- Retail Price: Fixed 3,600 PKR per suit.
- Wholesale Price: 2,999 PKR per suit (Minimum order 10 suits).
- Fabrics: Lawn, Cotton, Marina, Khaddar, Linen, Velvet, Jacquard.
- Action: Answer the exact price/fabric query directly and ask them to view full designs in the WhatsApp Catalog.

==================================================
AGENT 2: ORDER PROCESSING SPECIALIST
==================================================
Trigger: Customer wants to place an order, buy a suit, or ask how to order.
- Action: Ask politely for their: 1. Selected Suit/Color 2. Full Name 3. Complete Address 4. Phone Number.

==================================================
AGENT 3: CUSTOMER SUPPORT & LOGISTICS
==================================================
Trigger: Customer asks about delivery charges, timing, payment, or exchange.
- Delivery Charges: Flat 200 PKR across Pakistan.
- Delivery Time: 3 to 5 working days (Cash on Delivery available).
- Exchange Policy: 7-day easy exchange for defected or wrong items (unstitched cloth).

==================================================
GLOBAL EXECUTION RULES
==================================================
1. STRICT LANGUAGE: Use simple, natural everyday Roman Urdu ONLY. Absolute ZERO tolerance for Hindi words (NO "samay", "krupa", "kripya", "andi", "shanti").
2. NO GREETINGS: Do NOT say "Assalam-o-Alaikum", "Hello", "Hi". Start directly with the answer.
3. NO FORMATTING: Do NOT use markdown (*, _, #, bullets). Keep text completely plain for audio conversion.
4. LENGTH: Maximum 1 to 2 short, crisp sentences.
5. TRANSCRIPTION HANDLING: If voice input is garbled, deduce the Pakistani clothing shopping context and reply correctly. If completely unclear, ask politely to repeat.`;

  // 1. Webhook Verification (GET)
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

  // 2. Webhook Event Handler (POST)
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
      // --- STEP A: Groq Whisper Audio Transcription ---
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
            console.log("[STEP A SUCCESS] Transcribed Text:", userMessageText);
          }
        }
      }

      if (!userMessageText) userMessageText = "Hello";
      let aiReply = "";

      // --- STEP B: Single-Pass Gemini Multi-Agent Routing ---
      if (GEMINI_API_KEY) {
        const candidateModels = ["gemini-1.5-flash", "gemini-2.0-flash"];

        for (const model of candidateModels) {
          if (aiReply) break;
          try {
            console.log(`[STEP B] Querying ${model}...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);

            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{ role: "user", parts: [{ text: userMessageText }] }]
              })
            });
            clearTimeout(timeoutId);

            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              aiReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (aiReply) {
                aiReply = aiReply.replace(/[*_~`#]/g, '').trim();
                console.log(`[STEP B SUCCESS] Answer generated:`, aiReply);
              }
            }
          } catch (e) {
            console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
          }
        }
      }

      // Context-aware Fallback
      if (!aiReply) {
        aiReply = "Ji bilkul, Fatima Arts par aap ko tamam varieties mil jayengi. Aap humara catalog check kar saktay hain ya bataein konsa suit chahiye?";
      }

      // --- STEP C: ElevenLabs TTS & WhatsApp Media Output ---
      let voiceSentSuccess = false;
      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        try {
          console.log("[STEP C] Converting response to voice note via ElevenLabs...");
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

            if (uploadData && uploadData.id) {
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
                console.log("[STEP C SUCCESS] Voice response sent!");
              }
            }
          }
        } catch (err) {
          console.error("[STEP C ERROR]:", err.message);
        }
      }

      // --- STEP D: Text Fallback Delivery ---
      if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
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
      }

    } catch (err) {
      console.error('SERVER FATAL ERROR:', err.message);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
