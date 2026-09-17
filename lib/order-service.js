'use strict';

const { saveConfirmedOrder, normalizeOrder } = require('./order-store');

/**
 * Zara Order Service
 *
 * Narrow reliability layer. It does not replace Zara's AI, WhatsApp,
 * catalogue, voice, memory, dashboard, or existing Google Sheets writer.
 * Neon is the persistence authority; Sheets remains a downstream sync.
 */
async function confirmOrder(order, phone, source = 'zara') {
  const normalized = normalizeOrder(order, phone);
  if (!normalized) {
    console.warn('[ORDER SERVICE] Validation failed; confirmation blocked');
    return { ok: false, reason: 'validation' };
  }

  const result = await saveConfirmedOrder(normalized, phone, source);
  if (!result.ok) {
    console.error('[ORDER SERVICE] Persistence failed; confirmation blocked:', result.reason);
    return { ok: false, reason: result.reason || 'persistence_failed' };
  }

  console.log('[ORDER SERVICE] Neon persistence confirmed:', result.id, result.duplicate ? 'duplicate' : 'new');
  return {
    ok: true,
    id: result.id,
    duplicate: !!result.duplicate,
    order: normalized,
  };
}

module.exports = { confirmOrder };
