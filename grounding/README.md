# Grounding Agent — isolated shadow prototype

## Scope and safety boundary

This module is a pure, deterministic evaluator. It accepts caller-supplied evidence and candidate factual claims, then reports whether each claim would be permitted. It does **not**:
- import or call Zara's webhook, AI providers, WhatsApp, Neon, Google Sheets, dashboard, or customer-memory modules;
- read/write a database or network resource;
- modify, suppress, rewrite, or send a customer-facing response;
- enable itself in production.

The branch is intentionally isolated. Integration requires a separate review and explicit approval.

## Evidence contract

Each evidence item has:
- `field`: one of `product_name`, `price`, `stock`, `color`, `order_status`, `payment_status`, `delivery_status`, `customer_preference`;
- `value`: string, finite number, boolean, or null for non-verified states;
- `source`: non-empty source identifier;
- `status`: `verified`, `partial`, `unknown`, `conflict`, `unavailable`, or `stale`;
- `verifiedAt`: valid timestamp; mandatory for `verified`;
- `subjectId`: mandatory product/order/customer scope identifier (maximum 160 characters).

Verified evidence must have a non-null value. String values are limited to 1000 characters. Evidence and claim batches are capped at 500 items. Customer preference is an allowed evidence field for preference matching only. It is not an authority for price, inventory, payment, delivery, or policy facts.

## Evaluation rules

Only fresh, verified, subject-matched evidence can authorize an exact claim. Missing, partial, unknown, unavailable, stale, conflicting, future-dated, or mismatched evidence blocks the claim. Default freshness is 15 minutes; callers can supply a field-appropriate policy after review.

## Example

```js
const { evaluateShadow } = require('./shadow');

const result = evaluateShadow({
  claims: [{ field: 'price', value: 4500, subjectId: 'product-1' }],
  evidence: [{
    field: 'price',
    value: 4500,
    source: 'catalogue_products',
    status: 'verified',
    verifiedAt: new Date().toISOString(),
    subjectId: 'product-1'
  }]
});

console.log(result); // mode: shadow_only; no customer reply is touched
```

## Test

Run from repository root:

```sh
node --test grounding/grounding.test.js
```

## Not implemented in this prototype

Evidence retrieval from Neon, claim extraction from model output, authoritative source mapping, per-field freshness policy, durable audit logging, metrics, and customer-facing enforcement. These remain separate design/review tasks. Do not treat caller-supplied `status: verified` as trustworthy until the evidence builder is connected to authenticated authoritative sources.
