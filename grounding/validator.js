'use strict';

const { ALLOWED_FIELDS, MAX_EVIDENCE_ITEMS } = require('./contracts');
const MAX_CLAIMS = 500;

function comparable(value) {
  if (typeof value === 'string') return value.normalize('NFC').trim().toLocaleLowerCase('en');
  return value;
}

function evaluateClaim(claim, evidence, options = {}) {
  if (!Array.isArray(evidence)) throw new TypeError('Evidence must be an array');
  if (evidence.length > MAX_EVIDENCE_ITEMS) throw new RangeError('Evidence pack exceeds 500 items');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Validation options must be an object');
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
    ? options.maxAgeMs
    : 15 * 60 * 1000;

  if (!claim || typeof claim !== 'object' || Array.isArray(claim) ||
      !ALLOWED_FIELDS.has(claim.field) ||
      !Object.prototype.hasOwnProperty.call(claim, 'value') ||
      claim.value === null ||
      !['string', 'number', 'boolean'].includes(typeof claim.value) ||
      (typeof claim.value === 'string' && claim.value.length > 1000) ||
      (typeof claim.value === 'number' && !Number.isFinite(claim.value)) ||
      typeof claim.subjectId !== 'string' ||
      !claim.subjectId.trim() ||
      claim.subjectId.length > 160) {
    return { allowed: false, reason: 'invalid_claim' };
  }

  const matching = evidence.filter(item =>
    item.field === claim.field &&
    item.subjectId === claim.subjectId.trim()
  );
  if (!matching.length) return { allowed: false, reason: 'evidence_missing' };

  const conflicts = matching.filter(item => item.status === 'conflict');
  if (conflicts.length) return { allowed: false, reason: 'evidence_conflict' };

  const verified = matching.filter(item => item.status === 'verified');
  if (!verified.length) {
    const status = matching.some(item => item.status === 'stale') ? 'evidence_stale'
      : matching.some(item => item.status === 'unavailable') ? 'evidence_unavailable'
      : matching.some(item => item.status === 'partial') ? 'evidence_partial'
      : 'evidence_unverified';
    return { allowed: false, reason: status };
  }

  const values = new Set(verified.map(item => comparable(item.value)));
  if (values.size > 1) return { allowed: false, reason: 'evidence_conflict' };

  const latestEvidenceTime = Math.max(...verified.map(item => Date.parse(item.verifiedAt)));
  if (!Number.isFinite(latestEvidenceTime) || latestEvidenceTime > now || now - latestEvidenceTime > maxAgeMs) {
    return { allowed: false, reason: 'evidence_stale' };
  }

  if (comparable(verified[0].value) !== comparable(claim.value)) {
    return { allowed: false, reason: 'claim_mismatch' };
  }

  const latest = verified.find(item => Date.parse(item.verifiedAt) === latestEvidenceTime);
  return {
    allowed: true,
    reason: 'verified_match',
    source: latest.source,
    verifiedAt: latest.verifiedAt
  };
}

function validateClaims(claims, evidence, options = {}) {
  if (!Array.isArray(claims)) throw new TypeError('Claims must be an array');
  if (claims.length > MAX_CLAIMS) throw new RangeError('Claims batch exceeds 500 items');
  if (!Array.isArray(evidence)) throw new TypeError('Evidence must be an array');
  if (evidence.length > MAX_EVIDENCE_ITEMS) throw new RangeError('Evidence pack exceeds 500 items');

  const results = claims.map(claim => evaluateClaim(claim, evidence, options));
  return {
    allowed: results.every(result => result.allowed),
    results
  };
}

module.exports = { evaluateClaim, validateClaims, MAX_CLAIMS };
