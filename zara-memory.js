'use strict';

// Additive memory layer. It never owns the webhook response path.
// If Neon/schema/memory fails, Zara continues using the existing index.js flow.

const schemaReady = new Map();
const cache = new Map();
const CACHE_TTL_MS = 30_000;

function getSql(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  try {
    if (!global.__zaraMemorySql) {
      const { neon } = require('@neondatabase/serverless');
      global.__zaraMemorySql = neon(dbUrl);
    }
    return global.__zaraMemorySql;
  } catch (e) {
    console.error('[MEMORY INIT]', e.message);
    return null;
  }
}

async function ensureSchema(dbUrl) {
  const sql = getSql(dbUrl);
  if (!sql) return false;
  if (schemaReady.get(dbUrl)) return true;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS zara_customer_memory (
        phone_number TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        memory_value TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'profile',
        confidence REAL NOT NULL DEFAULT 1,
        source_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone_number, memory_key)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS zara_memory_events (
        id BIGSERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (phone_number, source_message_id, event_type)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_zara_memory_events_phone_time ON zara_memory_events(phone_number, occurred_at DESC)`;
    schemaReady.set(dbUrl, true);
    console.log('[MEMORY SCHEMA] ready');
    return true;
  } catch (e) {
    console.error('[MEMORY SCHEMA]', e.message);
    return false;
  }
}

function clean(value, max = 300) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cacheKey(phone) { return `m:${phone}`; }

async function getMemoryContext(dbUrl, phone, query) {
  if (!phone) return '';
  const key = cacheKey(phone);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.text;

  const sql = getSql(dbUrl);
  if (!sql || !(await ensureSchema(dbUrl))) return '';

  try {
    const profile = await sql`
      SELECT memory_key, memory_value, memory_type
      FROM zara_customer_memory
      WHERE phone_number = ${phone}
      ORDER BY updated_at DESC
      LIMIT 40
    `;
    const events = await sql`
      SELECT event_type, summary, occurred_at
      FROM zara_memory_events
      WHERE phone_number = ${phone}
      ORDER BY occurred_at DESC
      LIMIT 12
    `;

    const lines = [];
    for (const row of profile || []) lines.push(`- ${row.memory_key}: ${clean(row.memory_value)}`);
    for (const row of events || []) lines.push(`- ${row.event_type}: ${clean(row.summary)}`);

    const text = lines.length
      ? `\n=== VERIFIED CUSTOMER MEMORY ===\nUse these facts only when relevant. Never invent facts. If the customer gives a newer correction, the newer explicit fact wins.\n${lines.join('\n')}\n=== END CUSTOMER MEMORY ===\n`
      : '';

    cache.set(key, { text, expires: Date.now() + CACHE_TTL_MS });
    return text;
  } catch (e) {
    console.error('[MEMORY READ]', e.message);
    return '';
  }
}

function explicitFacts(text, contactName) {
  const t = clean(text, 1000);
  const facts = [];
  const add = (key, value, type = 'profile') => {
    const v = clean(value, 160);
    if (v) facts.push({ key, value: v, type });
  };

  if (contactName) add('customer_name', contactName, 'identity');

  const city = t.match(/\b(faisalabad|lahore|karachi|islamabad|rawalpindi|multan|gujranwala)\b/i);
  if (city) add('city', city[1][0].toUpperCase() + city[1].slice(1).toLowerCase(), 'contact');

  const color = t.match(/(?:color|colour|رنگ)\s*(?:ہے|is|:)?\s*([A-Za-z]+|[\u0600-\u06FF]+)/i);
  if (color) add('preferred_color', color[1], 'preference');

  const fabric = t.match(/\b(lawn|linen|khaddar|karandi|marina|velvet|dhanak|kotail|embroidered|printed)\b/i);
  if (fabric) add('preferred_fabric', fabric[1], 'preference');

  const address = t.match(/(?:address|pata|پتہ)\s*(?:ہے|is|:)?\s*(.{8,180})$/i);
  if (address) add('address', address[1], 'contact');

  return facts;
}

async function remember(dbUrl, phone, messageId, customerText, aiReply, contactName) {
  if (!phone || !messageId || !customerText || !aiReply) return;
  const sql = getSql(dbUrl);
  if (!sql || !(await ensureSchema(dbUrl))) return;

  try {
    const facts = explicitFacts(customerText, contactName);
    for (const fact of facts) {
      await sql`
        INSERT INTO zara_customer_memory
          (phone_number, memory_key, memory_value, memory_type, confidence, source_message_id)
        VALUES
          (${phone}, ${fact.key}, ${fact.value}, ${fact.type}, 1, ${messageId})
        ON CONFLICT (phone_number, memory_key) DO UPDATE SET
          memory_value = EXCLUDED.memory_value,
          memory_type = EXCLUDED.memory_type,
          confidence = EXCLUDED.confidence,
          source_message_id = EXCLUDED.source_message_id,
          updated_at = NOW()
      `;
    }

    await sql`
      INSERT INTO zara_memory_events
        (phone_number, event_type, summary, source_message_id)
      VALUES
        (${phone}, 'conversation', ${clean(customerText, 500)}, ${messageId})
      ON CONFLICT (phone_number, source_message_id, event_type) DO NOTHING
    `;

    cache.delete(cacheKey(phone));
    console.log('[MEMORY WRITE] persisted:', phone.slice(0, 4) + '***');
  } catch (e) {
    console.error('[MEMORY WRITE]', e.message);
  }
}

module.exports = { ensureSchema, getMemoryContext, remember };
