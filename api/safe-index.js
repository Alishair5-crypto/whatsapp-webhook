// Safety wrapper around the existing WhatsApp handler.
// Prevents AI-generated catalogue Blob URLs from leaking into customer-facing text.
// Image messages continue to use the backend's verified image sender unchanged.

const originalFetch = globalThis.fetch;

function isWhatsAppMessages(url) {
  return typeof url === 'string' && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url);
}

function stripCatalogueBlobUrls(text) {
  if (typeof text !== 'string') return text;
  // Catalogue image delivery is a backend responsibility. Never expose Blob URLs in chat text.
  return text
    .replace(/https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s<>"']+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (!isWhatsAppMessages(url) || typeof init.body !== 'string') {
    return originalFetch(input, init);
  }

  try {
    const payload = JSON.parse(init.body);
    if (payload?.type === 'text' && typeof payload?.text?.body === 'string') {
      payload.text.body = stripCatalogueBlobUrls(payload.text.body);
      return originalFetch(input, { ...init, body: JSON.stringify(payload) });
    }
  } catch (error) {
    console.error('[OUTBOUND SANITIZER] Invalid WhatsApp payload:', error.message);
  }

  return originalFetch(input, init);
};

module.exports = require('./index.js');
