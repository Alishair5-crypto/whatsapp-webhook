'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { getMemoryContext, remember } = require('../zara-memory');
const { getCatalogueForMessage, allImages } = require('../catalogue/agent');
const originalFetch = globalThis.fetch;
const memoryContext = new AsyncLocalStorage();
const catalogueRotation = new Map();

// Conservative Urdu cleanup only. Product/catalogue facts remain authoritative.
const URDU_NORMALIZATION = [
  ['مارینا فیبرک', 'مارینا کا کپڑا'],
  ['مارینہ فیبرک', 'مارینا کا کپڑا'],
  ['مارینہ', 'مارینا'],
  ['فابریکس', 'کپڑے'],
  ['فابریک', 'کپڑا'],
  ['کلرز', 'رنگ'], ['کلر', 'رنگ'],
  ['پرنٹڈ', 'پرنٹ شدہ'],
  ['ایمبروئیڈری', 'کڑھائی'], ['ایمبروئیڈرڈ', 'کڑھائی والا'],
  ['ایویلیبل ہیں', 'دستیاب ہیں'], ['ایویلیبل', 'دستیاب'],
  ['ریٹیل پرائس', 'قیمت'], ['ریٹیل قیمت', 'قیمت'],
  ['ہول سیل ریٹ', 'ہول سیل قیمت'],
  ['پریمیم ٹچ والا', 'اعلیٰ معیار کا'],
  ['سلیکٹڈ', 'منتخب'], ['ڈاٹ پرنٹ', 'ڈاٹ والا پرنٹ'],
  ['براہ کرم', 'براہِ کرم'], ['مہربانی کر کے', 'مہربانی کرکے'],
  ['آپکو', 'آپ کو'], ['آپکے', 'آپ کے'], ['آپکی', 'آپ کی'],
  ['اسکے', 'اس کے'], ['اسکی', 'اس کی'], ['انکے', 'ان کے'], ['انکی', 'ان کی'],
  ['کہتےہیں', 'کہتے ہیں'], ['چاہتےہیں', 'چاہتے ہیں'],
];

const URDU_QUALITY_RULES = `

=== URDU QUALITY — PRODUCTION RULES ===
When replying in Urdu script, write natural Pakistani Urdu as a real Pakistani sales representative would speak.
- Never produce literal word-for-word English-to-Urdu translation.
- Prefer simple everyday Pakistani Urdu and natural sentence order.
- Do not unnecessarily mix English words into Urdu. Genuine catalogue/product names may remain unchanged.
- Preserve catalogue facts, names, colors, prices, stock, quantities, payment and delivery facts exactly.
- Fatima Arts products are UNSTITCHED. Never invent garment sizes or measurements unless the live catalogue explicitly provides them.
- Use natural sales wording: مارینا کا کپڑا، قیمت، رنگ، ڈیزائن، دستیاب، آرڈر، ڈلیوری.
- Do not mechanically translate catalogue labels; make the surrounding sentence natural.
- Proofread grammar, spacing, verb agreement and flow before answering.
- Keep replies concise: maximum 5–6 short lines and 2–3 emojis.
- Output only the customer-facing reply plus the existing [ORDER:...] tag when required.
`;

function normalizeUrdu(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.normalize('NFC');
  for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to);
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}
function normalizeUrduText(text) { return typeof text === 'string' ? normalizeUrdu(text) : text; }
function isElevenLabsTTS(url) { return url && url.includes('api.elevenlabs.io/v1/text-to-speech/'); }
function isWhatsAppSend(url) { return url && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url); }
function isChatCompletion(url) { return url && /\/chat\/completions(?:\?|$)/.test(url); }
function isGoogleSheetsAppend(url) { return url && /sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/Sheet1!A:J:append(?:\?|$)/.test(url); }
function escapeXml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;'); }

function strengthenUrduPrompt(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.contents)) {
    const part = payload.system_instruction?.parts?.[0];
    if (part && typeof part.text === 'string' && !part.text.includes('=== URDU QUALITY — PRODUCTION RULES ===')) part.text += URDU_QUALITY_RULES;
  }
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find(m => m?.role === 'system');
    if (system && typeof system.content === 'string' && !system.content.includes('=== URDU QUALITY — PRODUCTION RULES ===')) system.content += URDU_QUALITY_RULES;
  }
}

// Gemini Part is a typed union. Stored dashboard/audio metadata such as {audio: ...}
// is not a valid Gemini Part. Voice notes are already transcribed in index.js, so
// strip unsupported metadata and retain only usable text/media fields.
function sanitizeGeminiPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.contents)) return payload;
  const cleanPart = part => {
    if (!part || typeof part !== 'object') return null;
    if (typeof part.text === 'string') return { text: part.text };
    if (part.inlineData && typeof part.inlineData === 'object') return { inlineData: part.inlineData };
    if (part.fileData && typeof part.fileData === 'object') return { fileData: part.fileData };
    if (part.functionCall && typeof part.functionCall === 'object') return { functionCall: part.functionCall };
    if (part.functionResponse && typeof part.functionResponse === 'object') return { functionResponse: part.functionResponse };
    if (part.executableCode && typeof part.executableCode === 'object') return { executableCode: part.executableCode };
    if (part.codeExecutionResult && typeof part.codeExecutionResult === 'object') return { codeExecutionResult: part.codeExecutionResult };
    if (part.toolCall && typeof part.toolCall === 'object') return { toolCall: part.toolCall };
    if (part.toolResponse && typeof part.toolResponse === 'object') return { toolResponse: part.toolResponse };
    return null;
  };
  payload.contents = payload.contents.map(content => {
    if (!content || typeof content !== 'object') return content;
    const parts = Array.isArray(content.parts) ? content.parts.map(cleanPart).filter(Boolean) : [];
    return { ...content, parts };
  }).filter(content => !Array.isArray(content.parts) || content.parts.length > 0);
  return payload;
}

async function synthesizeWithAzure(text) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region || !text) { console.warn('[AZURE TTS] Missing configuration or text; skipping fallback'); return null; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const cleanText = normalizeUrdu(text);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ur-PK"><voice name="ur-PK-UzmaNeural"><prosody rate="0.93">${escapeXml(cleanText)}</prosody></voice></speak>`;
    console.log('[AZURE TTS] ur-PK-UzmaNeural | SSML/prosody enabled');
    const response = await originalFetch(endpoint, { method:'POST', headers:{'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-24khz-160kbitrate-mono-mp3','User-Agent':'Zara-AI-Sales-Agent'}, body:ssml, signal:controller.signal });
    if (!response.ok) { let detail=''; try { detail=(await response.clone().text()).slice(0,1000); } catch(_) {} console.error('[AZURE TTS FAIL]',JSON.stringify({status:response.status,contentType:response.headers.get('content-type')||null,body:detail})); return null; }
    console.log('[AZURE TTS SUCCESS] Fallback voice generated');
    return response;
  } catch(error) { if(error?.name==='AbortError') console.error('[AZURE TTS FAIL] Request timed out after 12000ms'); else console.error('[AZURE TTS FAIL]',error.message); return null; }
  finally { clearTimeout(timeout); }
}

async function fetchGoogleSheetsWithRetry(input, init={}, ctx=null) {
  const maxAttempts=3;
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    const response=await originalFetch(input,init);
    if(response.ok){if(ctx)ctx.orderSheetWriteSucceeded=true;return response;}
    const retryable=[408,429,500,502,503,504].includes(response.status);
    if(!retryable||attempt===maxAttempts){let detail='';try{detail=(await response.clone().text()).slice(0,1000)}catch(_){}throw new Error(`[SHEET APPEND] HTTP ${response.status}${detail?`: ${detail}`:''}`)}
    const retryAfter=Number(response.headers.get('retry-after'));
    const delayMs=Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,10000):attempt*1500;
    console.warn(`[SHEET APPEND] Retry ${attempt+1}/${maxAttempts} after HTTP ${response.status}`);
    await new Promise(resolve=>setTimeout(resolve,delayMs));
  }
  throw new Error('[SHEET APPEND] Exhausted retries');
}
function normalizeRecoveredOrder(order,phone){
  if(!order||!phone)return null;
  const out={name:String(order.name||'').trim(),product:String(order.product||'').trim(),qty:String(order.qty||'').trim(),price:String(order.price||'').replace(/[^\d.]/g,'').trim(),payment:String(order.payment||'').trim(),address:normalizeUrduText(String(order.address||'').trim()),city:normalizeUrduText(String(order.city||'').trim())};
  if(!out.name||!out.product||!out.qty||!out.price||!out.payment||!out.address||!out.city)return null;
  if(!/^\d+(?:\.\d+)?$/.test(out.qty)||Number(out.qty)<1||Number(out.qty)>100)return null;
  if(!/^\d+(?:\.\d+)?$/.test(out.price)||Number(out.price)<=0||Number(out.price)>1000000)return null;
  if(!/^(?:cod|cash on delivery|jazzcash|easypaisa)$/i.test(out.payment))return null;
  if(out.address.length<8||out.address.length>500||out.city.length<2||out.city.length>80)return null;
  return out;
}
async function getServiceAccountToken(email,key){
  if(!email||!key)return null;
  try{
    const now=Math.floor(Date.now()/1000);const b64=value=>Buffer.from(value).toString('base64url');
    const header=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const payload=b64(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
    const signer=crypto.createSign('RSA-SHA256');signer.update(`${header}.${payload}`);
    const signature=signer.sign(key.replace(/\\n/g,'\n'),'base64url');
    const response=await originalFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${payload}.${signature}`});
    const data=await response.json().catch(()=>null);return data?.access_token||null;
  }catch(error){console.error('[ORDER RECOVERY TOKEN]',error.message);return null;}
}
async function recoverConfirmedOrder(ctx){
  if(!ctx?.phone||!ctx.userText||!process.env.GEMINI_API_KEY||ctx.orderSheetWriteSucceeded)return null;
  if(!process.env.GOOGLE_SHEETS_ID||!process.env.GOOGLE_SA_EMAIL||!process.env.GOOGLE_SA_KEY)return null;
  if(/\[ORDER:/i.test(ctx.aiReply||''))return null;
  try{
    const memory=await getMemoryContext(process.env.DATABASE_URL||'',ctx.phone,ctx.userText);
    const prompt=`Extract an order ONLY if the customer has explicitly confirmed every required field. Required: name, product, qty, price, payment (COD/JazzCash/EasyPaisa), full delivery address, city. Never infer missing fields. Return ONLY JSON or null with keys name, product, qty, price, payment, address, city. Customer message: ${ctx.userText}\nZara reply: ${ctx.aiReply}\nRelevant saved conversation context: ${String(memory||'').slice(-7000)}`;
    const response=await originalFetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_instruction:{parts:[{text:'You are a strict order validator. Never guess. Return JSON only.'}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens:300,responseMimeType:'application/json'}})});
    if(!response.ok)return null;
    const data=await response.json();const raw=data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if(!raw||raw==='null')return null;
    const order=normalizeRecoveredOrder(JSON.parse(raw),ctx.phone);if(!order)return null;
    const token=await getServiceAccountToken(process.env.GOOGLE_SA_EMAIL.trim(),process.env.GOOGLE_SA_KEY.trim());if(!token)return null;
    const row=[new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),order.name,ctx.phone,order.product,order.qty,order.price,order.payment,order.address,order.city,'Pending'];
    const sheetUrl=`https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEETS_ID.trim()}/values/Sheet1!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendResponse=await fetchGoogleSheetsWithRetry(sheetUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})},ctx);
    const result=await appendResponse.json().catch(()=>null);
    if(Number(result?.updates?.updatedRows||0)<1){console.error('[ORDER RECOVERY] Sheets returned no updated row');return null;}
    ctx.orderSheetWriteSucceeded=true;console.log('[ORDER RECOVERY] Confirmed order saved to Google Sheets:',order.name,order.product,order.qty);return order;
  }catch(error){console.error('[ORDER RECOVERY] Failed:',error.message);return null;}
}
async function injectMemoryIntoAI(url,init,ctx){
  if(!ctx||!init||typeof init.body!=='string')return init;
  let payload;try{payload=JSON.parse(init.body)}catch(_){return init}
  if(!ctx.phone)return init;
  let query=ctx.userText||'';
  try{const last=payload?.contents?.[payload.contents.length-1]?.parts?.[0]?.text;if(typeof last==='string')query=last}catch(_){}
  if(!query){try{const last=payload?.messages?.[payload.messages.length-1]?.content;if(typeof last==='string')query=last}catch(_){}
  }
  if(query)ctx.userText=query.replace(/^Customer name:\s*[^\n]+\n/i,'').trim();
  const memory=await getMemoryContext(process.env.DATABASE_URL||'',ctx.phone,ctx.userText);
  if(!ctx.catalogueChecked&&ctx.userText){
    ctx.catalogueChecked=true;
    ctx.catalogue=await getCatalogueForMessage(process.env.DATABASE_URL||'',ctx.userText,memory);
  }
  const intentContext=ctx.catalogue?.intent
    ? `\\n=== ZARA INTENT ANALYSIS ===\\nIntent: ${ctx.catalogue.intent} | Confidence: ${ctx.catalogue.intentConfidence ?? ''} | Reference: ${ctx.catalogue.reference || 'NONE'}\\nTreat this as the customer's primary intent. Fulfil that intent first. Do not send catalogue images unless intent.wantsImages is true.\\n`
    : '';
  const catalogueContext=intentContext+(ctx.catalogue?.context||'');
  strengthenUrduPrompt(payload);
  if(Array.isArray(payload.contents)){
    const system=payload.system_instruction?.parts?.[0]?.text;
    if(typeof system==='string')payload.system_instruction.parts[0].text=system+(memory||'')+catalogueContext;
  }
  if(Array.isArray(payload.messages)){
    const systemIndex=payload.messages.findIndex(m=>m?.role==='system');
    if(systemIndex>=0&&typeof payload.messages[systemIndex].content==='string')payload.messages[systemIndex].content+=(memory||'')+catalogueContext;
  }
  sanitizeGeminiPayload(payload);
  if(Array.isArray(payload.contents))console.log('[GEMINI SANITIZE] contents sanitized; unsupported audio metadata removed');
  return {...init,body:JSON.stringify(payload)};
}
async function maybeRemember(ctx){if(!ctx||ctx.remembered||!ctx.phone||!ctx.msgId||!ctx.userText||!ctx.aiReply)return;ctx.remembered=true;await remember(process.env.DATABASE_URL||'',ctx.phone,ctx.msgId,ctx.userText,ctx.aiReply,ctx.customerName)}
function rotateProducts(products,phone){if(!Array.isArray(products)||products.length<2||!phone)return products||[];const previous=catalogueRotation.get(phone)||0;const offset=previous%products.length;catalogueRotation.set(phone,(offset+1)%products.length);return products.slice(offset).concat(products.slice(0,offset))}
async function sendCatalogueImages(ctx,headers){
  if(!ctx?.catalogue?.wantsImages||!ctx.catalogue.products?.length||ctx.catalogueImagesSent)return;
  if(!ctx.phone||!process.env.WHATSAPP_TOKEN||!process.env.PHONE_NUMBER_ID)return;
  const products=rotateProducts(ctx.catalogue.products,ctx.phone);const selected=[];const urls=new Set();
  for(const product of products){const productUrls=allImages(product);for(const url of productUrls){if(!url||urls.has(url)||!/^https:\/\//i.test(url))continue;urls.add(url);selected.push({product,url})}}
  if(!selected.length)return;ctx.catalogueImagesSent=true;console.log('[CATALOGUE] Sending relevant image set:',selected.length,'images');
  for(const item of selected){try{const price=Number(item.product?.price);const priceText=Number.isFinite(price)?`${item.product?.currency||'PKR'} ${price.toLocaleString('en-PK')}`:'';const caption=`${item.product?.name||'Product'}${priceText?` — ${priceText}`:''}`.slice(0,1024);const response=await originalFetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,{method:'POST',headers,body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:ctx.phone,type:'image',image:{link:item.url,caption}})});if(response.ok)console.log('[CATALOGUE IMAGE] Sent:',item.product?.name||item.url);else console.error('[CATALOGUE IMAGE] Send failed:',(await response.text()).slice(0,300))}catch(error){console.error('[CATALOGUE IMAGE] Error:',error.message)}}
}
if(originalFetch&&!globalThis.__zaraVoiceFetchPatched){
  globalThis.__zaraVoiceFetchPatched=true;
  globalThis.fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:input?.url;
    const headers=new Headers(init.headers||(typeof input!=='string'?input.headers:undefined));
    const ctx=memoryContext.getStore();
    if(ctx&&(isChatCompletion(url)||(url&&url.includes('generativelanguage.googleapis.com'))))init=await injectMemoryIntoAI(url,init,ctx);
    if(isGoogleSheetsAppend(url)){if(ctx)ctx.orderSheetWriteAttempted=true;try{return await fetchGoogleSheetsWithRetry(input,{...init,headers},ctx)}catch(error){if(ctx)ctx.orderSheetWriteSucceeded=false;throw error}}
    if(isElevenLabsTTS(url)){
      headers.set('Accept','audio/mpeg');let body=init.body;let elevenLabsText='';
      if(typeof body==='string'){try{const payload=JSON.parse(body);payload.model_id='eleven_v3';payload.language_code='ur';if(typeof payload.text==='string'){payload.text=normalizeUrdu(payload.text);elevenLabsText=payload.text;if(ctx)ctx.aiReply=payload.text;console.log('[ZARA URDU FINAL]',JSON.stringify({text:payload.text}))}body=JSON.stringify(payload)}catch(_){}}
      const response=await originalFetch(input,{...init,headers,body});
      if(response.ok)return response;
      try{const errorBody=await response.clone().text();const requestId=response.headers.get('request-id')||response.headers.get('x-request-id')||null;console.error('[ELEVENLABS HTTP ERROR]',JSON.stringify({status:response.status,contentType:response.headers.get('content-type')||null,requestId,body:errorBody.slice(0,2000)}))}catch(e){console.error('[ELEVENLABS HTTP ERROR] Failed to read error body:',e.message)}
      if(elevenLabsText){console.warn('[AZURE TTS] ElevenLabs failed; attempting Azure fallback');const azureResponse=await synthesizeWithAzure(elevenLabsText);if(azureResponse?.ok)return azureResponse}else console.warn('[AZURE TTS] ElevenLabs failed but source text was unavailable; skipping Azure fallback');
      return response;
    }
    if(isWhatsAppSend(url)&&typeof init.body==='string'){
      try{const payload=JSON.parse(init.body);
        if(payload?.type==='text'&&typeof payload?.text?.body==='string'){
          payload.text.body=normalizeUrdu(payload.text.body);if(ctx)ctx.aiReply=payload.text.body;console.log('[ZARA URDU FINAL]',JSON.stringify({text:payload.text.body}));
          await recoverConfirmedOrder(ctx);const response=await originalFetch(input,{...init,headers,body:JSON.stringify(payload)});if(response.ok){await maybeRemember(ctx);await sendCatalogueImages(ctx,headers)}return response;
        }
        if(payload?.type==='audio'&&ctx?.aiReply){await recoverConfirmedOrder(ctx);const response=await originalFetch(input,{...init,headers});if(response.ok){await maybeRemember(ctx);await sendCatalogueImages(ctx,headers)}return response}
      }catch(_){}
    }
    return originalFetch(input,init);
  };
}
const originalHandler=require('../index.js');
module.exports=async(req,res)=>{
  const body=req?.body&&typeof req.body==='object'?req.body:{};
  const message=body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const contact=body?.entry?.[0]?.changes?.[0]?.value?.contacts?.find(c=>c?.wa_id===message?.from)||body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
  const ctx={phone:message?.from||'',msgId:message?.id||'',customerName:(contact?.profile?.name||'').trim(),userText:typeof message?.text?.body==='string'?message.text.body:'',aiReply:'',remembered:false,catalogueChecked:false,catalogue:null,catalogueImagesSent:false,orderSheetWriteAttempted:false,orderSheetWriteSucceeded:false};
  return memoryContext.run(ctx,()=>originalHandler(req,res));
};
