export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return "معذرت، API Key غائب ہے۔";
    }

    // Fixed: Using v1beta endpoint which fully supports gemini-1.5-flash generateContent
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a helpful colleague
- Use customer's name in EVERY message if known
- Max 2-3 emojis per message
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== LANGUAGE — AUTO DETECT ===
- Urdu script in → Urdu script out
- English in → English out
- Roman Urdu in → Roman Urdu out

=== PRODUCTS — ALL UNSTITCHED (Retail: PKR 3,600) ===
1. Lawn/Printed, 2. Embroidered, 3. Linen/Khaddar, 4. Kotail, 5. Karandi, 6. Marina, 7. Velvet, 8. Dhanak.
Always describe fabric feel + season + occasion FIRST. Price only when customer asks.

=== WHOLESALE ===
Shop owners (min 10 suits): PKR 2,999 per suit (Total PKR 29,990, City delivery = FREE).

=== ESCALATION ===
If customer asks for discount 3rd time, or is angry/wholesale/payment/exchange: include [ESCALATE_TO_HUMAN] in your reply.
`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: contents,
        system_instruction: {
          parts: [{ text: systemInstructionText }]
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API Error:", JSON.stringify(data));
      return "معذرت، اس وقت سسٹم میں تھوڑی مصروفیت ہے۔ میں جلد آپ سے رابطہ کرتی ہوں! 🙏";
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return replyText || "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  } catch (error) {
    console.error("Agent Brain Error:", error.message || error);
    return "معذرت، اس وقت سسٹم میں تھوڑی مصروفیت ہے۔ میں جلد آپ سے رابطہ کرتی ہوں! 🙏";
  }
}
