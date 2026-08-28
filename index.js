module.exports = async (req, res) => {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1208369552366735";
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_custom_secret_123";
  const BASE44_API_KEY = process.env.BASE44_API_KEY || "f7539dd0947f4f1a8a1434b8e3c03f71";
  
  const AGENT_ID = "6a7258c617116e6f8bdaee29";
  const CONVERSATION_ID = "6a7258ca11d24606478a2812";

  // Webhook Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Incoming WhatsApp Messages (POST)
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    if (body && body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message) {
        const fromNumber = message.from;
        const textBody = message.text?.body || message.caption || "";

        try {
          // 1. Send Message to exact Base44 Conversation Path
          const base44Res = await fetch(`https://app.base44.com/api/agents/${AGENT_ID}/conversations/${CONVERSATION_ID}/messages`, {
            method: 'POST',
            headers: {
              'api_key': BASE44_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: textBody })
          });

          const base44Data = await base44Res.json();
          console.log('BASE44_REPLY:', JSON.stringify(base44Data));

          // Reply string parsing
          const aiReply = base44Data.reply || 
                          base44Data.content || 
                          base44Data.message || 
                          base44Data.output || 
                          (Array.isArray(base44Data) && base44Data[0]?.content) ||
                          "Assalam-o-Alaikum! How can I assist you?";

          // 2. Forward AI Response to Customer on WhatsApp
          await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: fromNumber,
              text: { body: aiReply }
            })
          });

        } catch (err) {
          console.error('PIPELINE_ERROR:', err.message);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.status(405).send('Method Not Allowed');
};
