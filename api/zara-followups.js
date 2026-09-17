'use strict';

const { getDueFollowups, markFollowupSent, cancelFollowup } = require('../lib/followup-store');
const { isHuman } = require('../lib/human-control');

function clean(value, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function followupText(row) {
  return 'جی، اگر آپ کو ابھی بھی اس بارے میں مدد چاہیے تو میں حاضر ہوں 😊';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const secret = String(process.env.CRON_SECRET || '').trim();
  if (secret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${secret}`) return res.status(401).send('Unauthorized');
  }

  const token = String(process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = String(process.env.PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneNumberId) return res.status(500).json({ ok: false, error: 'WhatsApp configuration missing' });

  const rows = await getDueFollowups();
  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const phone = clean(row.phone_number, 100);
    try {
      if (!phone || await isHuman(phone)) {
        await cancelFollowup(phone);
        skipped++;
        continue;
      }

      // Both follow-ups are intentionally limited to the active 24-hour
      // customer-service window. No template message is attempted here.
      if (!row.last_customer_at || Date.now() - new Date(row.last_customer_at).getTime() >= 24 * 60 * 60 * 1000) {
        await cancelFollowup(phone);
        console.log('[FOLLOWUP] 24h window closed; skipped:', phone);
        skipped++;
        continue;
      }

      const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: followupText(row) }
        })
      });

      if (response.ok) {
        await markFollowupSent(phone, Number(row.followup_count || 0));
        sent++;
        console.log(`[FOLLOWUP] Sent #${Number(row.followup_count || 0) + 1}:`, phone);
      } else {
        const detail = await response.text().catch(() => '');
        console.error('[FOLLOWUP] WhatsApp send failed:', response.status, detail.slice(0, 300));
      }
    } catch (error) {
      console.error('[FOLLOWUP] Customer failed:', phone, error.message);
    }
  }

  return res.status(200).json({ ok: true, checked: rows.length, sent, skipped });
};
