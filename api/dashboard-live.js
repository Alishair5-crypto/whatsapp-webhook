'use strict';
const {neon}=require('@neondatabase/serverless');
const {listOrders}=require('../lib/order-store');
function clean(v,max=300){return String(v??'').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max)}
module.exports=async(req,res)=>{
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method Not Allowed'});
 const dbUrl=String(process.env.DATABASE_URL||'').trim();if(!dbUrl||!dbUrl.startsWith('postgres'))return res.status(200).json({ok:true,available:false,leads:[],conversations:[],products:[],orders:[]});
 const scope=new URL(req.url,'http://localhost').searchParams.get('scope')||'summary';
 try{
  const sql=neon(dbUrl);
  const [events,profiles,orderData]=await Promise.all([
   sql`SELECT phone_number,event_type,summary,occurred_at FROM zara_memory_events ORDER BY occurred_at DESC LIMIT 150`,
   sql`SELECT phone_number,memory_key,memory_value,updated_at FROM zara_customer_memory ORDER BY updated_at DESC LIMIT 400`,
   listOrders(200)
  ]);
  const profileMap=new Map();for(const p of profiles||[]){if(!profileMap.has(p.phone_number))profileMap.set(p.phone_number,{});profileMap.get(p.phone_number)[p.memory_key]=clean(p.memory_value,180)}
  const grouped=new Map();for(const e of events||[]){if(!grouped.has(e.phone_number))grouped.set(e.phone_number,[]);const a=grouped.get(e.phone_number);if(a.length<20)a.push({type:clean(e.event_type,40),summary:clean(e.summary,500),at:e.occurred_at})}
  const leads=[...grouped.entries()].map(([phone,history])=>{const p=profileMap.get(phone)||{};return{phone,name:p.customer_name||phone,city:p.city||'',fabric:p.preferred_fabric||'',color:p.preferred_color||'',lastAt:history[0]?.at||null,messages:history.length,history}}).sort((a,b)=>new Date(b.lastAt||0)-new Date(a.lastAt||0));
  const conversations=leads.slice(0,50).map(x=>({phone:x.phone,name:x.name,lastAt:x.lastAt,messages:x.messages,preview:x.history[0]?.summary||'',history:x.history}));
  let products=[];
  if(scope==='products'){
   const rows=await sql`SELECT p.id,p.name,p.collection,p.fabric,p.color,p.price,p.currency,p.description,i.stock_quantity,pi.image_url,pi.alt_text,pi.is_primary FROM catalog_products p LEFT JOIN catalog_inventory i ON i.product_id=p.id LEFT JOIN LATERAL (SELECT ci.image_url,ci.alt_text,ci.is_primary FROM catalog_images ci WHERE ci.product_id=p.id ORDER BY ci.is_primary DESC,ci.sort_order ASC,ci.id ASC LIMIT 1) pi ON true WHERE p.status='active' ORDER BY p.updated_at DESC,p.id DESC LIMIT 80`;
   products=(rows||[]).map(p=>({id:String(p.id),name:clean(p.name),collection:clean(p.collection),fabric:clean(p.fabric),color:clean(p.color),price:Number(p.price)||0,currency:clean(p.currency||'PKR',10),description:clean(p.description,220),stock:Number.isFinite(Number(p.stock_quantity))?Number(p.stock_quantity):null,images:p.image_url?[{url:String(p.image_url),altText:clean(p.alt_text,120),isPrimary:Boolean(p.is_primary)}]:[]}));
  }
  return res.status(200).json({ok:true,available:true,leads,conversations,products,orders:orderData.available?orderData.orders:[]});
 }catch(e){console.error('[DASHBOARD LIVE]',e?.message||e);return res.status(200).json({ok:true,available:false,leads:[],conversations:[],products:[],orders:[],error:'Live dashboard data unavailable'});}
};
