'use strict';

const crypto = require('node:crypto');
const evolution = require('../lib/evolution-whatsapp');
const whatsapp = require('./index');

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req, instance) {
  const expected = String(process.env.EVOLUTION_WEBHOOK_SECRET || '').trim();
  if (!expected) return true;

  const supplied =
    req.headers?.['x-evolution-webhook-secret'] ||
    req.headers?.['x-webhook-secret'] ||
    req.headers?.apikey ||
    '';

  const instanceConfig = evolution.getInstanceConfig(instance);
  const instanceKey = instanceConfig?.apiKey || '';

  return constantTimeEqual(supplied, expected) || (instanceKey && constantTimeEqual(supplied, instanceKey));
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('Evolution webhook active');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch (_) { return res.status(400).send('Invalid JSON'); }
  }

  const normalized = evolution.normalizeMessage(body || {});
  if (!normalized) return res.status(200).send('EVENT_RECEIVED');

  if (!authorized(req, normalized.instance)) {
    console.warn('[EVOLUTION WEBHOOK] Unauthorized instance:', normalized.instance || 'unknown');
    return res.status(401).send('Unauthorized');
  }

  if (!evolution.getInstanceConfig(normalized.instance)) {
    console.error('[EVOLUTION WEBHOOK] Instance is not configured:', normalized.instance);
    return res.status(503).send('Evolution instance not configured');
  }

  const forwardedBody = {
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
          messages: [normalized.message]
        }
      }]
    }]
  };

  req.body = forwardedBody;
  req.headers = {
    ...(req.headers || {}),
    'x-easyreach-provider': 'evolution',
    'x-easyreach-instance': normalized.instance,
    'x-easyreach-tenant-id': normalized.tenantId || ''
  };

  return whatsapp(req, res);
};
