// Voice-note compatibility wrapper.
// Root cause fix: the webhook was sending Urdu to Flash v2.5, which does not
// support Urdu. Eleven v3 does, so normalize the TTS request to v3 here while
// keeping the existing webhook flow intact.
const originalFetch = globalThis.fetch;

if (originalFetch && !globalThis.__zaraVoiceFetchPatched) {
  globalThis.__zaraVoiceFetchPatched = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('api.elevenlabs.io/v1/text-to-speech/')) {
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      headers.set('Accept', 'audio/mpeg');

      let body = init.body;
      if (typeof body === 'string') {
        try {
          const payload = JSON.parse(body);
          payload.model_id = 'eleven_v3';
          payload.language_code = 'ur';
          body = JSON.stringify(payload);
        } catch (_) {
          // Preserve the original body if it is not JSON.
        }
      }

      const response = await originalFetch(input, { ...init, headers, body });

      if (!response.ok) {
        try {
          const errorBody = await response.clone().text();
          const requestId = response.headers.get('request-id') || response.headers.get('x-request-id') || null;
          console.error('[ELEVENLABS HTTP ERROR]', JSON.stringify({
            status: response.status,
            contentType: response.headers.get('content-type') || null,
            requestId,
            body: errorBody.slice(0, 2000)
          }));
        } catch (e) {
          console.error('[ELEVENLABS HTTP ERROR] Failed to read error body:', e.message);
        }
      }

      return response;
    }
    return originalFetch(input, init);
  };
}

module.exports = require('../index.js');
