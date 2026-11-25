import {
  AI_SPEND_CALLS_PAGE_SIZE,
  AI_SPEND_PATHS,
  STEP_UP_HEADER,
  type AiAdminKey,
  type AiAdminKeysResponse,
  type AiAdminLimits,
  type AiAdminLimitsPatch,
  type AiAdminStatus,
  type AiOrgAllowanceView,
  type AiProvider,
  type AiSpendCallsPage,
  type AiSpendScope,
  type AiSpendSummary,
  type OperatorStepUpResponse,
} from '@sellerondata/contracts';
import { client } from '../lib/session.ts';
import type { Filters } from './hub.ts';

/*
 * Yapay zekâ geçidinin Merkez uçları (sözleşme `contracts/src/aiSpend.ts`, gateway `/api/ai/`). Firma görünümü etkin firmanın
 * sahibi ya da yöneticisi içindir; `scope=platform` ve `/admin/*` yalnız platform yöneticisi. Değiştiren yönetici uçları adım
 * artırma jetonunu (`STEP_UP_HEADER`) ister; jeton `requestStepUp` ile alınır, 5 dk geçerlidir.
 */

/** Ekrandaki süzgeç kimlikleri (`HubFilterDef.id`) uçtaki sorgu adlarıyla aynıdır; adreste `filter.<id>` (Analiz gibi) durur. */
const FILTER_PARAMS = ['product', 'purpose', 'model', 'status', 'member', 'org'] as const;

export type AiSpendParams = { scope: AiSpendScope; from: string; to: string; filters: Filters; currency?: 'TRY' | 'USD' };

function spendQuery(p: AiSpendParams, extra: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams();
  if (p.scope === 'platform') q.set('scope', 'platform');
  q.set('from', p.from);
  q.set('to', p.to);
  if (p.scope === 'platform' && p.currency) q.set('currency', p.currency);
  for (const k of FILTER_PARAMS) {
    const v = p.filters[k];
    const one = Array.isArray(v) ? v[0] : v;
    if (one) q.set(k, one);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') q.set(k, String(v));
  return `?${q}`;
}

export const fetchAiSpendSummary = (p: AiSpendParams) => client.get<AiSpendSummary>(`${AI_SPEND_PATHS.summary}${spendQuery(p)}`);

export const fetchAiSpendCalls = (p: AiSpendParams, page: number, pageSize = AI_SPEND_CALLS_PAGE_SIZE) =>
  client.get<AiSpendCallsPage>(`${AI_SPEND_PATHS.calls}${spendQuery(p, { page, pageSize })}`);

/** CSV ya da Excel; dosya adı sunucudan (isteğin dilinde), gelmezse yedek ad. */
export const exportAiSpendCalls = (p: AiSpendParams, format: 'csv' | 'xlsx') =>
  client.download(`${AI_SPEND_PATHS.export}${spendQuery(p, { format })}`, `ai-spend-${p.from}-${p.to}.${format}`);

/** Firmanın tek ortak aylık hakkı (bu ay). */
export const fetchAiAllowance = () => client.get<AiOrgAllowanceView>(AI_SPEND_PATHS.allowance);

// ---------- Platform yöneticisi ----------

/** Adım artırma: şifre yeniden sorulur, 5 dakikalık tek amaçlı jeton döner. Yanlış şifre `401 INVALID_CREDENTIALS`. */
export const requestStepUp = (password: string) => client.post<OperatorStepUpResponse>('/api/account/operator/step-up', { password });

const stepUpHeaders = (token: string | null | undefined): HeadersInit | undefined => (token ? { [STEP_UP_HEADER]: token } : undefined);

export const fetchAdminKeys = () => client.get<AiAdminKeysResponse>(AI_SPEND_PATHS.adminKeys);

export const setAdminKey = (provider: AiProvider, key: string, stepUp: string) =>
  client.request<AiAdminKey>(`${AI_SPEND_PATHS.adminKeys}/${provider}`, { method: 'PUT', body: { key }, headers: stepUpHeaders(stepUp) });

export const removeAdminKey = (provider: AiProvider, stepUp: string) =>
  client.request<AiAdminKey>(`${AI_SPEND_PATHS.adminKeys}/${provider}`, { method: 'DELETE', headers: stepUpHeaders(stepUp) });

/** Ücretsiz sınama (adım artırma istemez). */
export const testAdminKey = (provider: AiProvider) => client.post<AiAdminKey>(`${AI_SPEND_PATHS.adminKeys}/${provider}/test`);

export const fetchAdminLimits = () => client.get<AiAdminLimits>(AI_SPEND_PATHS.adminLimits);

/** Yalnız `{ paused: true }` (acil durdurma) adım artırmasızdır; geri açma ve tavanlar jeton ister. */
export const patchAdminLimits = (body: AiAdminLimitsPatch, stepUp: string | null) =>
  client.request<AiAdminLimits>(AI_SPEND_PATHS.adminLimits, { method: 'PATCH', body, headers: stepUpHeaders(stepUp) });

/** Firma başına aylık hak (USD); null varsayılana döner. */
export const putOrgCap = (orgId: string, capUsd: number | null, stepUp: string) =>
  client.request<AiAdminLimits>(`${AI_SPEND_PATHS.adminLimits}/orgs/${encodeURIComponent(orgId)}`, {
    method: 'PUT',
    body: { capUsd },
    headers: stepUpHeaders(stepUp),
  });

export const fetchAdminStatus = () => client.get<AiAdminStatus>(AI_SPEND_PATHS.adminStatus);
