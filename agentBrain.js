export async function processAgentResponse(customerPhone, messageText, chatHistory) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return "ERROR: GEMINI_API_KEY is missing in environment variables!";
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: contents,
        system_instruction: {
          parts: [{ text: "You are Zara from Fatima Arts. Reply briefly in Urdu." }]
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return `GEMINI API ERROR: ${JSON.stringify(data.error?.message || data)}`;
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return replyText || "Zara response generated successfully!";
  } catch (error) {
    return `CATCH ERROR: ${error.message || error}`;
  }
}
