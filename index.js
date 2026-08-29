module.exports = async (req, res) => {
  // 1. Environment Variables
  const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
  const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
  const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
  const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
  const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "9BWL2FjLHABvoXxVcR8p").trim();

  const SYSTEM_PROMPT = `Aap Zara hain — Fatima Arts ki official customer support representative (unstitched suit brand, Faisalabad).
- 1 to 9 Suits = PKR 3,600 per suit.
- 10 or more Suits = PKR 2,999 per suit.
- Delivery Charges: PKR 200 all over Pakistan (including Faisalabad).
- Available Fabrics: Lawn, Cotton, Marina, Khaddar, and Linen in various colors including Black.
- Tone: Polite, warm, and direct Roman Urdu (1-2 short sentences maximum). Answer the user's specific question directly without repeating generic greetings.`;

  // 2. Webhook Verification (GET Request)
  if (req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const mode = fullUrl.searchParams.get('hub.mode') || req.query?.['hub.mode'] || req.query?.mode;
    const token = fullUrl.searchParams.get('hub.verify_token') || req.query?.['hub.verify_token'] || req.query?.verify_token;
    const challenge = fullUrl.searchParams.get('hub.challenge') || req.query?.['hub.challenge'] || req.query?.challenge;

    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log("[VERIFICATION SUCCESS] Webhook verified");
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }
    return res.status(200).send('Webhook Endpoint Active');
  }

  // 3. Webhook Event Processing (POST Request)
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    const entry = body?.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.status(200).send('EVENT_RECEIVED');

    const fromNumber = message.from;
    let userMessageText = "";
    const isAudioIncoming = message.type === 'audio' || message.type === 'voice';

    try {
      // --- STEP A: Audio Transcription (Groq Whisper) ---
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
          const buffer = Buffer.from(arrayBuffer);

          const formData = new globalThis.FormData();
          const blob = new globalThis.Blob([buffer], { type: 'audio/ogg' });
          formData.append('file', blob, 'voice.ogg');
          formData.append('model', 'whisper-large-v3');

          const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: formData
          });

          if (groqRes.ok) {
            const groqData = await groqRes.json();
            userMessageText = groqData.text;
            console.log("[STEP A SUCCESS] Transcribed Text:", userMessageText);
          } else {
            console.error("[STEP A ERROR] Groq failed:", await groqRes.text());
          }
        }
      }

      if (!userMessageText) userMessageText = "Hello";
      let aiReply = "";

      // --- STEP B: Multi-Model Gemini Engine (Failover Protection) ---
      if (GEMINI_API_KEY) {
        const candidateModels = ["gemini-2.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro-latest"];

        for (const model of candidateModels) {
          if (aiReply) break;
          try {
            console.log(`[STEP B] Attempting Gemini model: ${model}...`);
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: {
                  parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: [{
                  role: "user",
                  parts: [{ text: userMessageText }]
                }]
              })
            });

            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              aiReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (aiReply) {
                console.log(`[STEP B SUCCESS] Generated via ${model}:`, aiReply);
              }
            } else {
              const errBody = await geminiRes.text();
              console.error(`[STEP B ERROR] Model ${model} returned HTTP ${geminiRes.status}:`, errBody);
            }
          } catch (e) {
            console.error(`[STEP B EXCEPTION] ${model}:`, e.message);
          }
        }
      }

      // Context-Aware Backup (Triggers ONLY if AI Key completely fails)
      if (!aiReply) {
        const query = userMessageText.toLowerCase();
        if (query.includes('marina') || query.includes('khaddar') || query.includes('black') || query.includes('color') || query.includes('kapra') || query.includes('بلیک') || query.includes('مرینہ') || query.includes('خدر')) {
          aiReply = "Walaikum Assalam! Ji Fatima Arts par Black color mein Marina aur Khaddar dono available hain. Price PKR 3,600 per suit hai aur Faisalabad mein delivery charges PKR 200 hain.";
        } else if (query.includes('price') || query.includes('rate') || query.includes('قیمت')) {
          aiReply = "Fatima Arts par 1 se 9 suits PKR 3,600 per suit hain, 10 ya zyada par PKR 2,999 wholesale rate hai. Delivery charges PKR 200 hain.";
        } else {
          aiReply = "Walaikum Assalam! Ji Fatima Arts mein aapko kaunsa fabric ya design dekhna hai?";
        }
      }

      // --- STEP C: Text-To-Speech (ElevenLabs) & Audio Response ---
      let voiceSentSuccess = false;
      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        try {
          console.log("[STEP C] Requesting TTS audio from ElevenLabs...");
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
            const audioBuffer = Buffer.from(arrayBuffer);

            const mediaFormData = new globalThis.FormData();
            const audioBlob = new globalThis.Blob([audioBuffer], { type: 'audio/mpeg' });
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
                console.log("[STEP C SUCCESS] Voice note sent successfully!");
              }
            }
          } else {
            console.error("[STEP C ERROR] ElevenLabs HTTP failure:", await ttsRes.text());
          }
        } catch (err) {
          console.error("[STEP C ERROR] Exception:", err.message);
        }
      }

      // --- STEP D: Text Fallback Delivery ---
      if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        console.log("[STEP D] Delivering text message fallback...");
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
