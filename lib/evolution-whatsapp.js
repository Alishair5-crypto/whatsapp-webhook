'use strict';

/**
 * EasyReach / Evolution API adapter.
 *
 * Configuration:
 * EVOLUTION_API_URL=https://your-evolution-host
 * EVOLUTION_API_KEY=...
 * EVOLUTION_INSTANCE=instance-name
 *
 * For multi-instance deployments, EVOLUTION_INSTANCES_JSON may contain:
 * {
 *   "instanceA":{"apiUrl":"https://...","apiKey":"...","tenantId":"tenant-a"},
 *   "instanceB":{"apiUrl":"https://...","apiKey":"...","tenantId":"tenant-b"}
 * }
 */

function clean(value, max = 4000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
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

  const mapped = name && map[name] && typeof map[name] === 'object' ? map[name] : {};
  const apiUrl = clean(mapped.apiUrl || process.env.EVOLUTION_API_URL, 500).replace(/\/+$/, '');
  const apiKey = clean(mapped.apiKey || process.env.EVOLUTION_API_KEY, 1000);
  const resolvedInstance = clean(name || mapped.instance || process.env.EVOLUTION_INSTANCE, 200);

  if (!apiUrl || !apiKey || !resolvedInstance) return null;
  return {
    apiUrl,
    apiKey,
    instance: resolvedInstance,
    tenantId: clean(mapped.tenantId || process.env.EVOLUTION_DEFAULT_TENANT_ID, 200) || null
  };
}

function getConfig(instance) {
  const cfg = getInstanceConfig(instance);
  if (!cfg) throw new Error('Evolution API is not configured for this instance');
  return cfg;
}

async function evolutionRequest(cfg, path, body) {
  const response = await fetch(cfg.apiUrl + path, {
    method: 'POST',
    headers: {
      apikey: cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    throw new Error(`Evolution API HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function sendText({ instance, to, text }) {
  const cfg = getConfig(instance);
  return evolutionRequest(cfg, `/message/sendText/${encodeURIComponent(cfg.instance)}`, {
    number: clean(to, 100),
    text: clean(text),
    delay: 0,
    linkPreview: false
  });
}

async function sendImage({ instance, to, url, caption }) {
  const cfg = getConfig(instance);
  return evolutionRequest(cfg, `/message/sendMedia/${encodeURIComponent(cfg.instance)}`, {
    number: clean(to, 100),
    mediatype: 'image',
    media: clean(url, 2000),
    caption: clean(caption, 1024),
    delay: 0
  });
}

function normalizeMessage(body) {
  const event = clean(body?.event || body?.eventType || '', 100).toUpperCase();
  const data = body?.data || body?.message || body;
  const key = data?.key || data?.message?.key || {};
  const message = data?.message || data?.msg || {};

  const remoteJid = clean(key?.remoteJid || data?.remoteJid || data?.from || '', 200);
  const fromMe = Boolean(key?.fromMe || data?.fromMe);
  const id = clean(key?.id || data?.id || '', 300);
  const instance = clean(body?.instance || data?.instance || process.env.EVOLUTION_INSTANCE || '', 200);
  const pushName = clean(data?.pushName || data?.pushname || body?.pushName || '', 200);

  if (!remoteJid || fromMe || !id) return null;
  if (!event.includes('MESSAGE') && !event.includes('MESSAGES_UPSERT')) return null;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return null;

  const text =
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    data?.text ||
    '';

  const messageType =
    message?.conversation ? 'text' :
    message?.extendedTextMessage ? 'text' :
    message?.imageMessage ? 'image' :
    message?.videoMessage ? 'video' :
    message?.audioMessage ? 'audio' :
    clean(data?.messageType || '', 50).toLowerCase();

  const phone = remoteJid.split('@')[0].replace(/[^0-9]/g, '');
  if (!phone) return null;

  return {
    provider: 'evolution',
    instance,
    tenantId: getInstanceConfig(instance)?.tenantId || null,
    message: {
      from: phone,
      id,
      type: messageType || 'unknown',
      text: text ? { body: clean(text) } : undefined
    },
    contact: {
      wa_id: phone,
      profile: { name: pushName }
    },
    rawEvent: event
  };
}

module.exports = {
  clean,
  getInstanceConfig,
  normalizeMessage,
  sendText,
  sendImage
};
