// Merkez sahte API'si Node'da (`msw/node`): `src/mocks/handlers.ts` tarayıcıdakiyle aynı işleyiciler ve aynı gerçek yanıt kayıtları
// (`src/mocks/browser.ts` gibi `e2e/fixtures/<anahtar>-real/*.json`, yalnız örnek üreticisi olmayan araçlar). Tarayıcı yerleşikleri
// (localStorage, location) bellekte taklit edilir; her `freshMock()` tohumdan başlar. Yalnız `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { setupServer } from 'msw/node';
import { isProductKey } from '@sellerondata/contracts';

const ORIGIN = 'http://localhost:5180';

class MemoryStorage {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.location = new URL(`${ORIGIN}/`);
globalThis.window = globalThis;

const { accountHandlers, productHandlers } = await import('../../src/mocks/handlers.ts');
const { groupRecordings, usesRecordings } = await import('../../src/mocks/hub.ts');

const FIXTURES = path.resolve(import.meta.dirname, '../../e2e/fixtures');

/** Tarayıcıdaki `loadRecordings` ile aynı seçim: glob yolu biçiminde (yol → içerik) okunur, araç başına bölünür. */
function loadRecordings() {
  const entries = {};
  for (const dir of fs.readdirSync(FIXTURES).filter((d) => d.endsWith('-real'))) {
    const key = dir.slice(0, -5);
    if (!isProductKey(key) || !usesRecordings(key)) continue;
    for (const f of fs.readdirSync(path.join(FIXTURES, dir)).filter((x) => x.endsWith('.json'))) {
      entries[`../../e2e/fixtures/${dir}/${f}`] = JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, f), 'utf8'));
    }
  }
  return groupRecordings(entries);
}

/** Araç anahtarı → gerçek yanıt kaydı (Node sahte API'si bununla kurulur). */
export const RECORDINGS = loadRecordings();

let server;
/** Sahte API'yi açar (bir kez) ve tohum verisine döner; gecikme kapalı. */
export function freshMock() {
  if (!server) {
    server = setupServer(...accountHandlers, ...productHandlers((key) => RECORDINGS[key]));
    server.listen({ onUnhandledRequest: 'error' });
  }
  localStorage.clear();
  localStorage.setItem('sod_mock_fast', '1');
}

export function closeMock() {
  server?.close();
  server = undefined;
}

/** Sahte API isteği; tarayıcı gibi aynı köken, CSRF ve etkin firma başlığı. */
export async function call(method, path, { body, locale = 'tr', headers = {} } = {}) {
  const session = JSON.parse(localStorage.getItem('sod_mock_session') ?? 'null');
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      'accept-language': locale,
      'x-sod-csrf': '1',
      ...(session?.orgId ? { 'x-sod-org': session.orgId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
