// Depo geneli ESLint ayarı (Mesaj 10 planı 3.8). Kök eslint.config.mjs bu dosyayı yeniden dışa aktarır; desenler
// depo köküne göredir. Kurallar tools/lint/rules.mjs içinde. Tip bilgisi kullanılmaz (hızlı; TS 7 ile çakışmaz).
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import {
  IGNORES, CORE_ERRORS, CORE_WARNINGS, JS_WARNINGS, TS_ERRORS, TS_WARNINGS, HOOKS_RULES,
  TEST_SYNTAX, TEST_PROPERTIES, API_SRC_SYNTAX, MOBILE_IMPORTS, CORE_LIGHT_IMPORTS, PENDING, restrictedSyntax,
} from './rules.mjs';

const JS = ['**/*.js', '**/*.mjs', '**/*.cjs'];
const TS = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const ALL = [...JS, ...TS];
const TESTS = [
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/e2e/**',
];
// React kancaları: yalnız arayüz paketleri (sunucuda `use…` adlı işlevler kanca değildir).
const UI = [
  'Deciship/apps/web/**', 'Deciship/apps/mobile/**', 'Platform/apps/hub-web/**', 'Platform/packages/shell/**',
];
const API_SRC = ['Deciship/apps/api/src/**'];

export default [
  { name: 'sod/ignores', ignores: IGNORES },

  {
    name: 'sod/base',
    files: ALL,
    // eslint-disable yorumlarının başvurduğu eklentiler her dosyada yüklü olmalı ("kural tanımı yok" hatası çıkmasın).
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { ...CORE_ERRORS, ...CORE_WARNINGS },
  },

  {
    name: 'sod/js',
    files: JS,
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-undef': 'error', ...JS_WARNINGS },
  },
  {
    name: 'sod/js-commonjs',
    files: ['**/*.cjs', 'Deciship/apps/mobile/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    name: 'sod/js-browser',
    files: ['Platform/apps/site/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  {
    name: 'sod/ts',
    files: TS,
    languageOptions: { parser: tseslint.parser },
    rules: { ...TS_ERRORS, ...TS_WARNINGS },
  },

  { name: 'sod/react-hooks', files: UI.flatMap((d) => TS.map((t) => `${d.slice(0, -3)}/${t}`)), rules: HOOKS_RULES },

  {
    name: 'sod/tests',
    files: TESTS,
    rules: {
      'no-restricted-syntax': restrictedSyntax('error', TEST_SYNTAX),
      'no-restricted-properties': ['error', ...TEST_PROPERTIES],
    },
  },
  {
    name: 'sod/api-src',
    files: API_SRC,
    rules: { 'no-restricted-syntax': restrictedSyntax('error', API_SRC_SYNTAX) },
  },
  {
    // api kaynağında test dosyası yok; olursa iki dizi birlikte geçerli olsun.
    name: 'sod/api-src-tests',
    files: API_SRC.flatMap((d) => TESTS.map((t) => `${d.slice(0, -3)}/${t}`)),
    rules: { 'no-restricted-syntax': restrictedSyntax('error', API_SRC_SYNTAX, TEST_SYNTAX) },
  },
  {
    name: 'sod/mobile-imports',
    files: ['Deciship/apps/mobile/**'],
    rules: { 'no-restricted-imports': ['error', MOBILE_IMPORTS] },
  },
  {
    name: 'sod/core-light',
    files: ['Deciship/packages/core/src/{calc,measureInput,barem}.ts'],
    rules: { 'no-restricted-imports': ['error', CORE_LIGHT_IMPORTS] },
  },

  ...PENDING.map((p, i) => ({ name: `sod/pending-${i + 1}`, files: p.files, rules: p.rules })),
];
