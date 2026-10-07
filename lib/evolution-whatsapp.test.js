const test = require('node:test');
const assert = require('node:assert/strict');

const evolution = require('./evolution-whatsapp');

test('normalizes Evolution MESSAGES_UPSERT text event to canonical WhatsApp message', () => {
  const result = evolution.normalizeMessage({
    event: 'messages.upsert',
    instance: 'fatima-arts',
    data: {
      pushName: 'Ali',
      key: {
        remoteJid: '923001234567@s.whatsapp.net',
        fromMe: false,
        id: 'MSG-123'
      },
      message: {
        conversation: 'Assalam o Alaikum'
      }
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
