import express from 'express';
import { processAgentResponse } from './agentBrain.js';

const app = express();
app.use(express.json());

// WhatsApp Webhook Verification (GET)
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(200);
  }
});

// Incoming Messages Handler (POST)
app.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.value.messages && change.value.messages[0]) {
            const message = change.value.messages[0];
            const customerPhone = message.from;
            const messageText = message.text?.body || "";

            console.log(`[Incoming text] From: ${customerPhone} | Content: ${messageText}`);

            // Get response from Zara's brain
            const botReply = await processAgentResponse(customerPhone, messageText, []);

            // Send reply back via WhatsApp Cloud API
            await sendWhatsAppMessage(customerPhone, botReply);
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});

async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("WhatsApp API credentials missing in environment variables.");
    return;
  }

  await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_content: "text",
      messaging_product: "whatsapp",
      to: to,
      text: { body: text },
    }),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
