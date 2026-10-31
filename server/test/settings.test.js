import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSettings, SettingsError } from '../src/settings.js';
import { tempSettingsFile } from './helpers.js';

test('secrets are write-only: the view says set true/false, never the value', () => {
  const s = createSettings({ file: tempSettingsFile() });
  const view = s.update({ pf: { issuer: 'https://pf.example/' }, ciba: { clientId: 'c1', clientSecret: 's3cret-value-xyz' } });
  assert.deepEqual(view.settings.ciba.clientSecret, { set: true });
  assert.deepEqual(view.settings.dcr.iatClientSecret, { set: false });
  assert.equal(view.settings.pf.issuer, 'https://pf.example', 'trailing slash dropped');
  assert.ok(!JSON.stringify(view).includes('s3cret-value-xyz'));
  assert.equal(s.value('ciba', 'clientSecret'), 's3cret-value-xyz', 'the server itself can still use it');
  assert.equal(view.ready.ciba, true);
  assert.equal(view.ready.dcr, false);
});

test('the file is mode 600 and survives a reload; a too-open file is narrowed', () => {
  const file = tempSettingsFile();
  const s = createSettings({ file });
  s.update({ pf: { issuer: 'https://pf.example' }, signin: { clientId: 'abc', clientSecret: 'keep-me-123' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  const again = createSettings({ file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(again.value('signin', 'clientId'), 'abc');
  assert.equal(again.value('signin', 'clientSecret'), 'keep-me-123');
});

test('an empty secret keeps the stored one; null clears it; empty text clears a plain field', () => {
  const s = createSettings({ file: tempSettingsFile() });
  s.update({ signin: { clientId: 'abc', clientSecret: 'first-secret-1' } });
  s.update({ signin: { clientSecret: '' } });
  assert.equal(s.value('signin', 'clientSecret'), 'first-secret-1');
  s.update({ signin: { clientSecret: null, clientId: '' } });
  assert.equal(s.value('signin', 'clientSecret'), '');
  assert.equal(s.value('signin', 'clientId'), '');
});

test('validation: https issuer only, loopback http only for redirect and links, unknown fields refused, nothing half-written', () => {
  const file = tempSettingsFile();
  const s = createSettings({ file });
  for (const bad of ['http://pf.example', 'ftp://pf.example', 'https://u:p@pf.example', 'not a url', 'https://pf.example/#x',
    'https://169.254.169.254', 'https://10.0.0.5:9031', 'https://127.0.0.1:9031', 'https://[::1]:9031', 'https://2130706433', 'https://0x7f.1', 'https://localhost:9031', 'https://pf.localhost']) {
    assert.throws(() => s.update({ pf: { issuer: bad } }), SettingsError, bad);
  }
  assert.throws(() => s.update({ links: { cimdLabUrl: 'http://cimd.example' } }), SettingsError);
  s.update({ links: { cimdLabUrl: 'http://127.0.0.1:5250' }, pf: { redirectUri: 'http://localhost:5400/cb' } });
  assert.throws(() => s.update({ nope: {} }), /Unknown section/);
  assert.throws(() => s.update({ pf: { evil: 'x' } }), /Unknown field/);
  assert.throws(() => s.update(JSON.parse('{"__proto__":{"x":1}}')), SettingsError);
  assert.throws(() => s.update({ pf: JSON.parse('{"__proto__":"x"}') }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 'has space' } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 'x'.repeat(600) } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientSecret: 'a\nb' } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 7 } }), SettingsError);
  // One bad field in a patch: nothing from that patch is stored.
  assert.throws(() => s.update({ signin: { clientId: 'good' }, pf: { issuer: 'http://bad.example' } }));
  assert.equal(createSettings({ file }).value('signin', 'clientId'), '');
});

test('defaults: the redirect URI is on the lab port, scopes have defaults', () => {
  const s = createSettings({ file: tempSettingsFile() });
  assert.equal(s.value('pf', 'redirectUri'), 'http://127.0.0.1:5400/callback');
  assert.equal(s.value('signin', 'scope'), 'openid profile');
  assert.equal(s.ready('discovery'), false);
});

test('hostile fields are dropped one by one; a corrupt file stops the lab and is left untouched', () => {
  const file = tempSettingsFile();
  fs.writeFileSync(file, JSON.stringify({ values: { pf: { issuer: 'http://insecure.example' }, signin: { clientId: 'ok-id' }, extra: { a: 1 } } }), { mode: 0o600 });
  const s = createSettings({ file });
  assert.equal(s.value('pf', 'issuer'), '');
  assert.equal(s.value('signin', 'clientId'), 'ok-id');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => createSettings({ file }), (e) => e instanceof SettingsError && e.field === 'file');
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});
