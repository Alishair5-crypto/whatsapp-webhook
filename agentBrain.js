import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  try {
    // Format history for Gemini
    const contents = chatHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // Add the current user message
    contents.push({
      role: 'user',
      parts: [{ text: messageText }]
    });

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: contents,
      config: {
        systemInstruction: "You are Zara, a helpful and friendly AI sales assistant. Keep your responses concise, natural, and helpful for WhatsApp users. If the customer asks for a special discount or gets angry, include the tag [ESCALATE_TO_HUMAN] in your reply."
      }
    });

    return response.text || "Hello! How can I help you today?";
  } catch (error) {
    console.error("Error in Gemini Agent Brain:", error.message);
    return "Maaf kijiye, abhi hamara system busy hai. Main jald hi aapse baat karti hoon!";
  }
}
