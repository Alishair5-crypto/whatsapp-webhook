'use strict';

const crypto = require('node:crypto');
const evolution = require('../lib/evolution-whatsapp');
const whatsapp = require('./index');

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getSuppliedSecret(req) {
  return req.headers?.['x-evolution-webhook-secret'] ||
    req.headers?.['x-webhook-secret'] ||
    req.headers?.apikey ||
    req.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
    '';
}

function authorized(req, instanceConfig) {
  if (!instanceConfig) return false;

  const supplied = getSuppliedSecret(req);
  const expected = String(process.env.EVOLUTION_WEBHOOK_SECRET || '').trim();

  // Preferred deployment-wide secret.
  if (expected && constantTimeEqual(supplied, expected)) return true;

  // Instance-scoped API key is accepted only for the already-resolved instance.
  // This keeps the provider credential bound to its configured tenant.
  return constantTimeEqual(supplied, instanceConfig.apiKey);
}

function rawInstance(body) {
  return String(body?.instance || body?.data?.instance || '').trim().slice(0, 200);
}

function markOnce(id) {
  if (!id) return false;
  if (!global.__easyreachEvolutionEvents) global.__easyreachEvolutionEvents = new Map();
  const now = Date.now();
  for (const [key, expiry] of global.__easyreachEvolutionEvents) {
    if (expiry <= now) global.__easyreachEvolutionEvents.delete(key);
  }
  if (global.__easyreachEvolutionEvents.has(id)) return true;
  if (global.__easyreachEvolutionEvents.size >= 2000) {
    const first = global.__easyreachEvolutionEvents.keys().next().value;
    if (first) global.__easyreachEvolutionEvents.delete(first);
  }
  global.__easyreachEvolutionEvents.set(id, now + 15 * 60 * 1000);
  return false;
}

function toMetaMessage(normalized) {
  const message = { ...normalized.message };
  // Evolution's media metadata is intentionally carried as provider metadata.
  // api/index.js/root index can consume it without pretending it came from Meta.
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: normalized.instance,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: normalized.instance,
            phone_number_id: normalized.instance
          },
          contacts: [normalized.contact],
          messages: [message]
        }
      }]
    }]
  };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('Evolution webhook active');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch (_) { return res.status(400).send('Invalid JSON'); }
  }
  body = body && typeof body === 'object' ? body : {};

  const instance = rawInstance(body);
  const instanceConfig = evolution.getInstanceConfig(instance);

  if (!instance || !instanceConfig) {
    console.warn('[EVOLUTION WEBHOOK] Unknown/unconfigured instance rejected:', instance || 'missing');
    return res.status(404).send('Unknown Evolution instance');
  }

  if (!authorized(req, instanceConfig)) {
    console.warn('[EVOLUTION WEBHOOK] Unauthorized instance:', instance);
    return res.status(401).send('Unauthorized');
  }

  const normalizedStatus = evolution.normalizeStatus(body);
  if (normalizedStatus) {
    if (!normalizedStatus.tenantId) return res.status(503).send('Evolution tenant mapping unavailable');
    if (markOnce(normalizedStatus.eventId)) return res.status(200).send('EVENT_RECEIVED');
    console.log('[EVOLUTION STATUS]', JSON.stringify({
      tenantId: normalizedStatus.tenantId,
      instance: normalizedStatus.instance,
      messageId: normalizedStatus.messageId,
      status: normalizedStatus.status
    }));
    // Status persistence is deliberately not faked here. The canonical event is
    // validated and deduplicated; the next EasyReach persistence layer will store it.
    return res.status(200).send('EVENT_RECEIVED');
  }

  const normalized = evolution.normalizeMessage(body);
  if (!normalized) return res.status(200).send('EVENT_RECEIVED');

  if (!normalized.tenantId) return res.status(503).send('Evolution tenant mapping unavailable');
  if (markOnce(normalized.eventId)) return res.status(200).send('EVENT_RECEIVED');

  req.body = toMetaMessage(normalized);

  // These headers are generated only after provider authentication and server-side
  // instance lookup. External callers cannot choose the tenant identity.
  req.headers = {
    ...(req.headers || {}),
    'x-easyreach-provider': 'evolution',
    'x-easyreach-instance': normalized.instance,
    'x-easyreach-tenant-id': normalized.tenantId
  };

  return whatsapp(req, res);
};
