'use strict';

const ALLOWED_FIELDS = new Set([
  'product_name',
  'price',
  'stock',
  'color',
  'order_status',
  'payment_status',
  'delivery_status',
  'customer_preference'
]);
const ALLOWED_STATUSES = new Set([
  'verified',
  'partial',
  'unknown',
  'conflict',
  'unavailable',
  'stale'
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object');
  }
}

function normalizeEvidence(entry) {
  assertPlainObject(entry, 'Evidence entry');
  if (!ALLOWED_FIELDS.has(entry.field)) throw new TypeError('Unsupported evidence field');
  if (typeof entry.source !== 'string' || !entry.source.trim() || entry.source.length > 100) {
    throw new TypeError('Evidence source must be a non-empty string of at most 100 characters');
  }
  if (!ALLOWED_STATUSES.has(entry.status)) throw new TypeError('Unsupported evidence status');
  if (entry.value !== null && !['string', 'number', 'boolean'].includes(typeof entry.value)) {
    throw new TypeError('Evidence value must be a string, number, boolean, or null');
  }
  if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) {
    throw new TypeError('Evidence number must be finite');
  }
  if (entry.subjectId !== undefined && (typeof entry.subjectId !== 'string' || entry.subjectId.length > 160)) {
    throw new TypeError('Evidence subjectId must be a string of at most 160 characters');
  }

  let verifiedAt = null;
  if (entry.verifiedAt !== undefined && entry.verifiedAt !== null) {
    if (typeof entry.verifiedAt !== 'string' || !Number.isFinite(Date.parse(entry.verifiedAt))) {
      throw new TypeError('Evidence verifiedAt must be a valid date string');
    }
    verifiedAt = new Date(entry.verifiedAt).toISOString();
  }
  if (entry.status === 'verified' && !verifiedAt) {
    throw new TypeError('Verified evidence requires verifiedAt');
  }

  return Object.freeze({
    field: entry.field,
    value: entry.value,
    source: entry.source.trim(),
    status: entry.status,
    verifiedAt,
    ...(entry.subjectId ? { subjectId: entry.subjectId } : {})
  });
}

function buildEvidencePack(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Evidence entries must be an array');
  return Object.freeze(entries.map(normalizeEvidence));
}

module.exports = { ALLOWED_FIELDS, ALLOWED_STATUSES, buildEvidencePack, normalizeEvidence };
