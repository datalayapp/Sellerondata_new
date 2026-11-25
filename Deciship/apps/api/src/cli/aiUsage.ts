/**
 * Destek komutları (Mesaj 6). Sistemde operatör girişi yok; destek Hesap'taki `phone:release` deseniyle komut satırından çalışır.
 *
 *   npm run ai:usage -- [--period 2026-11] [--company <id>] [--json]
 *   npm run ai:grant -- --company <id> --amount 250 [--period 2026-11] --operator "Ad" [--note "..."] [--ref <id>] [--adjust]
 *   Üretim kabında: node dist/aiUsage.js usage … | node dist/aiUsage.js grant …
 *   Çalıştırma girişi src/bin/aiUsage.ts; bu dosya kendini çalıştırmaz (tsup bölmesi, src/bin/runCli.ts).
 *
 * `usage` bütün firmaları `withSupportScope` ile okur (yalnız AiUsage, AiCreditEntry, Company; yalnız okuma). Bu kapsam yalnız
 * buradan açılır, HTTP isteğinden asla (test/aiMeter.test.ts kaynakta denetler). `grant` tek firmaya `withCompany` ile yazar.
 * Çıktı ASCII İngilizce (test/i18n.test.ts kaynakta Türkçe harf arar).
 *
 * Hak sütunu: ortamdaki ücretsiz hak (AI_FREE_CREDIT_MONTHLY_TRY) + o döneme verilen kredi. Planın `aiCreditMonthly` limiti
 * jetonda gelir, veritabanında durmaz: plana özel hak burada görünmez (çıktıda yazılır).
 */
import { AI_PERIOD_PATTERN, aiMicrosToAmount, aiPeriodOf } from '@sellerondata/contracts';
import { Prisma, prisma, withCompany, withSupportScope } from '../db.ts';
import { env } from '../env.ts';
import { readSettings } from '../lib/settings.ts';
import { DEFAULT_TIME_ZONE, isTimeZone } from '../lib/time.ts';
import { aiDailyBudgetReport } from '../services/aiDailyBudget.ts';
import { BILLABLE_STATUS, aiFreeMicros, aiPeriodAllowance, aiTimeZone, aiUsedPct } from '../services/aiMeter.ts';

export type CliOut = { log: (line: string) => void; error: (line: string) => void };

type Args = Record<string, string | true>;

export function parseArgs(argv: string[]): { command: string | undefined; args: Args } {
  const [command, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else args[key] = true;
  }
  return { command, args };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v.trim() : undefined);
const tzOf = (settings: unknown) => {
  const tz = readSettings(settings).timeZone;
  return typeof tz === 'string' && isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
};
const micros = (d: Prisma.Decimal | null | undefined) => (d ? Number(new Prisma.Decimal(d).mul(1_000_000).toFixed(0)) : 0);

export type UsageRow = {
  companyId: string;
  name: string;
  period: string;
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  durationMs: number;
  /** kotadan düşen (`OK`) */
  usedAmount: number;
  /** sonuç vermeyen çağrıların gerçek maliyeti (`FAILED`): bizim zararımız, kotadan düşmez */
  unbilledAmount: number;
  /** `FAILED` tavanı (hak × AI_FAILED_BUDGET_RATIO) ve dolu mu: doluysa firmanın yeni çağrıları durur */
  failedBudgetAmount: number;
  failedBudgetExhausted: boolean;
  creditAmount: number;
  allowanceAmount: number;
  usedPct: number;
};

/** Firma bazında liste. Dönem verilmezse her firmanın kendi saat dilimindeki bu ay. Yalnız o dönemde kaydı olan firmalar. */
export async function usageReport(opts: { period?: string; companyId?: string; now?: Date } = {}): Promise<UsageRow[]> {
  const now = opts.now ?? new Date();
  return withSupportScope(async () => {
    const companies = await prisma.company.findMany({
      where: opts.companyId ? { id: opts.companyId } : {},
      select: { id: true, name: true, settings: true },
    });
    const periodOf = new Map(companies.map((c) => [c.id, opts.period ?? aiPeriodOf(now, tzOf(c.settings))]));
    const periods = [...new Set(periodOf.values())];
    const companyFilter = opts.companyId ? { companyId: opts.companyId } : {};
    const usage = await prisma.aiUsage.groupBy({
      by: ['companyId', 'period', 'status'],
      where: { ...companyFilter, period: { in: periods } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, durationMs: true, cost: true },
    });
    const credits = await prisma.aiCreditEntry.groupBy({
      by: ['companyId', 'period'],
      where: { ...companyFilter, period: { in: periods } },
      _sum: { amount: true },
    });
    const free = aiFreeMicros({});
    const rows = new Map<string, UsageRow & { usedMicros: number; unbilledMicros: number; creditMicros: number }>();
    const rowFor = (companyId: string, period: string) => {
      if (periodOf.get(companyId) !== period) return null;
      let r = rows.get(companyId);
      if (!r) {
        const c = companies.find((x) => x.id === companyId);
        r = { companyId, name: c?.name ?? '', period, calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, durationMs: 0, usedAmount: 0, unbilledAmount: 0, failedBudgetAmount: 0, failedBudgetExhausted: false, creditAmount: 0, allowanceAmount: 0, usedPct: 0, usedMicros: 0, unbilledMicros: 0, creditMicros: 0 };
        rows.set(companyId, r);
      }
      return r;
    };
    for (const u of usage) {
      const r = rowFor(u.companyId, u.period);
      if (!r) continue;
      if (u.status === 'CACHED') r.cachedCalls += u._count._all;
      else r.calls += u._count._all;
      r.inputTokens += u._sum.inputTokens ?? 0;
      r.outputTokens += u._sum.outputTokens ?? 0;
      r.cacheTokens += (u._sum.cacheReadTokens ?? 0) + (u._sum.cacheWriteTokens ?? 0);
      r.durationMs += u._sum.durationMs ?? 0;
      if (u.status === BILLABLE_STATUS) r.usedMicros += micros(u._sum.cost);
      else if (u.status === 'FAILED') r.unbilledMicros += micros(u._sum.cost);
    }
    for (const c of credits) {
      const r = c.period ? rowFor(c.companyId, c.period) : null;
      if (r) r.creditMicros += micros(c._sum.amount);
    }
    return [...rows.values()]
      .map(({ usedMicros, unbilledMicros, creditMicros, ...r }) => ({
        ...r,
        usedAmount: aiMicrosToAmount(usedMicros),
        unbilledAmount: aiMicrosToAmount(unbilledMicros),
        failedBudgetAmount: aiMicrosToAmount(Math.max(0, Math.round((free + creditMicros) * env.aiFailedBudgetRatio))),
        failedBudgetExhausted: unbilledMicros > 0 && unbilledMicros >= Math.max(0, Math.round((free + creditMicros) * env.aiFailedBudgetRatio)),
        creditAmount: aiMicrosToAmount(creditMicros),
        allowanceAmount: aiMicrosToAmount(free + creditMicros),
        usedPct: aiUsedPct(usedMicros, free + creditMicros),
      }))
      .sort((a, b) => b.usedAmount - a.usedAmount || a.companyId.localeCompare(b.companyId));
  });
}

const pad = (v: string | number, n: number, right = false) => {
  const s = String(v);
  return right ? s.padStart(n) : s.padEnd(n);
};
/** Ad terminalde ASCII: aksanlar düşer (ç → c, İ → I), noktasız i → i, kalan ASCII olmayan → '?'. */
const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .replace(/[^\x20-\x7e]/g, '?');

export function formatUsage(rows: UsageRow[]): string[] {
  const lines = [
    `Allowance = default free credit (AI_FREE_CREDIT_MONTHLY_TRY=${env.aiFreeCreditMonthlyTry}) + grants for the period; plan limits from tokens are not visible here.`,
    `unbilled = cost of failed calls (not charged); fail_cap = allowance x AI_FAILED_BUDGET_RATIO=${env.aiFailedBudgetRatio}; FAILED-BUDGET-FULL blocks new AI calls until next period.`,
    [pad('company', 36), pad('name', 24), pad('period', 7), pad('calls', 6, true), pad('cached', 6, true), pad('in_tok', 10, true), pad('out_tok', 10, true), pad('dur_s', 8, true), pad('used_TRY', 11, true), pad('unbilled_TRY', 12, true), pad('fail_cap_TRY', 12, true), pad('allow_TRY', 11, true), pad('pct', 5, true), 'note'].join(' '),
  ];
  for (const r of rows) {
    lines.push(
      [
        pad(r.companyId, 36),
        pad(ascii(r.name).slice(0, 24), 24),
        pad(r.period, 7),
        pad(r.calls, 6, true),
        pad(r.cachedCalls, 6, true),
        pad(r.inputTokens, 10, true),
        pad(r.outputTokens, 10, true),
        pad((r.durationMs / 1000).toFixed(1), 8, true),
        pad(r.usedAmount.toFixed(2), 11, true),
        pad(r.unbilledAmount.toFixed(2), 12, true),
        pad(r.failedBudgetAmount.toFixed(2), 12, true),
        pad(r.allowanceAmount.toFixed(2), 11, true),
        pad(`${r.usedPct}%`, 5, true),
        r.failedBudgetExhausted ? 'FAILED-BUDGET-FULL' : '',
      ].join(' ').trimEnd(),
    );
  }
  if (!rows.length) lines.push('(no AI usage in this period)');
  return lines;
}

/**
 * Sistemin günlük tavanı (bütün firmalar, sistem günü; `services/aiDailyBudget.ts`): bugünkü toplam ve `AI_DAILY_BUDGET_TRY`.
 * Toplam destek kapsamında okunur (bu komut zaten oradadır). `--json` çıktısı değişmez.
 */
export async function dailyBudgetLine(now: Date = new Date()): Promise<string> {
  const r = await withSupportScope(() => aiDailyBudgetReport(now));
  const spent = aiMicrosToAmount(r.spentMicros).toFixed(2);
  if (r.budgetTry === null) return `Today ${r.day} (${r.timeZone}), all companies: ${spent} TRY; AI_DAILY_BUDGET_TRY=off (no daily cap).`;
  const pct = aiUsedPct(r.spentMicros, Math.round(r.budgetTry * 1_000_000));
  const full = r.spentMicros >= Math.round(r.budgetTry * 1_000_000) ? ' DAILY-BUDGET-FULL: new AI calls are rejected until tomorrow.' : '';
  return `Today ${r.day} (${r.timeZone}), all companies: ${spent} TRY of AI_DAILY_BUDGET_TRY=${r.budgetTry} (${pct}%).${full}`;
}

export type GrantInput = { companyId: string; amount: number; operator: string; period?: string; note?: string; ref?: string; adjust?: boolean };
export type GrantResult = { status: 'granted' | 'already-applied'; entryId: string; period: string; amount: number; allowanceAmount: number; usedAmount: number };

/**
 * Ek kredi (`AiCreditEntry`, GRANT; `adjust` ile ADJUST, eksi olabilir). Yalnız o döneme geçer. `ref` verilirse aynı firmada bir kez
 * uygulanır (`externalRef` benzersiz): komut iki kez çalışsa da tek kayıt.
 */
export async function grantCredit(input: GrantInput, now = new Date()): Promise<GrantResult> {
  const operator = input.operator.trim();
  if (!operator) throw new Error('--operator is required');
  if (!Number.isFinite(input.amount) || input.amount === 0 || Math.abs(input.amount) > 1_000_000_000) throw new Error('--amount must be a non-zero number');
  if (Math.round(input.amount * 100) / 100 !== input.amount) throw new Error('--amount may have at most 2 decimals');
  if (!input.adjust && input.amount < 0) throw new Error('--amount must be positive (use --adjust for corrections)');
  if (input.period !== undefined && !AI_PERIOD_PATTERN.test(input.period)) throw new Error('--period must be YYYY-MM');
  const companyId = input.companyId.trim();
  const company = await withCompany(companyId, () => prisma.company.findFirst({ where: { id: companyId }, select: { id: true } }));
  if (!company) throw new Error(`company not found: ${companyId}`);
  const timeZone = await aiTimeZone(companyId);
  const period = input.period ?? aiPeriodOf(now, timeZone);
  const ref = input.ref?.trim() || null;
  let status: GrantResult['status'] = 'granted';
  let entryId: string;
  try {
    entryId = (
      await withCompany(companyId, () =>
        prisma.aiCreditEntry.create({
          data: { companyId, kind: input.adjust ? 'ADJUST' : 'GRANT', amount: new Prisma.Decimal(input.amount.toFixed(2)), period, note: input.note?.trim() || null, operator, externalRef: ref },
          select: { id: true },
        }),
      )
    ).id;
  } catch (err) {
    if (!(ref && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    status = 'already-applied';
    entryId = (await withCompany(companyId, () => prisma.aiCreditEntry.findFirstOrThrow({ where: { companyId, externalRef: ref }, select: { id: true } }))).id;
  }
  const a = await aiPeriodAllowance(companyId, period, {}, timeZone);
  return { status, entryId, period, amount: input.amount, allowanceAmount: aiMicrosToAmount(a.freeMicros + a.creditMicros), usedAmount: aiMicrosToAmount(a.usedMicros) };
}

const USAGE_HELP = [
  'Usage:',
  '  ai:usage -- [--period YYYY-MM] [--company <id>] [--json]   (unbilled_TRY: cost of failed calls, not charged to the quota)',
  '  ai:grant -- --company <id> --amount <TRY> --operator "<name>" [--period YYYY-MM] [--note "..."] [--ref <id>] [--adjust]',
];

export async function runAiUsageCli(argv: string[], out: CliOut = { log: (l) => console.log(l), error: (l) => console.error(l) }): Promise<number> {
  const { command, args } = parseArgs(argv);
  try {
    if (command === 'usage') {
      const period = str(args.period);
      if (period !== undefined && !AI_PERIOD_PATTERN.test(period)) throw new Error('--period must be YYYY-MM');
      const rows = await usageReport({ period, companyId: str(args.company) });
      if (args.json) out.log(JSON.stringify(rows, null, 2));
      else {
        for (const l of formatUsage(rows)) out.log(l);
        out.log(await dailyBudgetLine());
      }
      return 0;
    }
    if (command === 'grant') {
      const companyId = str(args.company);
      if (!companyId) throw new Error('--company is required');
      const amountText = str(args.amount) ?? '';
      // yalnız düz ondalık sayı (1e3, 0x10, " 5 " gibi biçimler reddedilir); --adjust ile başta '-' serbest
      if (!(args.adjust === true ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(amountText)) throw new Error('--amount must be a plain decimal number with at most 2 decimals');
      const amount = Number(amountText);
      if (!str(args.ref)) out.error('Warning: no --ref given; running this command twice will grant twice.');
      const r = await grantCredit({ companyId, amount, operator: str(args.operator) ?? '', period: str(args.period), note: str(args.note), ref: str(args.ref), adjust: args.adjust === true });
      out.log(
        r.status === 'granted'
          ? `Granted ${r.amount.toFixed(2)} TRY to ${companyId} for ${r.period} (entry ${r.entryId}).`
          : `Already applied (ref ${str(args.ref)}): entry ${r.entryId}, nothing written.`,
      );
      out.log(`Period ${r.period}: used ${r.usedAmount.toFixed(2)} TRY of ${r.allowanceAmount.toFixed(2)} TRY (default free credit + grants).`);
      return 0;
    }
    for (const l of USAGE_HELP) out.error(l);
    return 2;
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
