module.exports = async (req, res) => {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1208369552366735";
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_custom_secret_123";
  const BASE44_API_KEY = process.env.BASE44_API_KEY || "f7539dd0947f4f1a8a1434b8e3c03f71";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  const AGENT_ID = "6a7258c617116e6f8bdaee29";
  const CONVERSATION_ID = "6a7258ca11d24606478a2812";

  const SYSTEM_PROMPT = `Aap Zara hain — Fatima Arts ki official customer support representative (unstitched suit brand, Faisalabad).
- 1 to 9 Suits = PKR 3,600 per suit.
- 10 or more Suits = PKR 2,999 per suit.
- Tone polite, warm, aur short (1-2 lines) Roman Urdu mein rakhein.
- Voice note query par hamesha short greeting aur helpful answer dein.`;

  // 1. Webhook Verification (GET Request Fix)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'] || req.query['mode'];
    const token = req.query['hub.verify_token'] || req.query['verify_token'];
    const challenge = req.query['hub.challenge'] || req.query['challenge'];

    // Meta verification challenge handling
    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log("WEBHOOK_VERIFIED");
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }

    // Direct Challenge Pass-through Fallback
    if (challenge) {
      return res.status(200).send(challenge);
    }

    return res.status(200).send('Webhook Endpoint Active');
  }

  // 2. Incoming Messages Handling (POST Request)
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
      // Step A: Parse Text or Voice Message
      if (message.type === 'text') {
        userMessageText = message.text?.body || "";
      } else if (isAudioIncoming && GROQ_API_KEY && WHATSAPP_TOKEN) {
        const mediaId = message.audio?.id || message.voice?.id;

        // Fetch Media URL from Meta
        const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
          headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaData = await mediaRes.json();

        if (mediaData.url) {
          // Download Binary Audio File
          const audioStream = await fetch(mediaData.url, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
          });
          const arrayBuffer = await audioStream.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          // Transcribe via Groq Whisper API
          const formData = new globalThis.FormData();
          const blob = new globalThis.Blob([buffer], { type: 'audio/ogg' });
          formData.append('file', blob, 'voice.ogg');
          formData.append('model', 'whisper-large-v3');
          formData.append('language', 'ur');

          const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: formData
          });

          if (groqRes.ok) {
            const groqData = await groqRes.json();
            userMessageText = groqData.text;
          }
        }
      }

      if (!userMessageText) userMessageText = "Hello";
      let aiReply = "";

      // Step B: Generate Response (Gemini Flash)
      if (GEMINI_API_KEY) {
        try {
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: [{ parts: [{ text: userMessageText }] }]
            })
          });
          if (geminiRes.ok) {
            const geminiData = await geminiRes.json();
            aiReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          }
        } catch (e) {
          console.error("Gemini Error:", e);
        }
      }

      // Base44 Fallback
      if (!aiReply && BASE44_API_KEY) {
        try {
          const base44Res = await fetch(`https://app.base44.com/api/agents/${AGENT_ID}/conversations/${CONVERSATION_ID}/messages`, {
            method: 'POST',
            headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: userMessageText })
          });

          if (base44Res.ok) {
            const base44Data = await base44Res.json();
            const rawReply = base44Data.reply || base44Data.content || base44Data.message || base44Data.output;
            if (rawReply && typeof rawReply === 'string' && !rawReply.toLowerCase().includes('credit')) {
              aiReply = rawReply;
            }
          }
        } catch (e) {}
      }

      if (!aiReply) aiReply = "Assalam-o-Alaikum! Fatima Arts mein khushamdeed. Main aap ki kya madad kar sakti hoon?";

      // Step C: Generate & Send Voice Note Reply via ElevenLabs
      let voiceSentSuccess = false;
      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && WHATSAPP_TOKEN) {
        try {
          const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_16000`, {
            method: 'POST',
            headers: {
              'xi-api-key': ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
              'Accept': 'audio/ogg'
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
            const audioBlob = new globalThis.Blob([audioBuffer], { type: 'audio/ogg' });
            mediaFormData.append('messaging_product', 'whatsapp');
            mediaFormData.append('file', audioBlob, 'voice.opus');
            mediaFormData.append('type', 'audio/ogg');

            const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
              body: mediaFormData
            });

            const uploadData = await uploadRes.json();

            if (uploadData.id) {
              const sendVoiceRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to: fromNumber,
                  type: 'audio',
                  audio: { id: uploadData.id }
                })
              });

              if (sendVoiceRes.ok) {
                voiceSentSuccess = true;
              }
            }
          }
        } catch (err) {
          console.error("Audio generation failed:", err);
        }
      }

      // Step D: Fallback Text Reply
      if (!voiceSentSuccess && WHATSAPP_TOKEN) {
        await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: fromNumber,
            text: { body: aiReply }
          })
        });
      }

    } catch (err) {
      console.error('SERVER ERROR:', err.message);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
