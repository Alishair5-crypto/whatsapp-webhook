const test = require('node:test');
const assert = require('node:assert/strict');

const evolution = require('./evolution-whatsapp');

test('normalizes Evolution MESSAGES_UPSERT text event to canonical WhatsApp message', () => {
  const result = evolution.normalizeMessage({
    event: 'messages.upsert',
    instance: 'fatima-arts',
    data: {
      pushName: 'Ali',
      key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: false, id: 'MSG-123' },
      message: { conversation: 'Assalam o Alaikum' }
    }
  });

  assert.equal(result.provider, 'evolution');
  assert.equal(result.instance, 'fatima-arts');
  assert.equal(result.message.from, '923001234567');
  assert.equal(result.message.id, 'MSG-123');
  assert.equal(result.message.type, 'text');
  assert.equal(result.message.text.body, 'Assalam o Alaikum');
  assert.equal(result.contact.profile.name, 'Ali');
});

test('normalizes image and audio media metadata without losing the raw media envelope', () => {
  const result = evolution.normalizeMessage({
    event: 'MESSAGES_UPSERT',
    instance: 'shop-1',
    data: {
      key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: false, id: 'MEDIA-1' },
      message: {
        imageMessage: { url: 'https://cdn.example/image.jpg', mimetype: 'image/jpeg', caption: 'new suit' }
      }
    }
  });

  assert.equal(result.message.type, 'image');
  assert.equal(result.message.image.url, 'https://cdn.example/image.jpg');
  assert.equal(result.message.image.caption, 'new suit');
  assert.ok(result.message._evolutionRawMessage.imageMessage);

  const audio = evolution.normalizeMessage({
    event: 'MESSAGES_UPSERT',
    instance: 'shop-1',
    data: {
      key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: false, id: 'AUDIO-1' },
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', base64: 'ZmFrZQ==', seconds: 4 }
      }
    }
  });

  assert.equal(audio.message.type, 'audio');
  assert.equal(audio.message.audio.base64, 'ZmFrZQ==');
  assert.equal(audio.message.audio.duration, 4);
});

test('normalizes Evolution delivery/read status events to canonical statuses', () => {
  const previous = process.env.EVOLUTION_INSTANCES_JSON;
  process.env.EVOLUTION_INSTANCES_JSON = JSON.stringify({
    shopA: { apiUrl: 'https://evolution.example', apiKey: 'secret-A', tenantId: 'tenant-A' }
  });

  try {
    const delivered = evolution.normalizeStatus({
      event: 'messages.update',
      instance: 'shopA',
      data: {
        key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: true, id: 'MSG-9' },
        status: 3
      }
    });
    assert.equal(delivered.tenantId, 'tenant-A');
    assert.equal(delivered.status, 'DELIVERED');
    assert.equal(delivered.messageId, 'MSG-9');

    const read = evolution.normalizeStatus({
      event: 'messages.update',
      instance: 'shopA',
      data: {
        key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: true, id: 'MSG-9' },
        status: 4
      }
    });
    assert.equal(read.status, 'READ');
    assert.notEqual(read.eventId, delivered.eventId);
  } finally {
    if (previous === undefined) delete process.env.EVOLUTION_INSTANCES_JSON;
    else process.env.EVOLUTION_INSTANCES_JSON = previous;
  }
});

test('multi-tenant mapping rejects unknown instances when a mapping is configured', () => {
  const previous = process.env.EVOLUTION_INSTANCES_JSON;
  process.env.EVOLUTION_INSTANCES_JSON = JSON.stringify({
    shopA: { apiUrl: 'https://evolution.example', apiKey: 'secret-A', tenantId: 'tenant-A' }
  });

  try {
    assert.equal(evolution.getInstanceConfig('shopA').tenantId, 'tenant-A');
    assert.equal(evolution.getInstanceConfig('unknown-shop'), null);
  } finally {
    if (previous === undefined) delete process.env.EVOLUTION_INSTANCES_JSON;
    else process.env.EVOLUTION_INSTANCES_JSON = previous;
  }
});

test('ignores self, group, status, and non-message events', () => {
  assert.equal(evolution.normalizeMessage({
    event: 'messages.upsert',
    instance: 'x',
    data: { key: { remoteJid: '923@s.whatsapp.net', fromMe: true, id: '1' }, message: { conversation: 'x' } }
  }), null);

  assert.equal(evolution.normalizeMessage({
    event: 'messages.upsert',
    instance: 'x',
    data: { key: { remoteJid: '123@g.us', fromMe: false, id: '2' }, message: { conversation: 'x' } }
  }), null);

  assert.equal(evolution.normalizeMessage({
    event: 'connection.update',
    instance: 'x',
    data: { key: { remoteJid: '923@s.whatsapp.net', fromMe: false, id: '3' }, message: { conversation: 'x' } }
  }), null);
});
