'use strict';

function isExplicitConfirmation(text) {
  const value = String(text || '').trim().replace(/[.!?؟]+$/g, '').trim();
  if (!value) return false;
  return /^(?:yes|yup|yeah|yep|jee|ji|confirm|confirmed|okay|ok|haan|han|ہاں|جی|جی ہاں|کنفرم|تصدیق)(?:\s+(?:bilkul|please|pls|confirm|confirmed|kar dein|kardein|karen|کر دیں|کردیں|کریں|بالکل|جی بالکل))*$/i.test(value);
}

function historyText(item) {
  if (Array.isArray(item?.parts)) return item.parts.map(p => p?.text || '').join('');
  return String(item?.content || item?.text || '');
}

function extractFromSummary(history, customerName) {
  const list = Array.isArray(history) ? history : [];
  let summary = '';

  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') continue;
    const text = historyText(list[i]);
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

  return parseOrderText(summary, customerName);
}

function extractFromReply(text, customerName) {
  return parseOrderText(String(text || ''), customerName);
}

function parseOrderText(text, customerName) {
  const value = String(text || '').trim();
  if (!value) return null;

  const productMatch = value.match(/(?:Product|پروڈکٹ)\s*:\s*([^•\n]+)/i)
    || value.match(/(?:order\s+for|آرڈر\s+کی)\s*(\d+(?:\.\d+)?)\s*Suit[s]?\s*[–-]\s*([^\n]+?)(?=\s*(?:is|ہے|کا\s+آرڈر|محفوظ|saved|save|confirmed|confirm|!|😊|•|$))/i);

  let product = '';
  let qty = '';
  if (productMatch) {
    if (productMatch.length >= 3 && /^\d+(?:\.\d+)?\s*Suit/i.test(productMatch[0])) {
      qty = productMatch[1];
      product = productMatch[2].trim();
    } else {
      const line = productMatch[1].trim();
      const q = line.match(/^(\d+(?:\.\d+)?)\s*Suit[s]?\s*[–-]\s*(.+)$/i);
      if (q) { qty = q[1]; product = q[2].trim(); }
    }
  }

  if (!product || !qty) {
    const q = value.match(/(?:order\s+for|آرڈر\s+کی)\s*(\d+(?:\.\d+)?)\s*Suit[s]?\s*[–-]\s*([^.!?۔؟•\n]+)/i);
    if (q) { qty = q[1]; product = q[2].trim(); }
  }

  const totalMatch = value.match(/(?:Total\s*(?:Price|Amount)|کل\s*قیمت)\s*:\s*PKR\s*[\u202f\s]*([\d,]+(?:\.\d+)?)/i);
  const paymentMatch = value.match(/(?:Payment|ادائیگی)\s*:\s*(Cash\s*on\s*Delivery|COD|JazzCash|EasyPaisa)/i);
  const addressMatch = value.match(/(?:Address|پتہ)\s*:\s*([^•\n]+)/i);
  const cityMatch = value.match(/(?:City|شہر)\s*:\s*([^•\n]+)/i);

  if (!product || !qty || !totalMatch || !paymentMatch || !addressMatch) return null;

  const quantity = Number(qty);
  const total = Number(totalMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(total) || total <= 0) return null;

  const addressFull = addressMatch[1].trim();
  const explicitCity = cityMatch?.[1]?.trim() || '';
  const cityFromAddress = addressFull.match(/(?:^|,|\s)(Faisalabad|Lahore|Karachi|Islamabad|Rawalpindi|Gujranwala|Multan|Sialkot|Peshawar|Quetta|Hyderabad)\s*$/i)?.[1] || '';
  const city = explicitCity || cityFromAddress;
  const address = addressFull;
  const name = String(customerName || '').trim();

  if (!name || !product || !address || !city) return null;

  return {
    name,
    product: product.replace(/\s+(?:is|ہے)$/i, '').trim(),
    qty: String(quantity),
    price: String(total / quantity),
    payment: paymentMatch[1].replace(/\s+/g, ' ').trim(),
    address,
    city,
  };
}

module.exports = { isExplicitConfirmation, extractFromSummary, extractFromReply };
