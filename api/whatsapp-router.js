'use strict';
const original=require('./sheet-order-fix');
const {isHuman,getConversation,saveConversation}=require('../lib/human-control');
const {saveConfirmedOrder}=require('../lib/order-store');
const clean=v=>String(v??'').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,4000);
const orderHint=t=>/(\border\b|\bbuy\b|\bbook\b|\bpayment\b|\bcod\b|cash on delivery|jazzcash|easypaisa|address|pata|city|shehar|آرڈر|ادائیگی|پتہ|شہر|منگوانا|خرید)/i.test(String(t||''));
async function captureConfirmedOrder(phone,current){
 if(!phone||!orderHint(current)||!process.env.GROQ_API_KEY||!process.env.DATABASE_URL)return;
 try{
  const old=await getConversation(phone);const history=Array.isArray(old?.history)?old.history.slice(-20):[];
  const transcript=history.map(m=>`${m?.role==='user'?'CUSTOMER':'ZARA'}: ${m?.parts?.map(p=>p?.text||'').join('')||''}`).join('\n').slice(-9000)+`\nCUSTOMER: ${current}`;
  const prompt=`Extract a confirmed order ONLY when the customer has explicitly confirmed every required field across the conversation. Required: name, product, qty, price, payment (COD/JazzCash/EasyPaisa), full delivery address, city. Never guess or infer missing values. If ANY field is missing or only suggested by Zara, return {"confirmed":false}. Return JSON only with keys confirmed,name,product,qty,price,payment,address,city.\n\n${transcript}`;
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${String(process.env.GROQ_API_KEY).trim()}`,'Content-Type':'application/json'},body:JSON.stringify({model:'openai/gpt-oss-120b',messages:[{role:'system',content:'You are a strict order validator. Never guess. JSON only.'},{role:'user',content:prompt}],temperature:0,max_tokens:260,response_format:{type:'json_object'}})});
  if(!r.ok)return;const d=await r.json();const raw=d?.choices?.[0]?.message?.content;if(!raw)return;const o=JSON.parse(raw);if(o?.confirmed!==true)return;
  const result=await saveConfirmedOrder(o,phone,'whatsapp-webhook');if(result.ok)console.log('[ORDER DB] Confirmed order persisted',result.id,result.duplicate?'duplicate':'new');
 }catch(e){console.error('[ORDER CAPTURE]',e?.message||e)}
}
module.exports=async(req,res)=>{
 if(req.method==='POST'){
  try{
   let body=req.body;if(typeof body==='string')body=JSON.parse(body||'{}');
   const msg=body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
   if(msg?.from && await isHuman(msg.from)){
    const phone=clean(msg.from);let text='';
    if(msg.type==='text')text=clean(msg.text?.body);else if(msg.type==='audio'||msg.type==='voice')text='[Customer sent a voice message]';else text=`[Customer sent ${clean(msg.type||'message')}]`;
    if(text){const old=await getConversation(phone);const history=Array.isArray(old?.history)?old.history:[];history.push({role:'user',parts:[{text}]});await saveConversation(phone,old?.customer_name||'',history)}
    console.log('[HUMAN TAKEOVER] AI bypassed for',phone);return res.status(200).send('EVENT_RECEIVED');
   }
   if(msg?.from&&msg.type==='text')captureConfirmedOrder(clean(msg.from),clean(msg.text?.body)).catch(()=>{});
  }catch(e){console.error('[HUMAN ROUTER]',e.message)}
 }
 return original(req,res);
};
