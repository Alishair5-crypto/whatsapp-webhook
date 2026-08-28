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

  const SYSTEM_PROMPT = `You are Zara, a polite sales assistant at Fatima Arts (unstitched suit brand).
- Fabrics: Lawn, Khaddar, Marina, Velvet, Cotton.
- Prices start from PKR 3,600 per suit.
- Keep responses short, concise (1-2 lines), and in polite Roman Urdu mixed with English. Never use Hindi words.`;

  // Webhook Verification (GET Request)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send('Forbidden');
  }

  // Webhook Event Processing (POST Request)
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { 
      try { body = JSON.parse(body); } catch (e) { console.error("JSON Parse Error:", e); } 
    }

    console.log("INCOMING_WEBHOOK_BODY:", JSON.stringify(body));

    const entry = body?.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      console.log("NO_MESSAGE_FOUND_IN_PAYLOAD");
      return res.status(200).send('EVENT_RECEIVED');
    }

    const fromNumber = message.from;
    let userMessageText = "";
    let isAudioIncoming = false;

    try {
      // 1. Process Voice / Text Message
      if (message.type === 'text') {
        userMessageText = message.text?.body || "";
      } else if ((message.type === 'audio' || message.type === 'voice') && GROQ_API_KEY) {
        isAudioIncoming = true;
        const mediaId = message.audio?.id || message.voice?.id;
        console.log("PROCESSING_AUDIO_MEDIA_ID:", mediaId);

        const mediaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
          headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaData = await mediaRes.json();

        if (mediaData.url) {
          const audioStream = await fetch(mediaData.url, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
          });
          const audioBuffer = Buffer.from(await audioStream.arrayBuffer());

          const formData = new globalThis.FormData();
          formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
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
            console.log("TRANSCRIBED_TEXT:", userMessageText);
          } else {
            console.error("GROQ_ERROR:", await groqRes.text());
          }
        }
      }

      if (!userMessageText) userMessageText = "Hello";
      let aiReply = "";

      // 2. Fetch AI Response (Base44 -> Gemini Fallback)
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

      if (!aiReply && GEMINI_API_KEY) {
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
      }

      if (!aiReply) aiReply = "Assalam-o-Alaikum! Fatima Arts mein khushamdeed. Main aap ki kya madad kar sakti hoon?";

      // 3. Audio Reply generation via ElevenLabs
      if (isAudioIncoming && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
        console.log("GENERATING_ELEVENLABS_AUDIO...");
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: aiReply,
            model_id: "eleven_multilingual_v2"
          })
        });

        if (ttsRes.ok) {
          const audioArrayBuffer = await ttsRes.arrayBuffer();
          const audioBuffer = Buffer.from(audioArrayBuffer);

          const mediaFormData = new globalThis.FormData();
          mediaFormData.append('messaging_product', 'whatsapp');
          mediaFormData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mpeg' }), 'response.mp3');
          mediaFormData.append('type', 'audio/mpeg');

          const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
            body: mediaFormData
          });

          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: fromNumber,
                type: 'audio',
                audio: { id: uploadData.id }
              })
            });
            console.log("VOICE_NOTE_SENT_SUCCESSFULLY");
            return res.status(200).send('EVENT_RECEIVED');
          } else {
            console.error("WHATSAPP_MEDIA_UPLOAD_FAILED:", await uploadRes.text());
          }
        } else {
          console.error("ELEVENLABS_TTS_FAILED:", await ttsRes.text());
        }
      }

      // Fallback Text Reply
      await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: fromNumber,
          text: { body: aiReply }
        })
      });

    } catch (err) {
      console.error('SERVER_ERROR:', err.message);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
