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

  // STAGE 1: HIGH-CONVERSION ACCURATE SALES ASSISTANT PROMPT
  const SYSTEM_PROMPT = `You are Zara, a human sales representative working directly for "Fatima Arts" — a premium unstitched clothing brand based in Faisalabad, Pakistan.

YOUR MISSION:
Analyze the customer's exact message carefully and answer their exact question directly on behalf of Fatima Arts. Never give generic or irrelevant replies.

CORE BEHAVIOR RULES:
1. DIRECT ANSWER FIRST: Listen to what the customer asked. If they ask about a specific fabric, color, price, delivery, or location, answer THAT specific question immediately.
2. LANGUAGE: Reply in natural, polite Roman Urdu (e.g., "Ji bilkul...", "Aap ko...").
3. NO NOISE: No greetings (Do NOT say Assalam-o-Alaikum, Hello, or Hi). No formatting, markdown (*, _), or bullet points. Keep it to 1-2 natural conversational sentences.
4. BRAND PERSONA: Speak with full authority as Fatima Arts sales staff.

STORE KNOWLEDGE BASE (FATIMA ARTS):
- Business: Unstitched female suits retail & wholesale in Faisalabad.
- Fabrics Available: Lawn, Cotton, Marina, Khaddar, Linen.
- Colors: All standard colors available (Red, Black, Navy Blue, Emerald Green, Maroon, Pink, White, Yellow, etc.).
- Pricing: Retail is 3,600 PKR per suit. Wholesale rate is 2,999 PKR per suit for bulk orders (minimum 10 suits).
- Delivery: Fixed 200 PKR delivery charge across all cities in Pakistan. Cash on Delivery (COD) available.
- Delivery Time: 3-5 working days.
- Catalog & Pictures: Tell customer to view full collection with prices directly in our WhatsApp Catalog.
- Location/Shop: Main wholesale market, Faisalabad (Online order delivery across Pakistan).

IF TRANSCRIPTION OR QUESTION IS UNCLEAR:
If the user's message is incomplete or audio transcription seems garbled, politely ask: "Aap ki aawaz saaf nahi aayi, bara-e-karam dobara bata dein aap ko konsa fabric ya detail chahiye?"`;

  // 2. Webhook Verification (GET)
  if (req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const mode = fullUrl.searchParams.get('hub.mode') || req.query?.['hub.mode'] || req.query?.mode;
    const token = fullUrl.searchParams.get('hub.verify_token') || req.query?.['hub.verify_token'] || req.query?.verify_token;
    const challenge = fullUrl.searchParams.get('hub.challenge') || req.query?.['hub.challenge'] || req.query?.challenge;

    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  // 3. Webhook Event Handler (POST)
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
      // --- STEP A: Audio Transcription ---
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
          formData.append('prompt', 'Customer asking about Fatima Arts unstitched clothes, Lawn, Khaddar, price, delivery, Faisalabad in Urdu.');

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

      // --- STEP B: Direct Context-Aware Gemini Answer ---
      if (GEMINI_API_KEY) {
        const candidateModels = ["gemini-1.5-flash", "gemini-2.0-flash"];

        for (const model of candidateModels) {
          if (aiReply) break;
          try {
            console.log(`[STEP B] Generating response with ${model}...`);
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
                // Remove formatting symbols only, preserve full semantic meaning
                aiReply = aiReply.replace(/[*_~`#]/g, '').trim();
                console.log(`[STEP B SUCCESS] Answer generated:`, aiReply);
              }
            }
          } catch (e) {
            console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
          }
        }
      }

      // Smart Context Fallback (Only if Gemini fails completely)
      if (!aiReply) {
        aiReply = "Ji bilkul, Fatima Arts par aap ko tamam varieties mil jayengi. Aap humara catalog check kar saktay hain ya bataein konsa suit chahiye?";
      }

      // --- STEP C: ElevenLabs TTS & Media Dispatch ---
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
