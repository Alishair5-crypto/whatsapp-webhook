import fetch from 'node-fetch';
import { SYSTEM_PROMPT } from './systemPrompt.js';

export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("FATAL ARCHITECTURE ERROR: GEMINI_API_KEY is missing from environment variables.");
    return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  }

  const safeMessage = typeof messageText === 'string' && messageText.trim().length > 0 
    ? messageText.trim() 
    : "[Customer sent a media file or empty message]";

  // Using v1beta endpoint with stable fallback models
  const modelsToTry = ["gemini-1.5-flash", "gemini-pro"];

  for (const model of modelsToTry) {
    try {
      // Switched from v1 to v1beta to resolve 404 model routing errors
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const contents = (chatHistory || []).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(msg.content || "") }]
      }));

      contents.push({
        role: 'user',
        parts: [{ text: safeMessage }]
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: contents,
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }
        })
      });

      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      } else {
        console.warn(`[ARCHITECTURAL WARNING] Model ${model} failed with status ${response.status}:`, JSON.stringify(data));
      }
    } catch (err) {
      console.error(`[ARCHITECTURAL EXCEPTION] Error on model ${model}:`, err.message);
    }
  }

  return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، ہمارے پاس خوبصورت ان اسٹچ سوٹس دستیاب ہیں۔ بتائیے کون سا ڈیزائن دکھاؤں؟ 😊";
}
