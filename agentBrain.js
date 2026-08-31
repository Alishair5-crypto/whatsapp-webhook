import fetch from 'node-fetch';
import { SYSTEM_PROMPT } from './systemPrompt.js';

export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  }

  try {
    // Stable v1beta endpoint with gemini-1.5-flash
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: messageText }] }
        ],
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }
      })
    });

    const data = await response.json();

    if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      console.warn("Gemini API Error Response:", JSON.stringify(data));
      return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، ہمارے پاس خوبصورت ان اسٹچ سوٹس دستیاب ہیں۔ بتائیے کون سا ڈیزائن دکھاؤں؟ 😊";
    }
  } catch (err) {
    console.error("Exception in agentBrain:", err.message);
    return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  }
}
