'use strict';

/**
 * EasyReach / Evolution API adapter.
 *
 * The webhook layer is the trust boundary:
 * - instance -> tenant mapping is resolved server-side
 * - unknown instances are rejected
 * - provider secrets never enter normalized customer events
 */

function clean(value, max = 4000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function normalizeEventName(value) {
  return clean(value, 100).toUpperCase().replace(/[.\-\s]+/g, '_');
}

function getInstanceConfig(instance) {
  const name = clean(instance, 200);
  let map = {};
  if (process.env.EVOLUTION_INSTANCES_JSON) {
    try {
      const parsed = JSON.parse(process.env.EVOLUTION_INSTANCES_JSON);
      if (parsed && typeof parsed === 'object') map = parsed;
    } catch (error) {
      console.error('[EVOLUTION CONFIG] Invalid EVOLUTION_INSTANCES_JSON:', error.message);
    }
  }

  // If a multi-tenant map exists, do NOT fall back to the global credentials for
  // an unknown instance. This prevents an attacker from selecting an arbitrary
  // instance name and inheriting the default tenant.
  if (Object.keys(map).length > 0 && (!name || !map[name] || typeof map[name] !== 'object')) return null;

  const mapped = name && map[name] && typeof map[name] === 'object' ? map[name] : {};
  const apiUrl = clean(mapped.apiUrl || process.env.EVOLUTION_API_URL, 500).replace(/\/+$/, '');
  const apiKey = clean(mapped.apiKey || process.env.EVOLUTION_API_KEY, 1000);
  const resolvedInstance = clean(name || mapped.instance || process.env.EVOLUTION_INSTANCE, 200);
  const tenantId = clean(mapped.tenantId || process.env.EVOLUTION_DEFAULT_TENANT_ID, 200) || null;

  if (!apiUrl || !apiKey || !resolvedInstance || !tenantId) return null;
  return { apiUrl, apiKey, instance: resolvedInstance, tenantId };
}

function getConfig(instance) {
  const cfg = getInstanceConfig(instance);
  if (!cfg) throw new Error('Evolution API is not configured for this instance/tenant');
  return cfg;
}

async function evolutionRequest(cfg, path, body) {
  const response = await fetch(cfg.apiUrl + path, {
    method: 'POST',
    headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) throw new Error(`Evolution API HTTP ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function sendText({ instance, to, text }) {
  const cfg = getConfig(instance);
  return evolutionRequest(cfg, `/message/sendText/${encodeURIComponent(cfg.instance)}`, {
    number: clean(to, 100), text: clean(text), delay: 0, linkPreview: false
  });
}

async function sendImage({ instance, to, url, caption }) {
  const cfg = getConfig(instance);
  return evolutionRequest(cfg, `/message/sendMedia/${encodeURIComponent(cfg.instance)}`, {
    number: clean(to, 100), mediatype: 'image', media: clean(url, 2000),
    caption: clean(caption, 1024), delay: 0
  });
}

async function sendAudio({ instance, to, audio }) {
  const cfg = getConfig(instance);
  return evolutionRequest(cfg, `/message/sendWhatsAppAudio/${encodeURIComponent(cfg.instance)}`, {
    number: clean(to, 100), audio: clean(audio, 120000), delay: 0
  });
}

async function downloadMedia({ instance, message }) {
  const cfg = getConfig(instance);
  if (!message || typeof message !== 'object') throw new Error('Evolution media message is required');
  return evolutionRequest(cfg, `/message/downloadimage`, { message });
}

function extractMedia(message, type) {
  const media = message?.[`${type}Message`] || null;
  if (!media) return null;
  const base64 = media.base64 || media.data || null;
  const url = media.url || null;
  return {
    mimetype: clean(media.mimetype || '', 120),
    url: clean(url || '', 4000) || null,
    base64: typeof base64 === 'string' ? base64 : null,
    fileLength: media.fileLength ?? null,
    duration: media.seconds ?? media.duration ?? null,
    caption: clean(media.caption || '', 2000)
  };
}

function normalizeMessage(body) {
  const event = normalizeEventName(body?.event || body?.eventType || '');
  const data = body?.data || body?.message || body;
  const key = data?.key || data?.message?.key || {};
  const message = data?.message || data?.msg || {};

  const remoteJid = clean(key?.remoteJid || data?.remoteJid || data?.from || '', 200);
  const fromMe = Boolean(key?.fromMe || data?.fromMe);
  const id = clean(key?.id || data?.id || '', 300);
  const instance = clean(body?.instance || data?.instance || '', 200);
  const pushName = clean(data?.pushName || data?.pushname || body?.pushName || '', 200);

  if (!remoteJid || fromMe || !id) return null;
  if (!['MESSAGES_UPSERT', 'MESSAGES_SET'].includes(event)) return null;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return null;

  const text =
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    data?.text || '';

  const image = extractMedia(message, 'image');
  const audio = extractMedia(message, 'audio');
  const video = extractMedia(message, 'video');
  const document = extractMedia(message, 'document');

  const messageType =
    message?.conversation ? 'text' :
    message?.extendedTextMessage ? 'text' :
    image ? 'image' :
    video ? 'video' :
    audio ? 'audio' :
    document ? 'document' :
    clean(data?.messageType || '', 50).toLowerCase();

  const phone = remoteJid.split('@')[0].replace(/[^0-9]/g, '');
  if (!phone) return null;

  const normalized = {
    provider: 'evolution',
    instance,
    tenantId: getInstanceConfig(instance)?.tenantId || null,
    eventType: event,
    eventId: id,
    message: {
      from: phone,
      id,
      type: messageType || 'unknown',
      text: text ? { body: clean(text) } : undefined,
      _evolutionRawMessage: message
    },
    contact: { wa_id: phone, profile: { name: pushName } },
    rawEvent: event
  };

  if (image) normalized.message.image = image;
  if (audio) normalized.message.audio = audio;
  if (video) normalized.message.video = video;
  if (document) normalized.message.document = document;
  return normalized;
}

function normalizeStatus(body) {
  const event = normalizeEventName(body?.event || body?.eventType || '');
  if (!['MESSAGES_UPDATE', 'SEND_MESSAGE'].includes(event)) return null;

  const data = Array.isArray(body?.data) ? body.data[0] : (body?.data || body?.message || body);
  const key = data?.key || {};
  const instance = clean(body?.instance || data?.instance || '', 200);
  const id = clean(key?.id || data?.id || '', 300);
  if (!instance || !id) return null;

  const rawStatus = data?.status ?? data?.update?.status ?? data?.message?.status;
  const statusMap = {
    0: 'ERROR', 1: 'PENDING', 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'PLAYED',
    ERROR: 'ERROR', PENDING: 'PENDING', SERVER_ACK: 'SENT', SENT: 'SENT',
    DELIVERED: 'DELIVERED', READ: 'READ', PLAYED: 'PLAYED'
  };
  const normalizedStatus = statusMap[String(rawStatus).toUpperCase()] || statusMap[Number(rawStatus)] || 'UNKNOWN';

  return {
    provider: 'evolution',
    instance,
    tenantId: getInstanceConfig(instance)?.tenantId || null,
    eventType: event,
    eventId: `${instance}:${id}:${normalizedStatus}`,
    messageId: id,
    status: normalizedStatus,
    rawStatus: rawStatus ?? null,
    remoteJid: clean(key?.remoteJid || data?.remoteJid || '', 200),
    fromMe: Boolean(key?.fromMe)
  };
}

module.exports = {
  clean,
  normalizeEventName,
  getInstanceConfig,
  normalizeMessage,
  normalizeStatus,
  sendText,
  sendImage,
  sendAudio,
  downloadMedia
};
