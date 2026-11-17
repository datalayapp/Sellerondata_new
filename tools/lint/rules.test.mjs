// Lint kurallarının kendisini sınar: proje kuralları gerçekten yakalıyor mu, meşru kullanım serbest mi.
// Koşturma: node --test tools/lint/rules.test.mjs (kökten). Dosya yazmaz; lintText sanal yol kullanır.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function lint(rel, code) {
  const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, rel) });
  return r.messages.map((m) => `${m.severity === 2 ? 'E' : 'W'}:${m.ruleId}`);
}
const errs = (msgs) => msgs.filter((m) => m.startsWith('E:'));

test('test dosyasında only, koşulsuz skip, xit/fit hata', async () => {
  const f = 'Platform/apps/account-api/test/ornek.test.ts';
  assert.deepEqual(errs(await lint(f, "it.only('a', () => {});\n")), ['E:no-restricted-syntax']);
  assert.deepEqual(errs(await lint(f, "describe.only('a', () => {});\n")), ['E:no-restricted-syntax']);
  assert.deepEqual(errs(await lint(f, "it.skip('a', () => {});\n")), ['E:no-restricted-syntax']);
  assert.deepEqual(errs(await lint(f, "test.todo(`a`);\n")), ['E:no-restricted-syntax']);
  assert.deepEqual(errs(await lint(f, "xit('a', () => {});\nfdescribe('b', () => {});\n")), ['E:no-restricted-syntax', 'E:no-restricted-syntax']);
  assert.deepEqual(errs(await lint('Deciship/apps/web/e2e/ornek.spec.ts', "test.describe.skip('a', () => {});\n")), ['E:no-restricted-syntax']);
});

test('Playwright koşullu skip serbest; skipIf gerekçesiz hata, gerekçeli serbest', async () => {
  const e2e = 'Deciship/apps/web/e2e/ornek.spec.ts';
  assert.deepEqual(errs(await lint(e2e, "const REAL = true;\ntest.skip(REAL, 'gerçek yığında koşmaz');\n")), []);
  const f = 'Platform/packages/auth-kit/test/ornek.test.ts';
  assert.deepEqual(errs(await lint(f, "const c = true;\ndescribe.skipIf(c)('a', () => {});\n")), ['E:no-restricted-properties']);
  assert.deepEqual(errs(await lint(f, "const c = true;\nit.runIf(c)('a', () => {});\n")), ['E:no-restricted-properties']);
  const ok = "const c = true;\n// eslint-disable-next-line no-restricted-properties -- örnek gerekçe\ndescribe.skipIf(c)('a', () => {});\n";
  assert.deepEqual(await lint(f, ok), []);
});

test('test dışı dosyada only/skip kuralı yok', async () => {
  assert.deepEqual(errs(await lint('Platform/apps/account-api/src/ornek.ts', "export const x = [1].filter(Boolean);\nconst o = { only: () => 1 };\no.only();\n")), []);
});

test('api kaynağında findUnique ve dizi biçimli $transaction hata', async () => {
  const f = 'Deciship/apps/api/src/services/ornek.ts';
  const code = "declare const prisma: any;\nexport async function a() {\n  await prisma.user.findUnique({ where: { id: 1 } });\n  await prisma.user.findUniqueOrThrow({ where: { id: 1 } });\n  await prisma.$transaction([prisma.user.findFirst()]);\n  await prisma.$transaction(async (tx: unknown) => tx);\n}\n";
  assert.deepEqual(errs(await lint(f, code)), ['E:no-restricted-syntax', 'E:no-restricted-syntax', 'E:no-restricted-syntax']);
  // api testlerinde serbest (rls.test.ts kaynakta findUnique arar).
  assert.deepEqual(errs(await lint('Deciship/apps/api/test/ornek.test.ts', code)), []);
});

test('mobilde kök @deciship/core yasak, alt yol serbest', async () => {
  const f = 'Deciship/apps/mobile/src/ornek.ts';
  assert.deepEqual(errs(await lint(f, "import { desi } from '@deciship/core';\nexport const x = desi;\n")), ['E:no-restricted-imports']);
  assert.deepEqual(errs(await lint(f, "import { desi } from '@deciship/core/calc';\nexport const x = desi;\n")), []);
});

test('core hafif dosyaları ağır bağımlılık çekmez', async () => {
  const f = 'Deciship/packages/core/src/calc.ts';
  assert.deepEqual(errs(await lint(f, "import ExcelJS from 'exceljs';\nexport const x = ExcelJS;\n")), ['E:no-restricted-imports']);
  assert.deepEqual(errs(await lint(f, "import { read } from './invoice/read';\nexport const x = read;\n")), ['E:no-restricted-imports']);
  assert.deepEqual(errs(await lint(f, "import { t } from './i18n/index';\nexport const x = t;\n")), []);
  // Öteki core dosyaları serbest.
  assert.deepEqual(errs(await lint('Deciship/packages/core/src/tariffImport.ts', "import ExcelJS from 'exceljs';\nexport const x = ExcelJS;\n")), []);
});

test('hata sınıfı çekirdek kurallar ve uyarı sınıfı', async () => {
  const f = 'Platform/apps/account-api/src/ornek.ts';
  assert.deepEqual(errs(await lint(f, "export const a = (x: number) => x === NaN;\n")), ['E:use-isnan']);
  assert.deepEqual(errs(await lint(f, "export const o = { a: 1, a: 2 };\n")), ['E:no-dupe-keys']);
  assert.deepEqual(errs(await lint(f, "// @ts-ignore\nexport const n: number = 'x';\n")), ['E:@typescript-eslint/ban-ts-comment']);
  assert.deepEqual(await lint(f, "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n"), ['W:@typescript-eslint/no-unused-vars']);
  assert.deepEqual(await lint(f, "export function f(_a: number, ...rest: number[]) { return rest; }\n"), []);
});

test('kanca kuralları yalnız arayüz paketlerinde', async () => {
  const code = "import { useState } from 'react';\nexport function f(c: boolean) {\n  if (c) { useState(0); }\n}\n";
  assert.deepEqual(errs(await lint('Deciship/apps/web/src/ornek.tsx', code)), ['E:react-hooks/rules-of-hooks']);
  assert.deepEqual(errs(await lint('Platform/apps/account-api/src/ornek.ts', code)), []);
});

test('js dosyalarında no-undef; Node genel adları tanınır', async () => {
  assert.deepEqual(errs(await lint('scripts/ornek.mjs', "console.log(process.argv, tanimsiz);\n")), ['E:no-undef']);
  assert.deepEqual(errs(await lint('Deciship/apps/mobile/ornek.config.js', "module.exports = { dir: __dirname };\n")), []);
});
