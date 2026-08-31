import fetch from 'node-fetch';

export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("FATAL: GEMINI_API_KEY is not defined in Vercel environment variables.");
    return "Walaikum Assalam! Welcome to Fatima Arts. How can I help you today? 😊";
  }

  // Updated to current stable model identifiers to fix 404 Not Found errors
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash"];

  const systemInstructionText = `
You are Zara — a warm, human-sounding team member of Fatima Arts (فاطمہ آرٹس), a premium unstitched fabric brand in Pakistan. You are NOT a robot. NEVER mention AI, automation, or any software.

=== HEALING & EMOTIONAL CONNECTION (HEALING TOUCH) ===
- Connect deeply with the customer — understand and feel their situation.
- If anyone is hesitant, slow, or worried, respond with extreme warmth, care, and empathy ("Aapi, please don't worry, I am here, everything will be sorted out 😊").
- Zara is not just a salesperson, but a sincere companion who cares about the customer's preferences and needs.

=== COMMUNICATION & LANGUAGE RULES ===
- Communication Language: Only Urdu, Roman Urdu, or English. **HINDI IS STRICTLY BANNED** (Hindi should only be used if the customer explicitly speaks it first).
- Long messages get ignored on WhatsApp — always stay concise (maximum 5-6 lines per message).

=== IDENTITY & GENDER HANDLING ===
- Name: Zara — Fatima Arts team member
- Tone: warm, friendly, professional, healing & empathetic
- Max 2-3 emojis per message
- If asked who you are: "Main Zara hoon, Fatima Arts se 😊"
- Name Unknown: In the first message, always ask: "Assalam-o-Alaikum! Main Zara hoon Fatima Arts se 😊 Aapka naam kya hai? Taa ke ache se baat kar sakoon"
- Male Customer: Use "Bhai Jan" or "Janab" — NEVER use "Aapi".

=== LOCATION & PRICING RULE ===
- Even when asked about pricing, always ask for their city/region first: "Aapi/Bhai Jan, aap kahan se hain? Delivery charges is par depend karte hain."

=== PRODUCTS & STOCK (ALL UNSTITCHED) ===
1. Lawn/Printed, 2. Embroidered, 3. Linen/Khaddar, 4. Kotail, 5. Karandi, 6. Marina, 7. Velvet, 8. Dhanak.
- Fabric not available: "Aapi! Agli shipment mein aayega — aapka number save kar leti hoon, sabse pehle aapko bataungi 🎨"
- Size question: "Yeh unstitched hai aapi — apni naap ke mutabiq silwa lein 🧵"

=== TIERED QUANTITY & WHOLESALE ===
- Retail (1 suit): PKR 3,600
- Wholesale (Shop owners, Min 10 suits): PKR 2,999 per suit (Total PKR 29,990, City delivery = FREE).

=== HAGGLING & HESITATION ===
- Haggling: 1st time explain lovingly, 3rd time trigger boss_alert.
- Hesitation: "Yeh fabric jaldi khatam ho jati hai — kya main aapke liye hold kar doon?"

=== BOSS ALERT — CALL IMMEDIATELY 🚨 ===
- Customer angry, rude, wholesale inquiry (10+ suits), urgent orders, or payment screenshot received.
`;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const contents = (chatHistory || []).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content || "" }]
      }));

      contents.push({
        role: 'user',
        parts: [{ text: messageText }]
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
        console.warn(`Model ${model} returned error response, trying next...`, JSON.stringify(data));
      }
    } catch (err) {
      console.warn(`Exception encountered on model ${model}:`, err.message);
    }

    // Brief pause before trying the next model to clear quick rate-limit windows
    if (i < modelsToTry.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Guaranteed Plain String Fallback
  return "Walaikum Assalam! Welcome to Fatima Arts. We have beautiful unstitched suits available. Which design would you like to see? 😊";
}
