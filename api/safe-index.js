// Safety wrapper around the existing WhatsApp handler.
// Prevents AI-generated catalogue Blob URLs from leaking into customer-facing text.
// Catalogue images are uploaded to WhatsApp Media first so Meta does not have to fetch
// the Vercel Blob URL during message delivery.

const originalFetch = globalThis.fetch;

function isWhatsAppMessages(url) {
  return typeof url === 'string' && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url);
}

function isWhatsAppMedia(url) {
  return typeof url === 'string' && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/media(?:\?|$)/.test(url);
}

function isCatalogueBlobUrl(url) {
  return typeof url === 'string' && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url);
}

function stripCatalogueBlobUrls(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s<>"']+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function uploadCatalogueBlobToWhatsApp(blobUrl, headers, phoneNumberId) {
  if (!isCatalogueBlobUrl(blobUrl) || !phoneNumberId) return null;

  const blobResponse = await originalFetch(blobUrl, { method: 'GET' });
  if (!blobResponse.ok) {
    throw new Error(`[CATALOGUE MEDIA] Blob fetch failed: HTTP ${blobResponse.status}`);
  }

  const contentType = blobResponse.headers.get('content-type') || 'image/jpeg';
  if (!/^image\/(jpeg|png|webp)$/i.test(contentType)) {
    throw new Error(`[CATALOGUE MEDIA] Unsupported Blob content-type: ${contentType}`);
  }

  const arrayBuffer = await blobResponse.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > 10 * 1024 * 1024) {
    throw new Error(`[CATALOGUE MEDIA] Invalid image size: ${arrayBuffer.byteLength} bytes`);
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([arrayBuffer], { type: contentType }), 'catalogue-image.' + contentType.split('/')[1]);

  const mediaResponse = await originalFetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: headers.get('Authorization') || '' },
    body: form
  });

  if (!mediaResponse.ok) {
    let detail = '';
    try { detail = (await mediaResponse.clone().text()).slice(0, 500); } catch (_) {}
    throw new Error(`[CATALOGUE MEDIA] WhatsApp upload failed: HTTP ${mediaResponse.status}${detail ? `: ${detail}` : ''}`);
  }

  const mediaPayload = await mediaResponse.json();
  if (!mediaPayload?.id) throw new Error('[CATALOGUE MEDIA] WhatsApp upload returned no media id');
  return mediaPayload.id;
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

    if (payload?.type === 'image' && isCatalogueBlobUrl(payload?.image?.link)) {
      const headers = new Headers(init.headers || {});
      const phoneNumberId = String(url).match(/graph\.facebook\.com\/v\d+\.\d+\/([^/]+)\/messages/i)?.[1] || '';
      const mediaId = await uploadCatalogueBlobToWhatsApp(payload.image.link, headers, phoneNumberId);
      payload.image = { id: mediaId, ...(payload.image.caption ? { caption: payload.image.caption } : {}) };
      console.log('[CATALOGUE MEDIA] Uploaded Blob to WhatsApp media:', mediaId);
      return originalFetch(input, { ...init, headers, body: JSON.stringify(payload) });
    }
  } catch (error) {
    console.error('[OUTBOUND SANITIZER] WhatsApp payload handling failed:', error.message);
    if (typeof init.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        if (payload?.type === 'image' && isCatalogueBlobUrl(payload?.image?.link)) {
          return new Response(JSON.stringify({ error: { message: error.message } }), { status: 502, headers: { 'content-type': 'application/json' } });
        }
      } catch (_) {}
    }
  }

  return originalFetch(input, init);
};

module.exports = require('./index.js');
