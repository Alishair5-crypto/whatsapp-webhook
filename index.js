import express from 'express';
import { processAgentResponse } from './agentBrain.js';

const app = express();
app.use(express.json());

const memoryStore = {};

// Root Health Check & Optional Webhook Catch
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(200).send('WhatsApp Webhook Server is Running Successfully!');
});

app.post('/', async (req, res) => {
  return handleWhatsAppWebhook(req, res);
});

// WhatsApp Webhook Verification Endpoint (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WhatsApp Message Handler Endpoint (POST)
app.post('/webhook', async (req, res) => {
  return handleWhatsAppWebhook(req, res);
});

// Core Webhook Processing Function
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
      console.log(`[ESCALATION TRIGGERED] Customer ${customerPhone} requested discount.`);
      await sendWhatsAppMessage(customerPhone, cleanReply);
    } else {
      await sendWhatsAppMessage(customerPhone, agentReply);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Execution Error:", error.message);
    return res.sendStatus(500);
  }
}

async function sendWhatsAppMessage(recipientPhone, textMessage) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("Missing WhatsApp API credentials in environment variables.");
    return;
  }

  const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;

  await fetch(url, {
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
}

export default app;
