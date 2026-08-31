import express from 'express';
import { processAgentResponse } from './agentBrain.js';

const app = express();
app.use(express.json());

const memoryStore = {};

// Root Health Check & Webhook Verification
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === (process.env.VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  res.status(200).send('WhatsApp Webhook Server is Running Successfully!');
});

app.post('/', async (req, res) => {
  return handleWhatsAppWebhook(req, res);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === (process.env.VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  return handleWhatsAppWebhook(req, res);
});

async function handleWhatsAppWebhook(req, res) {
  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const customerPhone = message.from;
    const messageText = message.text?.body;

    if (!messageText) {
      return res.sendStatus(200);
    }

    if (!memoryStore[customerPhone]) {
      memoryStore[customerPhone] = [];
    }

    const chatHistory = memoryStore[customerPhone];
    const agentReply = await processAgentResponse(customerPhone, messageText, chatHistory);

    chatHistory.push({ role: "user", content: messageText });
    chatHistory.push({ role: "assistant", content: agentReply });
    if (chatHistory.length > 30) {
      chatHistory.splice(0, 2);
    }

    if (agentReply.includes('[ESCALATE_TO_HUMAN]')) {
      const cleanReply = agentReply.replace('[ESCALATE_TO_HUMAN]', '').trim();
      console.log(`[ESCALATION] Customer ${customerPhone} triggered human escalation.`);
      await sendWhatsAppMessage(customerPhone, cleanReply);
    } else {
      await sendWhatsAppMessage(customerPhone, agentReply);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Execution Error:", error.message || error);
    return res.sendStatus(500);
  }
}

async function sendWhatsAppMessage(recipientPhone, textMessage) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("CRITICAL: Missing WhatsApp API credentials (WHATSAPP_TOKEN / PHONE_NUMBER_ID) in environment variables.");
    return;
  }

  const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipientPhone,
        type: "text",
        text: { body: textMessage }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("WhatsApp Graph API Error Response:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("Failed to execute WhatsApp send fetch:", err.message);
  }
}

export default app;
