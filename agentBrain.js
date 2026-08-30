import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './systemPrompt.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function processAgentResponse(customerPhone, messageText, chatHistory = []) {
  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...chatHistory,
      { role: "user", content: messageText }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || "Ji bilkul, main Fatima Arts se baat kar rahi hoon. Aap ki kis tarah rehnumai kar sakti hoon?";
  } catch (error) {
    console.error("Error in Agent Brain:", error.message);
    return "Ji, main Fatima Arts se baat kar rahi hoon. Aap ki kis tarah rehnumai kar sakti hoon?";
  }
}
