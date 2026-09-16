'use strict';
const original=require('./sheet-order-fix');
const {isHuman,getConversation,saveConversation}=require('../lib/human-control');
const clean=v=>String(v??'').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,4000);
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
  }catch(e){console.error('[HUMAN ROUTER]',e.message)}
 }
 return original(req,res);
};
