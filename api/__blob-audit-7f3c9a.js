const { list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }
  try {
    let cursor;
    let page = 0;
    do {
      const result = await list({ limit: 100, cursor });
      page += 1;
      console.log('[BLOB AUDIT]', JSON.stringify({
        page,
        count: result.blobs?.length || 0,
        blobs: (result.blobs || []).map((b) => ({
          pathname: b.pathname,
          url: b.url,
          size: b.size,
          uploadedAt: b.uploadedAt,
          contentType: b.contentType || null,
        })),
      }));
      cursor = result.cursor;
    } while (cursor);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error('[BLOB AUDIT] list failed:', error?.message || error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false }));
  }
};
