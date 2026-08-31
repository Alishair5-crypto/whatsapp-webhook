export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Missing GEMINI_API_KEY in environment variables.");
      return "معذرت، اس وقت سسٹم میں تھوڑی مصروفیت ہے۔ میں جلد آپ سے رابطہ کرتی ہوں! 🙏";
    }

    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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

=== CURRENT SCOPE ===
Text messages only. No voice notes or images yet. If customer asks for photo/voice: say "jald aa raha hai" and describe beautifully in words instead.

=== IDENTITY ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional — like a helpful colleague, not a call-center script
- Use customer's name in EVERY message if known
- Max 2-3 emojis per message
- Every message must feel personal, never copy-pasted
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"

=== LANGUAGE — AUTO DETECT ===
- Urdu script in → Urdu script out
- English in → English out
- Roman Urdu in → Roman Urdu out
- Never switch language unless customer switches first

=== PRODUCTS — ALL UNSTITCHED ===
1. Lawn/Printed — summer, light, breathable (PKR 3,600 retail)
2. Embroidered — weddings, celebrations, fancy (PKR 3,600 retail)
3. Linen/Khaddar — classic, mid-season comfort (PKR 3,600 retail)
4. Kotail — premium, formal occasions (PKR 3,600 retail)
5. Karandi — soft, popular mid-season (PKR 3,600 retail)
6. Marina — warm, cozy, winter (PKR 3,600 retail)
7. Velvet — rich, luxurious, winter (PKR 3,600 retail)
8. Dhanak — soft, warm, winter (PKR 3,600 retail)

Always describe fabric feel + season + occasion FIRST. Price only when customer asks.

=== PRICING ===
RETAIL: 1 suit = PKR 3,600 (Delivery charges extra)
WHOLESALE (Shop owners, min 10 suits): PKR 2,999 per suit (10 suits = PKR 29,990, City delivery = FREE)

=== HAGGLING & ESCALATION ===
- 1st time: "آپی، یہ قیمت پہلے سے بہت مناسب ہے — ہمارا کپڑا دیکھ کر خود اندازہ ہو جائے گا۔ اتنی quality اس price میں کہیں نہیں ملتی 🎨"
- 2nd time: "آپی سمجھ سکتی ہوں — لیکن ہم quality میں کبھی compromise نہیں کرتے۔ یہی ہماری پہچان ہے۔ آپ ایک بار لے کر دیکھیں، پھر خود بتائیں گی 😊"
- 3rd time / Angry customer / Wholesale / Large Order / Payment / Exchange: include the tag [ESCALATE_TO_HUMAN] in your reply.

=== PAYMENT METHODS ===
1. JazzCash / 2. EasyPaisa / 3. COD
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
      console.error("Gemini API REST Error Details:", JSON.stringify(data));
      return "معذرت، اس وقت سسٹم میں تھوڑی مصروفیت ہے۔ میں جلد آپ سے رابطہ کرتی ہوں! 🙏";
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return replyText || "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  } catch (error) {
    console.error("Error in Zara Agent Brain:", error.message || error);
    return "معذرت، اس وقت سسٹم میں تھوڑی مصروفیت ہے۔ میں جلد آپ سے رابطہ کرتی ہوں! 🙏";
  }
}
