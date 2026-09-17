'use strict';

function isExplicitConfirmation(text) {
  const value = String(text || '').trim().replace(/[.!?؟]+$/g, '').trim();
  if (!value) return false;
  return /^(?:yes|yup|yeah|yep|jee|ji|confirm|confirmed|okay|ok|haan|han|ہاں|جی|جی ہاں|کنفرم|تصدیق)(?:\s+(?:bilkul|please|pls|confirm|confirmed|kar dein|kardein|karen|کر دیں|کردیں|کریں|بالکل|جی بالکل))*$/i.test(value);
}

function extractFromSummary(history, customerName) {
  const list = Array.isArray(history) ? history : [];
  let summary = '';

  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') continue;
    const text = Array.isArray(list[i]?.parts)
      ? list[i].parts.map(p => p?.text || '').join('')
      : String(list[i]?.content || list[i]?.text || '');

    const hasProduct = /Product:\s*.+/i.test(text);
    const hasTotal = /Total\s*(?:Price|Amount):\s*PKR\s*[\d,]+/i.test(text);
    const hasPayment = /Payment:\s*(?:Cash on Delivery|COD|JazzCash|EasyPaisa)/i.test(text);
    const hasAddress = /Address:\s*.+/i.test(text);
    const hasCity = /City:\s*.+/i.test(text);

    if (hasProduct && hasTotal && hasPayment && (hasAddress || hasCity)) {
      summary = text;
      break;
    }
  }

  if (!summary) return null;

  const productMatch = summary.match(/Product:\s*([^•\n]+)/i);
  const totalMatch = summary.match(/Total\s*(?:Price|Amount):\s*PKR\s*([\d,]+(?:\.\d+)?)/i);
  const paymentMatch = summary.match(/Payment:\s*(Cash on Delivery|COD|JazzCash|EasyPaisa)/i);
  const addressMatch = summary.match(/Address:\s*([^•\n]+)/i);
  const cityMatch = summary.match(/City:\s*([^•\n]+)/i);
  if (!productMatch || !totalMatch || !paymentMatch || (!addressMatch && !cityMatch)) return null;

  const productLine = productMatch[1].trim();
  const qtyMatch = productLine.match(/^(\d+(?:\.\d+)?)\s*Suit[s]?\s*-\s*/i);
  if (!qtyMatch) return null;

  const qty = Number(qtyMatch[1]);
  const total = Number(totalMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(qty) || qty < 1 || !Number.isFinite(total) || total <= 0) return null;

  const addressFull = addressMatch?.[1]?.trim() || '';
  const explicitCity = cityMatch?.[1]?.trim() || '';
  const addressParts = addressFull.split(',').map(v => v.trim()).filter(Boolean);
  const city = explicitCity || (addressParts.length > 1 ? addressParts[addressParts.length - 1] : '');
  const address = explicitCity
    ? addressFull
    : (addressParts.length > 1 ? addressParts.slice(0, -1).join(', ') : addressFull);
  const product = productLine.replace(/^\d+(?:\.\d+)?\s*Suit[s]?\s*-\s*/i, '').trim();
  const name = String(customerName || '').trim();

  if (!name || !product || !address || !city) return null;
  return {
    name,
    product,
    qty: String(qty),
    price: String(total / qty),
    payment: paymentMatch[1],
    address,
    city,
  };
}

module.exports = { isExplicitConfirmation, extractFromSummary };
