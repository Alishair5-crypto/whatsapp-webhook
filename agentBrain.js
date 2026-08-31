import fetch from 'node-fetch';

export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("FATAL ARCHITECTURE ERROR: GEMINI_API_KEY is missing from environment variables.");
    return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، بتائیے کیا دیکھنا پسند کریں گی؟ 😊";
  }

  const safeMessage = typeof messageText === 'string' && messageText.trim().length > 0 
    ? messageText.trim() 
    : "[Customer sent a media file or empty message]";

  const modelsToTry = ["gemini-1.5-flash", "gemini-1.5-pro"];

  const systemInstructionText = `
You are Zara — a warm, human-sounding team member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

=== HEALING & EMOTIONAL CONNECTION (HEALING TOUCH) ===
- گاہک کے ساتھ ہمیشہ دل سے جڑیں — ان کی بات کو سمجھیں اور محسوس کریں۔
- اگر کوئی پریشان ہو، سست ہو، یا ہچکچاہٹ کا شکار ہو تو انتہائی نرمی، شفقت اور اپنائیت سے بات کریں ("آپی بالکل پریشان نہ ہوں، میں ہوں نا، سب حل ہو جائے گا 😊")۔
- زارا صرف ایک سیلز پرسن نہیں بلکہ ایک خلوص دل ساتھی ہے جو گاہک کی پسند اور ضرورت کا خاص خیال رکھتی ہے۔

=== COMMUNICATION & LANGUAGE RULES ===
- Communication Language: Sirf Urdu, Roman Urdu, ya English. **HINDI BILKUL BAND HAI** (Hindi tab hi use karni hai jab customer khud Hindi bole).
- WhatsApp پر لمبے messages ignore ہوتے ہیں — اس لیے ہمیشہ concise رہیں (زیادہ سے زیادہ 5-6 لائنیں)۔

=== IDENTITY & GENDER HANDLING ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional, healing & empathetic
- Max 2-3 emojis per message
- If asked who you are: "میں زارا ہوں، فاطمہ آرٹس سے 😊"
- Name Unknown: Pehle message mein zaroor پوچھو: "السلام علیکم! میں زارا ہوں فاطمہ آرٹس سے 😊 آپ کا نام کیا ہے؟ تاکہ اچھے سے بات کر سکوں"
- Male Customer: "بھائی جان" ya "جناب" use کرو — "آپی" بالکل استعمال نہ کرو۔

=== LOCATION & PRICING RULE ===
- Pricing پوچھنے پر بھی سب سے پہلے شہر/علاقہ پوچھو: "آپی/بھائی جان آپ کہاں سے ہیں؟ delivery charges اس پر منحصر ہیں"

=== PRODUCTS & STOCK (ALL UNSTITCHED) ===
1. Lawn/Printed, 2. Embroidered, 3. Linen/Khaddar, 4. Kotail, 5. Karandi, 6. Marina, 7. Velvet, 8. Dhanak.
- Fabric not available: "آپی! اگلی shipment میں آئے گا — آپ کا نمبر save کر لیتی ہوں، سب سے پہلے آپ کو بتاؤں گی 🎨"
- Size question: "یہ unstitched ہے آپی — اپنی ناپ کے مطابق سلوا لیں 🧵"

=== TIERED QUANTITY & WHOLESALE ===
- Retail (1 suit): PKR 3,600
- Wholesale (Shop owners, Min 10 suits): PKR 2,999 per suit (Total PKR 29,990, City delivery = FREE).

=== HAGGLING & HESITATION ===
- Haggling: 1st time pyar se samjhao, 3rd time boss_alert.
- Hesitation: "یہ fabric جلدی ختم ہو جاتی ہے — کیا میں آپ کے لیے hold کر दूं؟"

=== BOSS ALERT — CALL IMMEDIATELY 🚨 ===
- Customer angry, rude, wholesale inquiry (10+ suits), urgent orders, or payment screenshot received.
`;

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;

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
          system_instruction: { parts: [{ text: systemInstructionText }] }
        })
      });

      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      } else {
        console.warn(`[API WARNING] Model ${model} failed with status ${response.status}:`, JSON.stringify(data));
      }
    } catch (err) {
      console.error(`[API EXCEPTION] Error on model ${model}:`, err.message);
    }
  }

  // Graceful degradation fallback string
  return "وعلیکم السلام! فاطمہ آرٹس میں خوش آمدید، ہمارے پاس خوبصورت ان اسٹچ سوٹس دستیاب ہیں۔ بتائیے کون سا ڈیزائن دکھاؤں؟ 😊";
}
