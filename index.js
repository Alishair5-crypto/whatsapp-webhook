const axios = require('axios');

// Aap ke live screen shot ki exact details:
const PHONE_NUMBER_ID = "1208369552366735";
const WHATSAPP_TOKEN = "YOUR_SYSTEM_USER_PERMANENT_TOKEN"; // Meta token yahan enter karein
const VERIFY_TOKEN = "my_custom_secret_123";

module.exports = async (req, res) => {
  // Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Incoming Messages (POST)
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

        // Live Number Se Auto Reply Send Karein
        try {
          await axios.post(
            `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: fromNumber,
              text: { body: `AI Sales Agent: Welcome! We received your message: "${textBody}"` }
            },
            {
              headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );
        } catch (err) {
          console.error('Send Error:', err.response?.data || err.message);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(404).send('Not Found');
  }

  res.status(405).send('Method Not Allowed');
};
