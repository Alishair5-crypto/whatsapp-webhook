module.exports = async (req, res) => {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1208369552366735";
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_custom_secret_123";

  // Meta Webhook Verification (GET)
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
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message && message.type === 'text') {
        const fromNumber = message.from;
        const textBody = message.text.body;

        console.log(`Received message "${textBody}" from ${fromNumber}`);

        // Native fetch request
        try {
          await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: fromNumber,
              text: { body: `AI Sales Agent: Assalam-o-Alaikum! We received your message: "${textBody}"` }
            })
          });
        } catch (err) {
          console.error('Send Error:', err.message);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send('Not Found');
  }

  res.status(405).send('Method Not Allowed');
};
