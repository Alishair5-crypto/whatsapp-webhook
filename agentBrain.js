export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("FATAL: GEMINI_API_KEY is not defined in Vercel environment variables.");
    return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  }

  const modelsToTry = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"];

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const contents = (chatHistory || []).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));

      contents.push({
        role: 'user',
        parts: [{ text: messageText }]
      });

      const systemInstructionText = `
You are Zara — a warm, human-sounding team member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional
- Use customer's name in EVERY message if known
- Max 2-3 emojis per message
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"
`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: contents,
          system_instruction: { parts: [{ text: systemInstructionText }] }
        })
      });

      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      } else {
        console.warn(`Model ${model} failed with response:`, JSON.stringify(data));
      }
    } catch (err) {
      console.warn(`Exception on model ${model}:`, err.message);
    }
  }

  // If all models fail, return a warm brand response instead of error
  return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، ہمارے پاس لان اور اورجنزا کے خوبصورت ان اسٹچ سوٹس دستیاب ہیں۔ بتائیے کون سا ڈیزائن دکھاؤں؟ 😊";
}
