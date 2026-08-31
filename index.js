import express from 'express';
import fetch from 'node-fetch';
import { processAgentResponse } from './agentBrain.js';

const app = express();
app.use(express.json());

// 1. Webhook Verification (GET) for Meta/WhatsApp setup & Browser landing
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "fatima_arts_secure_token";

  // Meta Webhook Verification check
  if (mode && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    return res.status(200).send(challenge);
  } 

  // Friendly status response if opened directly in a browser (prevents raw 403 Forbidden)
  return res.status(200).send("✨ Zara is active and running for Fatima Arts WhatsApp Webhook! 🌸");
});

// 2. Incoming Messages & Events Handler (POST)
app.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messageObj = value?.messages?.[0];

      if (messageObj) {
        const customerPhone = messageObj.from;
        const messageType = messageObj.type;

        let messageText = "";

        // Handle different incoming message types safely
        if (messageType === 'text') {
          messageText = messageObj.text.body;
        } else if (messageType === 'audio' || messageType === 'voice') {
          // Gracefully handle voice notes so Zara responds instead of going silent
          messageText = "[Customer sent a voice note. Reply warmly in Roman Urdu/Urdu: 'آپی، میں ابھی آپ کی وائس نوٹ سن نہیں سکی، براہ کرم لکھ کر بتا دیں تاکہ میں آپ کی بہتر رہنمائی کر سکوں 😊']";
        } else {
          messageText = "[Customer sent an attachment or media file]";
        }

        console.log(`[Incoming ${messageType}] From: ${customerPhone} | Content: ${messageText}`);

        // Process response through Zara's brain
        const agentReply = await processAgentResponse(customerPhone, messageText, []);

        // Send reply back via WhatsApp Cloud API
        await sendWhatsAppMessage(customerPhone, agentReply);
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.sendStatus(404);
  } catch (error) {
    console.error("Error processing webhook:", error);
    return res.status(200).send('EVENT_RECEIVED'); // Always return 200 to Meta to avoid retry spam
  }
});

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(recipientPhone, messageText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("WhatsApp API credentials missing in environment variables.");
    return;
  }

  const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipientPhone,
      text: { body: messageText }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Failed to send WhatsApp message:", JSON.stringify(data));
  } else {
    console.log("WhatsApp message sent successfully to:", recipientPhone);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
