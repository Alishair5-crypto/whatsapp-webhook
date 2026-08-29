module.exports = async (req, res) => {
  // Environment Variables
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const BASE44_API_KEY = process.env.BASE44_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "9BWL2FjLHABvoXxVcR8p";
  const BASE44_AGENT_ID = process.env.BASE44_AGENT_ID;
  const BASE44_CONVERSATION_ID = process.env.BASE44_CONVERSATION_ID;

  const SYSTEM_PROMPT = `Aap Zara hain — Fatima Arts ki official customer support representative (unstitched suit brand, Faisalabad).
- 1 to 9 Suits = PKR 3,600 per suit.
- 10 or more Suits = PKR 2,999 per suit.
- Tone polite, warm, aur direct concise Roman Urdu mein rakhein (1-2 short sentences maximum).
- Dynamic behavior: Agar user ne sirf greeting (Assalam-o-Alaikum / Hi) bheja hai tabhi greeting dein. Agar user ne specific question ya variety ka poocha hai, to greeting repeat kiye bina directly product detail batayein.`;

  // 1. Webhook Verification (GET Request)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'] || req.query['mode'];
    const token = req.query['hub.verify_token'] || req.query['verify_token'];
    const challenge = req.query['hub.challenge'] || req.query['challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && String(token).trim() === String(VERIFY_TOKEN).trim()) {
        console.log("WEBHOOK_VERIFIED");
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification Token Mismatch');
    }

    if (challenge) {
      return res.status(200).send(challenge);
    }

    return res.status(200).send('Webhook Endpoint Active');
  }

  // 2. Webhook Event Processing (POST Request)
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

      // --- STEP B: LLM Response Generation (Gemini 1.5 Flash - Fixed Payload Format) ---
      if (GEMINI_API_KEY) {
        try {
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: {
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
            aiReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          } else {
            console.error("[STEP B ERROR] Gemini non-OK response:", await geminiRes.text());
          }
        } catch (e) {
          console.error("[STEP B ERROR] Gemini Exception:", e);
        }
      }

      if (!aiReply && BASE44_API_KEY && BASE44_AGENT_ID && BASE44_CONVERSATION_ID) {
        try {
          const base44Res = await fetch(`https://app.base44.com/api/agents/${BASE44_AGENT_ID}/conversations/${BASE44_CONVERSATION_ID}/messages`, {
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

      // Safe Fallback
      if (!aiReply) {
        aiReply = "Ji Fatima Arts mein hamare paas premium unstitched suit collection available hai. Aapko kitne suits ki requirement hai?";
      }

      console.log("[STEP B SUCCESS] AI Generated Reply:", aiReply);

      // --- STEP C: Text-To-Speech (ElevenLabs) & Send Audio ---
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

            console.log("[STEP C] Uploading MP3 to Meta Media Endpoint...");
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
            console.log("[STEP C] Meta Media Response:", uploadData);

            if (uploadData && uploadData.id) {
              console.log("[STEP C] Delivering WhatsApp Voice Message...");
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
              } else {
                console.error("[STEP C ERROR] Meta message delivery failed:", await sendVoiceRes.text());
              }
            } else {
              console.error("[STEP C ERROR] Media ID not returned from Meta upload.");
            }
          } else {
            console.error("[STEP C ERROR] ElevenLabs TTS error:", await ttsRes.text());
          }
        } catch (err) {
          console.error("[STEP C CATCH ERROR]:", err.message);
        }
      }

      // --- STEP D: Text Fallback ---
      if (!voiceSentSuccess && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
        console.log("[STEP D] Voice failed or unavailable. Delivering text message fallback...");
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
