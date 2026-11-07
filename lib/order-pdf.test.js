'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateOrderPdf,safeText,formatMoney}=require('./order-pdf');

test('safeText handles empty and control-character input',()=>{assert.equal(safeText('  '),'—');assert.equal(safeText('Ali\u0000 Khan'),'Ali  Khan');assert.equal(safeText(null),'—')});
test('formatMoney rejects non-finite and negative amounts',()=>{assert.equal(formatMoney(3600),'PKR 3,600');assert.throws(()=>formatMoney(NaN),/Invalid invoice amount/);assert.throws(()=>formatMoney(-1),/Invalid invoice amount/)});
test('generateOrderPdf returns a valid PDF buffer for a persisted order',async()=>{const pdf=await generateOrderPdf({id:'FA-0123456789',date:'2026-11-07T08:00:00.000Z',name:'Test Customer',phone:'923001234567',product:'Printed Lawn Suit',quantity:2,unitPrice:3600,total:7200,payment:'COD',address:'House 10, Street 2',city:'Faisalabad',status:'Pending'});assert.ok(Buffer.isBuffer(pdf));assert.ok(pdf.length>500);assert.equal(pdf.subarray(0,5).toString('ascii'),'%PDF-')});
test('generateOrderPdf rejects malformed order identifiers and amounts',async()=>{await assert.rejects(()=>generateOrderPdf({id:'bad',quantity:1,unitPrice:100,total:100}),/valid saved order/);await assert.rejects(()=>generateOrderPdf({id:'FA-0123456789',quantity:0,unitPrice:100,total:0}),/amounts are invalid/)});
