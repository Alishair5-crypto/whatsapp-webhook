/**
 * Robust Multi-Tier Cascading AI Reply Engine
 * Tiers: 1. Gemini 2.0 Flash -> 2. Gemini 1.5 Flash -> 3. Groq Llama 3.3 -> 4. Graceful Fallback
 */
async function getAiReply(systemInstruction, history, userMessage) {
  let aiReply = null;

  // --- TIER 1: Gemini 2.0 Flash ---
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [...history, { role: 'user', parts: [{ text: userMessage }] }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (data && data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
      aiReply = data.candidates[0].content.parts[0].text;
    } else {
      console.warn('[GEMINI 2.0] Invalid response structure, falling back...');
    }
  } catch (err) {
    console.error('[GEMINI 2.0 ERROR]:', err.message);
  }

  // --- TIER 2: Gemini 1.5 Flash (Fallback) ---
  if (!aiReply) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [...history, { role: 'user', parts: [{ text: userMessage }] }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      if (data && data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
        aiReply = data.candidates[0].content.parts[0].text;
      } else {
        console.warn('[GEMINI 1.5] Invalid response structure, falling back...');
      }
    } catch (err) {
      console.error('[GEMINI 1.5 ERROR]:', err.message);
    }
  }

  // --- TIER 3: Groq Llama 3.3 (Ultimate AI Fallback) ---
  if (!aiReply && process.env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemInstruction },
            ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.parts[0].text })),
            { role: 'user', content: userMessage }
          ],
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      if (data && data.choices && data.choices[0]?.message?.content) {
        aiReply = data.choices[0].message.content;
      }
    } catch (err) {
      console.error('[GROQ FALLBACK ERROR]:', err.message);
    }
  }

  // --- TIER 4: Absolute Safe Fallback (Only if all APIs fail) ---
  if (!aiReply) {
    aiReply = "Ji, main aap ki baat sun rahi hoon. Baraye meharbani apna sawal ya order details dobara bhejiye taake main foran process kar sakoon! 🙏";
  }

  // Sanitize Markdown for WhatsApp compatibility
  return aiReply.replace(/[*_~`#]/g, '').trim();
}
