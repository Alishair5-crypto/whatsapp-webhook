// --- STEP B: LLM Response Generation (Updated Active Model) ---
      if (GEMINI_API_KEY) {
        try {
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
              },
              contents: [{
                role: "user",
                parts: [{ text: userMessageText }]
              }]
            })
          });

          if (geminiRes.ok) {
            const geminiData = await geminiRes.json();
            aiReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          } else {
            console.error("[STEP B ERROR] Gemini API error:", await geminiRes.text());
          }
        } catch (e) {
          console.error("[STEP B ERROR] Gemini Exception:", e);
        }
      }

      if (!aiReply && BASE44_API_KEY && BASE44_AGENT_ID && BASE44_CONVERSATION_ID) {
        try {
          const base44Res = await fetch(`https://app.base44.com/api/agents/${BASE44_AGENT_ID}/conversations/${BASE44_CONVERSATION_ID}/messages`, {
            method: 'POST',
            headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: userMessageText })
          });

          if (base44Res.ok) {
            const base44Data = await base44Res.json();
            const rawReply = base44Data.reply || base44Data.content || base44Data.message || base44Data.output;
            if (rawReply && typeof rawReply === 'string' && !rawReply.toLowerCase().includes('credit')) {
              aiReply = rawReply;
            }
          }
        } catch (e) {}
      }

      // --- Dynamic Fallback Handling ---
      if (!aiReply) {
        const lowerInput = userMessageText.toLowerCase().trim();
        const greetings = ['hi', 'hello', 'assalam', 'aoa', 'hey', 'salam'];
        const isGreetingOnly = greetings.some(g => lowerInput.includes(g)) && lowerInput.split(' ').length <= 3;

        if (isGreetingOnly) {
          aiReply = "Walaikum Assalam! Ji Fatima Arts mein khushamdeed. Aapko kitne suits ki requirement hai?";
        } else {
          aiReply = "Fatima Arts mein unstitched suits PKR 3,600 per suit hain (10 ya usse zyada lene par PKR 2,999 per suit). Aapko kitne suits chahiye?";
        }
      }
