// Voice-note compatibility wrapper.
// Keeps the verified voice pipeline intact and adds a TTS/text Urdu normalization
// layer. Original AI reasoning/history is untouched; only outgoing customer text
// and ElevenLabs TTS input are normalized for clearer Pakistani Urdu pronunciation.
const originalFetch = globalThis.fetch;

const URDU_NORMALIZATION = [
  // Fabric / product vocabulary
  ['مارینا', 'مرینہ'],
  ['مارینا فیبرک', 'مرینہ فیبرک'],
  ['ویلٹ', 'ویلویٹ'],
  ['ویلویٹ', 'ویلویٹ'],
  ['فابریکس', 'فیبرکس'],
  ['فابریک', 'فیبرک'],
  ['فیبرکس', 'فیبرکس'],
  ['سوٹس', 'سوٹس'],
  ['سوٹ', 'سوٹ'],
  ['رچ', 'شاندار'],
  ['پریمیم', 'اعلیٰ معیار کا'],
  ['کوالٹی', 'معیار'],
  ['کلر', 'رنگ'],
  ['کلرز', 'رنگ'],
  ['ڈیزائن', 'ڈیزائن'],
  ['پرنٹڈ', 'پرنٹ شدہ'],
  ['ایمبروئیڈری', 'کڑھائی'],
  ['ایمبروئیڈرڈ', 'کڑھائی والا'],
  ['کلیکشن', 'کلیکشن'],
  ['آرڈر', 'آرڈر'],
  ['ایویلیبل', 'دستیاب'],
  ['ایویلیبل ہیں', 'دستیاب ہیں'],
  // Common Urdu speech spellings
  ['براہ کرم', 'براہِ کرم'],
  ['مہربانی کر کے', 'مہربانی کرکے'],
  ['آپکو', 'آپ کو'],
  ['آپکے', 'آپ کے'],
  ['آپکی', 'آپ کی'],
  ['اسکے', 'اس کے'],
  ['اسکی', 'اس کی'],
  ['انکے', 'ان کے'],
  ['انکی', 'ان کی'],
  ['کہتےہیں', 'کہتے ہیں'],
  ['چاہتےہیں', 'چاہتے ہیں'],
  ['ہیں—', 'ہیں — '],
  ['ہے—', 'ہے — ']
];

function normalizeUrdu(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.normalize('NFC');
  // Remove emojis/symbol pictographs from TTS only; keep them for text.
  for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to);
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

function normalizeUrduText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.normalize('NFC');
  for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to);
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return out;
}

function isElevenLabsTTS(url) {
  return url && url.includes('api.elevenlabs.io/v1/text-to-speech/');
}

function isWhatsAppSend(url) {
  return url && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url);
}

if (originalFetch && !globalThis.__zaraVoiceFetchPatched) {
  globalThis.__zaraVoiceFetchPatched = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));

    // ElevenLabs: use the Urdu-capable v3 model and pronunciation-normalized text.
    if (isElevenLabsTTS(url)) {
      headers.set('Accept', 'audio/mpeg');
      let body = init.body;
      if (typeof body === 'string') {
        try {
          const payload = JSON.parse(body);
          payload.model_id = 'eleven_v3';
          payload.language_code = 'ur';
          if (typeof payload.text === 'string') payload.text = normalizeUrdu(payload.text);
          body = JSON.stringify(payload);
        } catch (_) {
          // Preserve non-JSON bodies.
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

    // WhatsApp text: apply the same Urdu wording normalization to customer-visible text.
    // This is limited to outbound /messages calls and does not alter AI prompts/history.
    if (isWhatsAppSend(url) && typeof init.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        if (payload?.type === 'text' && typeof payload?.text?.body === 'string') {
          payload.text.body = normalizeUrduText(payload.text.body);
          return originalFetch(input, { ...init, headers, body: JSON.stringify(payload) });
        }
      } catch (_) {
        // Preserve the original request if it is not JSON.
      }
    }

    return originalFetch(input, init);
  };
}

module.exports = require('../index.js');
