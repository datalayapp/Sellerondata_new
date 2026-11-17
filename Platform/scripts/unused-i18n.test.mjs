// node --test Platform/scripts/unused-i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, deleteKeys, scanCorpus } from './unused-i18n.mjs';

function corpus(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-i18n-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  try {
    return scanCorpus([dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const c = corpus({
  'App.tsx': [
    "t('page.title'); t('common:panel.close'); t('n', { count })",
    't(`status.${s}`); t(`steps.${id}.title`); t(`ns:${k}`)',
    "lazy('dimMethod', ['LIDAR']); const k = 'recalc.' + x;",
  ].join('\n'),
});
const g = (ns, key) => classify(ns, key, c).group;

test('tam yol, ad alanlı yol ve çoğul kök kullanılıyor sayılır', () => {
  assert.equal(g('x', 'page.title'), 'used');
  assert.equal(g('common', 'panel.close'), 'used');
  assert.equal(g('x', 'n_one'), 'used');
  assert.equal(g('x', 'n_other'), 'used');
});

test('şablon, önek ve parçalı kurulum silinmez (dinamik)', () => {
  assert.equal(g('x', 'status.DIFF'), 'dynamic');
  assert.equal(g('x', 'steps.weight.title'), 'dynamic');
  assert.equal(g('x', 'recalc.anything'), 'dynamic');
  assert.equal(g('x', 'dimMethod.LIDAR'), 'dynamic');
});

test('`ns:${k}` gibi sabit kısmı yalnız ad alanı olan şablon her anahtara uymaz; izi olmayan anahtar kullanılmıyor', () => {
  assert.equal(g('x', 'page.removed'), 'unused');
  assert.equal(g('x', 'dimMethod.UNKNOWN'), 'unused');
  assert.equal(g('x', 'panel.open'), 'unused');
  // Şablonun sabit başı (`steps.`) önek de sayılır: bilerek geniş, yanılma yönü "kullanılıyor".
  assert.equal(g('x', 'steps.weight.short'), 'dynamic');
});

test('silme yalnız ilgili satırları değiştirir, boşalan nesneyi kaldırır, satır sonunu korur', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-i18n-del-'));
  try {
    const f = path.join(dir, 'a.json');
    const src = { a: { b: 'x', c: 'y' }, d: { e: 'z' }, f: 'w' };
    fs.writeFileSync(f, (JSON.stringify(src, null, 2) + '\n').replace(/\n/g, '\r\n'));
    assert.deepEqual(deleteKeys(f, ['a.c', 'd.e', 'yok.yok']).removed, ['a.c', 'd.e']);
    const out = fs.readFileSync(f, 'utf8');
    assert.equal(out, (JSON.stringify({ a: { b: 'x' }, f: 'w' }, null, 2) + '\n').replace(/\n/g, '\r\n'));
    fs.writeFileSync(f, '{"a": "x", "b": "y"}');
    assert.match(deleteKeys(f, ['a']).skipped, /biçim/);
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a": "x", "b": "y"}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
