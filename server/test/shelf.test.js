import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('shelf entry: relative composeFile, health path, no absolute or personal paths', () => {
  const entry = read('docs/shelf-entry.json');
  assert.equal(entry.id, 'pingfederate-lab');
  assert.equal(entry.kind, 'Demo');
  assert.equal(entry.healthPath, '/api/health');
  assert.ok(!path.isAbsolute(entry.composeFile) && !entry.composeFile.includes('..'), 'composeFile is relative');
  assert.ok(fs.existsSync(path.join(root, entry.composeFile)), 'composeFile exists');
  assert.ok(!/\/(Users|home)\//.test(JSON.stringify(entry)));
  // A catalog id is used only when a row truly matches: absent here (the owner assigns one), or well formed.
  assert.ok(entry.catalogId === undefined || /^[A-Z][0-9]+$/.test(entry.catalogId));
});

test('content pack: demo-content-pack/1 shape the hub validator enforces, references resolve, no tenant data', () => {
  const pack = read('content-pack.json');
  assert.equal(pack.schema, 'demo-content-pack/1');
  assert.match(pack.id, /^[a-z][a-z0-9-]{1,40}$/);
  assert.match(pack.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pack.demo.id, 'pingfederate-lab');
  assert.ok(pack.demo.doctor.startsWith('/') && !pack.demo.doctor.startsWith('//'));
  // Catalog gap (owner decision): absent until a row is assigned, never invented.
  assert.ok(pack.demo.catalog === undefined || /^[A-Z][0-9]+$/.test(pack.demo.catalog));
  const ids = (list) => list.map((x) => x.id);
  for (const list of [pack.glossary, pack.sources, pack.cards]) {
    assert.equal(new Set(ids(list)).size, list.length, 'ids are unique');
    for (const id of ids(list)) assert.match(id, /^[A-Za-z0-9_-]{1,81}$/, `no dot in ${id}`);
  }
  const terms = new Set(ids(pack.glossary));
  for (const card of pack.cards) {
    for (const t of card.terms || []) assert.ok(terms.has(t), `card ${card.id} names unknown term ${t}`);
    assert.ok(['setup', 'try-it', 'concept', 'reference'].includes(card.group));
    assert.ok(card.action.href.startsWith('/') && !card.action.href.startsWith('//'));
  }
  for (const s of pack.sources) assert.match(s.url, /^https:\/\/[^@\s]+$/);
  const text = JSON.stringify(pack);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), 'no token-shaped value');
  assert.ok(!/\/(Users|home)\//.test(text));
});

test('docs: the talk track and the CI workflow exist and follow the rules file', () => {
  assert.ok(fs.readFileSync(path.join(root, 'docs/talk-track.md'), 'utf8').length > 500);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(!/self-hosted/.test(ci), 'hosted runners only');
  assert.ok(/node-version: 26/.test(ci) && !/node-version: (20|22)/.test(ci) && !/\[2[02]/.test(ci), 'Node 26 only');
  assert.ok(/sha256sum -c/.test(ci), 'the gitleaks download is checked against its published checksum');
  for (const job of ['build:', 'test:', 'doctor:', 'forbidden-strings:', 'gitleaks:']) assert.ok(ci.includes(`  ${job}`), job);
  assert.ok(ci.includes('actions/checkout@v5') && ci.includes('actions/setup-node@v5'));
});
