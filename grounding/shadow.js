'use strict';

const { buildEvidencePack } = require('./contracts');
const { validateClaims } = require('./validator');

// Shadow mode is deliberately side-effect free: it reports what a future
// response guard would allow/block, but never changes or sends a Zara reply.
function evaluateShadow(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Shadow input must be an object');
  }
  const evidenceEntries = input.evidence === undefined ? [] : input.evidence;
  const claims = input.claims === undefined ? [] : input.claims;
  const evidence = buildEvidencePack(evidenceEntries);
  const validation = validateClaims(claims, evidence, options);

  return Object.freeze({
    mode: 'shadow_only',
    wouldAllow: validation.allowed,
    wouldBlock: !validation.allowed,
    checkedClaims: validation.results.length,
    results: validation.results
  });
}

module.exports = { evaluateShadow };
