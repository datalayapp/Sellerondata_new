// Lint kuralları tek yerde (Mesaj 10 planı 3.8). eslint.config.mjs yalnız bunları dosya desenlerine bağlar.
// İlke: "hata" düzeyi yalnız gerçek hata sınıfıdır ve CI'yı durdurur; "uyarı" görünür ama durdurmaz.
// Biçim (boşluk, tırnak, satır uzunluğu) ESLint'in işi değil; Prettier yalnız denetler (format:check).

// Yok sayılanlar: üretilmiş kod, kurulu paketler, yerel yerleşik projeler, ham örnekler ve fikstürler.
export const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/src/generated/**',
  'Deciship/apps/mobile/android/**',
  'Deciship/apps/mobile/ios/**',
  '**/.expo/**',
  'Deciship/services/vision/**',
  'SONRAKI-OTURUM/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/screenshots/**',
  '.test-logs/**',
  'Platform/e2e/.stack/**',
  'Deciship/samples/invoices/**',
  'Deciship/packages/core/test/fixtures/**',
  'Platform/apps/site/dist/**',
  '**/*.d.ts',
  // Alt klasörlerin .gitignore dosyalarındakiler (ESLint .gitignore okumaz; .prettierignore ile aynı).
  '**/storage/**',
  '**/keys/**',
  '**/.gece/**',
  '**/.vite/**',
  '**/.gradle/**',
  '**/.venv/**',
  '**/.impeccable/**',
];

// Hata sınıfı: JS çekirdek kuralları (her dosya türünde).
export const CORE_ERRORS = {
  'no-control-regex': 'error',
  'no-irregular-whitespace': 'error',
  'no-misleading-character-class': 'error',
  'no-invalid-regexp': 'error',
  'no-empty-character-class': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-setter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-sparse-arrays': 'error',
  'no-loss-of-precision': 'error',
  'no-constant-binary-expression': 'error',
  'no-debugger': 'error',
};

// Uyarı sınıfı (görünür, CI'yı durdurmaz).
const UNUSED_OPTS = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'all',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
};
export const CORE_WARNINGS = {
  'prefer-const': 'warn',
  'no-fallthrough': 'warn',
};
export const JS_WARNINGS = {
  'no-unused-vars': ['warn', UNUSED_OPTS],
};

// typescript-eslint: tip bilgisi istemeyen kurallar (TS 7 projeleriyle çakışmasın diye tip bilgisi kullanılmaz).
export const TS_ERRORS = {
  '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
  '@typescript-eslint/no-misused-new': 'error',
  '@typescript-eslint/no-unsafe-declaration-merging': 'error',
  '@typescript-eslint/no-duplicate-enum-values': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
  // TypeScript derleyicisi tanımsız adı zaten yakalar; çekirdek kural TS'de yanlış alarm verir.
  'no-undef': 'off',
};
export const TS_WARNINGS = {
  '@typescript-eslint/no-unused-vars': ['warn', UNUSED_OPTS],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-require-imports': 'warn',
};

export const HOOKS_RULES = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
};

// ---- Proje kuralları (no-restricted-syntax) ----
// Dikkat: aynı kural sonraki blokta yeniden yazılırsa önceki dizi silinir. Bu yüzden diziler burada tanımlanır ve
// her blokta restrictedSyntax(...) ile birleştirilir.

const NO_ARGS_OR_TITLE = ":matches([arguments.length=0],[arguments.0.type='Literal'],[arguments.0.type='TemplateLiteral'])";

export const TEST_SYNTAX = [
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='only']",
    message: '`only` yasak (CLAUDE.md): öteki testler sessizce koşmaz.',
  },
  {
    selector: `CallExpression[callee.object.name=/^(it|test|describe|suite)$/][callee.property.name=/^(skip|todo)$/]${NO_ARGS_OR_TITLE}`,
    message: 'Koşulsuz `skip`/`todo` yasak (CLAUDE.md). Koşullu atlama ilk bağımsız değişkene koşul alır.',
  },
  {
    selector: `CallExpression[callee.object.property.name='describe'][callee.property.name=/^(skip|todo)$/]${NO_ARGS_OR_TITLE}`,
    message: 'Koşulsuz `test.describe.skip` yasak (CLAUDE.md).',
  },
  {
    selector: 'CallExpression[callee.name=/^(xit|xtest|xdescribe|fit|fdescribe)$/]',
    message: '`xit`/`fit` biçimi yasak (CLAUDE.md): atlama ya da tek başına koşma.',
  },
];

// Koşullu atlama (`describe.skipIf`, `it.runIf`). Plandan sapma: no-restricted-syntax yerine no-restricted-properties
// kullanılır; böylece düzeyi öteki test kurallarından ayrı tutulabilir (bekleyen dosyalarda uyarı, başka yerde hata).
// Meşru kullanım: `// eslint-disable-next-line no-restricted-properties -- <neden>`.
export const TEST_PROPERTIES = [
  { property: 'skipIf', message: 'Koşullu atlama yalnız gerekçeyle: `// eslint-disable-next-line no-restricted-properties -- <neden>`.' },
  { property: 'runIf', message: 'Koşullu koşma yalnız gerekçeyle: `// eslint-disable-next-line no-restricted-properties -- <neden>`.' },
];

const RLS_MSG = 'RLS bağlamı karışır (KOD-HARITASI "Bilinen tuzaklar"): ';
export const API_SRC_SYNTAX = [
  {
    selector: "CallExpression[callee.property.name=/^findUnique(OrThrow)?$/]",
    message: `${RLS_MSG}Prisma findUnique çağrılarını aynı tikte toplar; findFirst kullan.`,
  },
  {
    selector: "CallExpression[callee.property.name='$transaction'][arguments.0.type='ArrayExpression']",
    message: `${RLS_MSG}dizi biçimli $transaction yasak; $transaction(async (tx) => …) kullan.`,
  },
];

export const MOBILE_IMPORTS = {
  paths: [
    {
      name: '@deciship/core',
      message: 'Mobilde kök @deciship/core içe aktarılmaz (exceljs, papaparse paketlenir); alt yol kullan: @deciship/core/calc …',
    },
  ],
};

// core'un mobilde kullanılan dosyaları ağır bağımlılık çekmemeli.
export const CORE_LIGHT_IMPORTS = {
  paths: [
    { name: 'exceljs', message: 'Bu dosya mobilde kullanılır; exceljs çekmez.' },
    { name: 'papaparse', message: 'Bu dosya mobilde kullanılır; papaparse çekmez.' },
  ],
  patterns: [
    {
      group: ['./invoice/*', './invoice', './index', './index.*'],
      message: 'Bu dosya mobilde kullanılır; fatura okuyucu ya da paket kökü çekmez.',
    },
  ],
};

export const restrictedSyntax = (severity, ...lists) => [severity, ...lists.flat()];

// ---- Bekleyen düzeltmeler (geçici, uyarıya indirilmiş) ----
// Bir hata sınıfı kuralın, sahibi başka bir iş olan dosyalardaki ihlalleri burada uyarıya iner. Her madde gerekçeli;
// dosya düzeltilince madde silinir. Liste boşalınca kural her yerde hata olur.
// Bugün boş (Mesaj 10, yeni rapor): yeni madde yalnız gerekçe ve sahibiyle eklenir.
export const PENDING = [];
