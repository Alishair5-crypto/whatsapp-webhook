'use strict';

// Zara Catalogue image storage is intentionally isolated from the active Zara webhook.
// It stores image binaries in Vercel Blob and only metadata/URLs in Neon.

const crypto = require('node:crypto');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
let sqlClient = null;
let blobClient = null;

function getSql(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  try { if (!sqlClient) { const { neon } = require('@neondatabase/serverless'); sqlClient = neon(dbUrl); } return sqlClient; }
  catch (e) { console.error('[CATALOGUE DB INIT]', e.message); return null; }
}
function getBlob() {
  try { if (!blobClient) { const { put, del } = require('@vercel/blob'); blobClient = { put, del }; } return blobClient; }
  catch (e) { console.error('[CATALOGUE BLOB INIT]', e.message); return null; }
}
function positiveInt(value) { const n=Number(value); if(!Number.isInteger(n)||n<1)return null; return n; }
function cleanText(value,max=240){if(typeof value!=='string')return '';return value.replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max)}
function detectImageType(buffer){
  if(!Buffer.isBuffer(buffer))return '';
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return'image/jpeg';
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return'image/png';
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return'image/webp';
  return '';
}
function validateImageInput({productId,buffer,contentType,altText='',sortOrder=0}){
  const normalizedProductId=positiveInt(productId);if(!normalizedProductId)throw new Error('Invalid product id');
  if(!Buffer.isBuffer(buffer))throw new Error('Image body is required');if(buffer.length<1)throw new Error('Image body is empty');if(buffer.length>MAX_IMAGE_BYTES)throw new Error('Image exceeds 4 MB limit');
  const normalizedType=String(contentType||'').split(';',1)[0].trim().toLowerCase();if(!ALLOWED_TYPES[normalizedType])throw new Error('Unsupported image type');if(detectImageType(buffer)!==normalizedType)throw new Error('Image content does not match type');
  const normalizedSortOrder=Number(sortOrder);if(!Number.isInteger(normalizedSortOrder)||normalizedSortOrder<0||normalizedSortOrder>10000)throw new Error('Invalid image sort order');
  return{productId:normalizedProductId,buffer,contentType:normalizedType,extension:ALLOWED_TYPES[normalizedType],altText:cleanText(altText),sortOrder:normalizedSortOrder};
}
function makeBlobPath(productId,extension){return`catalogue/products/${productId}/${crypto.randomUUID()}.${extension}`}
async function uploadProductImage({dbUrl,productId,buffer,contentType,altText,sortOrder=0,isPrimary=false}){
  const input=validateImageInput({productId,buffer,contentType,altText,sortOrder});const sql=getSql(dbUrl);const blob=getBlob();
  if(!sql)throw new Error('Catalogue database is not configured');if(!blob)throw new Error('Vercel Blob is not configured');
  const product=await sql`SELECT id FROM catalog_products WHERE id=${input.productId} LIMIT 1`;if(!product.length)throw new Error('Product not found');
  const pathname=makeBlobPath(input.productId,input.extension);let uploaded=null;
  try{
    uploaded=await blob.put(pathname,input.buffer,{access:'public',contentType:input.contentType,addRandomSuffix:false});
    const primary=Boolean(isPrimary);
    const [,insertedRows]=await sql.transaction([
      sql`UPDATE catalog_images SET is_primary=FALSE WHERE product_id=${input.productId} AND ${primary}=TRUE`,
      sql`INSERT INTO catalog_images(product_id,image_url,alt_text,sort_order,is_primary) VALUES(${input.productId},${uploaded.url},${input.altText||null},${input.sortOrder},${primary}) RETURNING id,product_id,image_url,alt_text,sort_order,is_primary,created_at`
    ]);
    const [row]=insertedRows;if(!row)throw new Error('Image metadata insert failed');return row;
  }catch(error){if(uploaded?.url){try{await blob.del(uploaded.url)}catch(cleanupError){console.error('[CATALOGUE BLOB CLEANUP]',cleanupError.message)}}throw error}
}
async function listProductImages(dbUrl,productId){const id=positiveInt(productId);if(!id)throw new Error('Invalid product id');const sql=getSql(dbUrl);if(!sql)throw new Error('Catalogue database is not configured');return sql`SELECT id,product_id,image_url,alt_text,sort_order,is_primary,created_at FROM catalog_images WHERE product_id=${id} ORDER BY is_primary DESC,sort_order ASC,id ASC`}
async function setPrimaryProductImage(dbUrl,productId,imageId){
  const product=positiveInt(productId),image=positiveInt(imageId);if(!product||!image)throw new Error('Invalid product or image id');const sql=getSql(dbUrl);if(!sql)throw new Error('Catalogue database is not configured');
  const rows=await sql`
    WITH target AS (SELECT id FROM catalog_images WHERE id=${image} AND product_id=${product})
    UPDATE catalog_images AS ci SET is_primary=(ci.id=target.id) FROM target WHERE ci.product_id=${product}
    RETURNING ci.id,ci.product_id,ci.image_url,ci.alt_text,ci.sort_order,ci.is_primary,ci.created_at
  `;
  if(!rows.length)throw new Error('Image not found');return rows.find(row=>row.id===image)||rows[0];
}
async function deleteProductImage(dbUrl,productId,imageId){
  const product=positiveInt(productId),image=positiveInt(imageId);if(!product||!image)throw new Error('Invalid product or image id');const sql=getSql(dbUrl),blob=getBlob();if(!sql)throw new Error('Catalogue database is not configured');if(!blob)throw new Error('Vercel Blob is not configured');
  const rows=await sql`SELECT id,image_url FROM catalog_images WHERE id=${image} AND product_id=${product} LIMIT 1`;if(!rows.length)throw new Error('Image not found');
  await sql`DELETE FROM catalog_images WHERE id=${image} AND product_id=${product}`;
  try{await blob.del(rows[0].image_url)}catch(error){console.error('[CATALOGUE BLOB ORPHAN]',JSON.stringify({imageId:image,productId:product,url:rows[0].image_url,error:error.message}))}
  return{id:image,productId:product};
}
module.exports={MAX_IMAGE_BYTES,ALLOWED_TYPES,cleanText,detectImageType,validateImageInput,makeBlobPath,uploadProductImage,listProductImages,setPrimaryProductImage,deleteProductImage};
