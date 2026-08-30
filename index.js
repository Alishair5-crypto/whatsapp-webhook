import express from 'express';
import { processAgentResponse } from './agentBrain.js';

const app = express();
app.use(express.json());

// In-memory session store fallback (or plug your database/Supabase functions here)
const memoryStore = {};

// WhatsApp Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WhatsApp Message Handler (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    
    // Extract incoming message details from Meta payload safely
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200); // Acknowledge non-message webhook events
    }

    const customerPhone = message.from; // Unique session key per customer
    const messageText = message.text?.body;

    if (!messageText) {
      return res.sendStatus(200);
    }

    // Initialize memory array for this specific phone number if it doesn't exist
    if (!memoryStore[customerPhone]) {
      memoryStore[customerPhone] = [];
    }

    const chatHistory = memoryStore[customerPhone];

    // Get response from professional agent brain
    const agentReply = await processAgentResponse(customerPhone, messageText, chatHistory);

    // Save interaction to session history (keeping last 15 messages max)
    chatHistory.push({ role: "user", content: messageText });
    chatHistory.push({ role: "assistant", content: agentReply });
    if (chatHistory.length > 30) {
      chatHistory.splice(0, 2); // Trim old messages
    }

    // Check if human escalation flag is triggered
    if (agentReply.includes('[ESCALATE_TO_HUMAN]')) {
      const cleanReply = agentReply.replace('[ESCALATE_TO_HUMAN]', '').trim();
      console.log(`[ESCALATION ALERT] Customer ${customerPhone} requires owner intervention due to bargaining.`);
      // TODO: Send WhatsApp text to owner number here if needed
    }

    // Send response back via Meta WhatsApp Cloud API
    await sendWhatsAppMessage(customerPhone, agentReply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Execution Error:", error);
    return res.sendStatus(500);
  }
});

// Helper function to send WhatsApp message via Meta Cloud API
async function sendWhatsAppMessage(recipientPhone, textMessage) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("Missing WhatsApp API Credentials in environment variables.");
    return;
  }

  const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: recipientPhone,
    type: "text",
    text: { body: textMessage }
  };

  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
