// Voice-note compatibility wrapper.
// Keeps the existing webhook logic unchanged while converting ElevenLabs
// speech output to Opus/OGG before the existing WhatsApp media upload.
const originalFetch = globalThis.fetch;
const OriginalFormData = globalThis.FormData;

if (originalFetch && !globalThis.__zaraVoiceFetchPatched) {
  globalThis.__zaraVoiceFetchPatched = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('api.elevenlabs.io/v1/text-to-speech/')) {
      const u = new URL(url);
      u.searchParams.set('output_format', 'opus_48000_128');
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      headers.set('Accept', 'audio/ogg');
      return originalFetch(u.toString(), { ...init, headers });
    }
    return originalFetch(input, init);
  };
}

if (OriginalFormData && !globalThis.__zaraVoiceFormDataPatched) {
  globalThis.__zaraVoiceFormDataPatched = true;
  const originalAppend = OriginalFormData.prototype.append;
  OriginalFormData.prototype.append = function(name, value, filename) {
    if (name === 'file' && filename === 'voice.mp3' && value instanceof Blob) {
      value = new Blob([value], { type: 'audio/ogg' });
      filename = 'voice.ogg';
    }
    if (name === 'type' && value === 'audio/mpeg') value = 'audio/ogg';
    if (filename === undefined) return originalAppend.call(this, name, value);
    return originalAppend.call(this, name, value, filename);
  };
}

module.exports = require('../index.js');
