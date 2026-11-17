/**
 * Açılışta şema denetimi. Üretim öncesi tek init migration kullanılır (README, ARCHITECTURE §4): eski init uygulanmış hacimde
 * `migrate deploy` değişikliği uygulamaz, `migrate status` da sorun göstermez. Bu yüzden servis kendisi bakar.
 */
import { env } from '../env.ts';

export const SCHEMA_RESET_HINT = 'Veritabanı eski şemada. Veri varsa önce yedek alın, ileri migration yazın; yalnız demo veriyse SIFIRLA.bat';

const REQUIRED_INDEXES = ['Measurement_current_tracking_key', 'Measurement_companyId_measuredById_clientId_key', 'Invoice_current_no_key', 'Dispute_active_invoice_key', 'Job_active_key'];
/**
 * Firma tablosu dışındaki yabancı anahtar sayısı (init 26 + itiraz göçü 12 + tarife sürümü göçü 4 + yapay zekâ sayacı 1 +
 * iş kuyruğu 1). Yeni ilişki eklenince artar.
 */
const MIN_COMPANY_SCOPED_FKS = 45;

type Query = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * Eksikler listesi. Boşsa şema güncel. Katalog okunur, firma verisine bakılmaz. `aiDailyBudget` (varsayılan: tavan `off`
 * değilse): sistemin günlük tavanının okuma ilkesi (`AiUsage.ai_budget_read`, göç 20261123090000) yoksa toplam sessizce 0
 * görünür ve tavan hiç dolmaz; servis açılmaz.
 */
export async function schemaProblems(query: Query, opts: { aiDailyBudget?: boolean } = {}): Promise<string[]> {
  const aiDailyBudget = opts.aiDailyBudget ?? env.aiDailyBudgetTry !== null;
  const problems: string[] = [];
  const indexes = new Set((await query(`SELECT indexname::text AS name FROM pg_indexes WHERE schemaname = 'deciship'`)).map((r) => r.name as string));
  for (const name of REQUIRED_INDEXES) if (!indexes.has(name)) problems.push(`dizin yok: ${name}`);
  if (indexes.has('Measurement_clientId_key')) problems.push('eski dizin duruyor: Measurement_clientId_key');

  const fks = await query(`
    SELECT c.conname::text AS name, c.confrelid::regclass::text AS parent,
      (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'deciship'`);
  const scoped = fks.filter((r) => !/"?Company"?$/.test(r.parent as string));
  for (const r of scoped) if (!(r.cols as string[]).includes('companyId')) problems.push(`tek sütunlu yabancı anahtar: ${r.name as string}`);
  if (scoped.length < MIN_COMPANY_SCOPED_FKS) problems.push(`yabancı anahtar eksik: ${scoped.length}/${MIN_COMPANY_SCOPED_FKS}`);

  // Firmayı kapatma (göç 20261125090000): iş kuyruğu kapalı firmayı iş kapsamında firma satırından sorar; ilke yoksa hiçbir iş alınmaz.
  const jobsCompany = await query(`SELECT 1 AS ok FROM pg_policies WHERE schemaname = 'deciship' AND tablename = 'Company' AND policyname = 'jobs_company_read' AND cmd = 'SELECT'`);
  if (!jobsCompany.length) problems.push('ilke yok: Company.jobs_company_read (iş kuyruğu; göç 20261125090000_company_close uygulanmalı)');

  if (aiDailyBudget) {
    const policy = await query(`SELECT 1 AS ok FROM pg_policies WHERE schemaname = 'deciship' AND tablename = 'AiUsage' AND policyname = 'ai_budget_read' AND cmd = 'SELECT'`);
    if (!policy.length) problems.push('ilke yok: AiUsage.ai_budget_read (AI_DAILY_BUDGET_TRY günlük tavanı; göç 20261123090000_ai_daily_budget_scope uygulanmalı)');
  }
  return problems;
}
