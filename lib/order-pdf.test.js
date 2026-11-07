'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {safeText,formatMoney}=require('./order-pdf');
test('safeText handles empty and control-character input',()=>{assert.equal(safeText('  '),'—');assert.equal(safeText('Ali\u0000 Khan'),'Ali  Khan');assert.equal(safeText(null),'—')});
test('formatMoney rejects non-finite and negative amounts',()=>{assert.equal(formatMoney(3600),'PKR 3,600');assert.throws(()=>formatMoney(NaN),/Invalid invoice amount/);assert.throws(()=>formatMoney(-1),/Invalid invoice amount/)});
