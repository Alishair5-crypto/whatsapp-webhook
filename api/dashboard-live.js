'use strict';

const { neon } = require('@neondatabase/serverless');

function clean(v, max = 300) {
  return String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    return res.status(200).json({ ok: true, available: false, leads: [], conversations: [], products: [] });
  }
  try {
    const sql = neon(dbUrl);
    const [events, profiles, products] = await Promise.all([
      sql`SELECT phone_number, event_type, summary, occurred_at FROM zara_memory_events ORDER BY occurred_at DESC LIMIT 100`,
      sql`SELECT phone_number, memory_key, memory_value, updated_at FROM zara_customer_memory ORDER BY updated_at DESC LIMIT 300`,
      sql`SELECT p.id, p.name, p.collection, p.fabric, p.color, p.price, p.currency, p.description,
          i.stock_quantity,
          COALESCE(json_agg(json_build_object('url', ci.image_url, 'altText', ci.alt_text, 'isPrimary', ci.is_primary)
          ORDER BY ci.is_primary DESC, ci.sort_order ASC, ci.id ASC) FILTER (WHERE ci.id IS NOT NULL), '[]'::json) AS images
          FROM catalog_products p
          LEFT JOIN catalog_inventory i ON i.product_id=p.id
          LEFT JOIN catalog_images ci ON ci.product_id=p.id
          WHERE p.status='active'
          GROUP BY p.id, i.stock_quantity, i.product_id
          ORDER BY p.updated_at DESC, p.id DESC LIMIT 100`
    ]);

    const profileMap = new Map();
    for (const p of profiles || []) {
      if (!profileMap.has(p.phone_number)) profileMap.set(p.phone_number, {});
      profileMap.get(p.phone_number)[p.memory_key] = clean(p.memory_value, 180);
    }

    const grouped = new Map();
    for (const e of events || []) {
      if (!grouped.has(e.phone_number)) grouped.set(e.phone_number, []);
      const arr = grouped.get(e.phone_number);
      if (arr.length < 8) arr.push({ type: clean(e.event_type, 40), summary: clean(e.summary, 500), at: e.occurred_at });
    }

    const leads = [...grouped.entries()].map(([phone, history]) => {
      const profile = profileMap.get(phone) || {};
      return {
        phone,
        name: profile.customer_name || phone,
        city: profile.city || '',
        fabric: profile.preferred_fabric || '',
        color: profile.preferred_color || '',
        lastAt: history[0]?.at || null,
        messages: history.length,
        history
      };
    }).sort((a,b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

    const conversations = leads.slice(0, 50).map(x => ({
      phone: x.phone, name: x.name, lastAt: x.lastAt, messages: x.messages,
      preview: x.history[0]?.summary || ''
    }));

    const safeProducts = (products || []).map(p => ({
      id: String(p.id), name: clean(p.name), collection: clean(p.collection), fabric: clean(p.fabric),
      color: clean(p.color), price: Number(p.price) || 0, currency: clean(p.currency || 'PKR', 10),
      description: clean(p.description, 220), stock: Number.isFinite(Number(p.stock_quantity)) ? Number(p.stock_quantity) : null,
      images: Array.isArray(p.images) ? p.images.filter(x => x && typeof x.url === 'string').slice(0, 4) : []
    }));

    return res.status(200).json({ ok: true, available: true, leads, conversations, products: safeProducts });
  } catch (e) {
    console.error('[DASHBOARD LIVE]', e?.message || e);
    return res.status(200).json({ ok: true, available: false, leads: [], conversations: [], products: [], error: 'Live CRM/catalogue data unavailable' });
  }
};
