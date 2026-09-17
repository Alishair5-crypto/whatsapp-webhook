'use strict';

const { neon } = require('@neondatabase/serverless');

let sqlClient = null;
function getSql() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url || !url.startsWith('postgres')) return null;
  if (!sqlClient) sqlClient = neon(url);
  return sqlClient;
}

let readyPromise = null;
async function ensureTable() {
  if (readyPromise) return readyPromise;
  const sql = getSql();
  if (!sql) return false;
  readyPromise = sql`
    CREATE TABLE IF NOT EXISTS zara_followups (
      phone_number TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      last_customer_at TIMESTAMPTZ,
      last_customer_text TEXT NOT NULL DEFAULT '',
      last_zara_at TIMESTAMPTZ,
      first_due_at TIMESTAMPTZ,
      second_due_at TIMESTAMPTZ,
      followup_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.then(() => true).catch(error => {
    console.error('[FOLLOWUP DB] Table init failed:', error.message);
    readyPromise = null;
    return false;
  });
  return readyPromise;
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function isClosingMessage(text) {
  return /^(?:ok|okay|thanks|thank you|thx|done|got it|received|no thanks|not interested|stop|unsubscribe|shukriya|شکریہ|ٹھیک ہے|بس|نہیں شکریہ)[.!\s]*$/i.test(clean(text, 300));
}

async function recordCustomerMessage(phone, customerName = '', text = '') {
  const sql = getSql();
  if (!sql || !phone) return;
  if (!(await ensureTable())) return;
  try {
    await sql`
      INSERT INTO zara_followups
        (phone_number, customer_name, last_customer_at, last_customer_text, followup_count, active, updated_at)
      VALUES
        (${clean(phone, 100)}, ${clean(customerName, 200)}, NOW(), ${clean(text)}, 0, FALSE, NOW())
      ON CONFLICT (phone_number) DO UPDATE SET
        customer_name = CASE WHEN ${clean(customerName, 200)} <> '' THEN ${clean(customerName, 200)} ELSE zara_followups.customer_name END,
        last_customer_at = NOW(),
        last_customer_text = ${clean(text)},
        first_due_at = NULL,
        second_due_at = NULL,
        followup_count = 0,
        active = FALSE,
        updated_at = NOW()
    `;
    console.log('[FOLLOWUP] Customer activity recorded; pending follow-up cancelled:', phone);
  } catch (error) {
    console.error('[FOLLOWUP DB] Customer activity failed:', error.message);
  }
}

async function recordZaraReply(phone, customerName = '', reply = '') {
  const sql = getSql();
  if (!sql || !phone) return;
  if (!(await ensureTable())) return;
  if (isClosingMessage(reply)) {
    console.log('[FOLLOWUP] Closing reply detected; no follow-up scheduled:', phone);
    return;
  }
  try {
    await sql`
      INSERT INTO zara_followups
        (phone_number, customer_name, last_zara_at, first_due_at, second_due_at, followup_count, active, updated_at)
      VALUES
        (${clean(phone, 100)}, ${clean(customerName, 200)}, NOW(), NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 0, TRUE, NOW())
      ON CONFLICT (phone_number) DO UPDATE SET
        customer_name = CASE WHEN ${clean(customerName, 200)} <> '' THEN ${clean(customerName, 200)} ELSE zara_followups.customer_name END,
        last_zara_at = NOW(),
        first_due_at = NOW() + INTERVAL '1 hour',
        second_due_at = NOW() + INTERVAL '3 hours',
        followup_count = 0,
        active = TRUE,
        updated_at = NOW()
    `;
    console.log('[FOLLOWUP] Zara reply recorded: first=1h, second=3h:', phone);
  } catch (error) {
    console.error('[FOLLOWUP DB] Zara reply failed:', error.message);
  }
}

async function getDueFollowups() {
  const sql = getSql();
  if (!sql || !(await ensureTable())) return [];
  try {
    const rows = await sql`
      SELECT phone_number, customer_name, last_customer_at, last_customer_text,
             last_zara_at, followup_count
      FROM zara_followups
      WHERE active = TRUE
        AND last_customer_at IS NOT NULL
        AND last_zara_at IS NOT NULL
        AND last_customer_at < last_zara_at
        AND last_customer_at > NOW() - INTERVAL '24 hours'
        AND (
          (followup_count = 0 AND first_due_at <= NOW())
          OR
          (followup_count = 1 AND second_due_at <= NOW())
        )
      ORDER BY COALESCE(first_due_at, second_due_at) ASC
      LIMIT 100
    `;
    return rows || [];
  } catch (error) {
    console.error('[FOLLOWUP DB] Due query failed:', error.message);
    return [];
  }
}

async function markFollowupSent(phone, count) {
  const sql = getSql();
  if (!sql || !phone) return;
  try {
    if (Number(count) === 0) {
      await sql`
        UPDATE zara_followups
        SET followup_count = 1,
            second_due_at = NOW() + INTERVAL '2 hours',
            updated_at = NOW()
        WHERE phone_number = ${clean(phone, 100)}
          AND active = TRUE
          AND followup_count = 0
      `;
    } else {
      await sql`
        UPDATE zara_followups
        SET followup_count = 2,
            active = FALSE,
            first_due_at = NULL,
            second_due_at = NULL,
            updated_at = NOW()
        WHERE phone_number = ${clean(phone, 100)}
          AND active = TRUE
          AND followup_count = 1
      `;
    }
  } catch (error) {
    console.error('[FOLLOWUP DB] Mark sent failed:', error.message);
  }
}

async function cancelFollowup(phone) {
  const sql = getSql();
  if (!sql || !phone || !(await ensureTable())) return;
  try {
    await sql`
      UPDATE zara_followups
      SET active = FALSE, first_due_at = NULL, second_due_at = NULL, updated_at = NOW()
      WHERE phone_number = ${clean(phone, 100)}
    `;
  } catch (error) {
    console.error('[FOLLOWUP DB] Cancel failed:', error.message);
  }
}

module.exports = {
  recordCustomerMessage,
  recordZaraReply,
  getDueFollowups,
  markFollowupSent,
  cancelFollowup
};
