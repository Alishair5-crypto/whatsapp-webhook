'use strict';

const { ALLOWED_FIELDS } = require('./contracts');

function comparable(value) {
  if (typeof value === 'string') return value.normalize('NFC').trim().toLocaleLowerCase('en');
  return value;
}

function evaluateClaim(claim, evidence, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
    ? options.maxAgeMs
    : 15 * 60 * 1000;

  if (!claim || typeof claim !== 'object' || Array.isArray(claim) ||
      !ALLOWED_FIELDS.has(claim.field) ||
      !Object.prototype.hasOwnProperty.call(claim, 'value') ||
      (claim.subjectId !== undefined && typeof claim.subjectId !== 'string')) {
    return { allowed: false, reason: 'invalid_claim' };
  }

  const matching = evidence.filter(item =>
    item.field === claim.field &&
    (item.subjectId || '') === (claim.subjectId || '')
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

  const evidenceTime = Date.parse(verified[0].verifiedAt);
  if (!Number.isFinite(evidenceTime) || evidenceTime > now || now - evidenceTime > maxAgeMs) {
    return { allowed: false, reason: 'evidence_stale' };
  }

  if (comparable(verified[0].value) !== comparable(claim.value)) {
    return { allowed: false, reason: 'claim_mismatch' };
  }

  return {
    allowed: true,
    reason: 'verified_match',
    source: verified[0].source,
    verifiedAt: verified[0].verifiedAt
  };
}

function validateClaims(claims, evidence, options = {}) {
  if (!Array.isArray(claims)) throw new TypeError('Claims must be an array');
  if (!Array.isArray(evidence)) throw new TypeError('Evidence must be an array');

  const results = claims.map(claim => evaluateClaim(claim, evidence, options));
  return {
    allowed: results.every(result => result.allowed),
    results
  };
}

module.exports = { evaluateClaim, validateClaims };
