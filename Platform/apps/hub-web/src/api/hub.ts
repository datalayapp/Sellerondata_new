import { HUB_AI_CALLS_PAGE_SIZE, type HubActivityPage, type HubAiCallPage, type HubAiUsage, type HubAnalytics, type HubDatasetList, type HubDatasetPage, type HubOverview, type ProductKey } from '@sellerondata/contracts';
import { client } from '../lib/session.ts';

/** Ürünlerin Merkez uçları (§7). Aynı kökenden, jeton çerezde. Ürün izne göre süzer. */
const base = (product: ProductKey) => `/api/${product}/platform`;

export type Filters = Record<string, string | string[]>;

function query(params: Record<string, string | number | boolean | undefined | null>, filters?: Filters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v));
  }
  for (const [k, v] of Object.entries(filters ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) if (item) q.append(`filter.${k}`, item);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const fetchOverview = (p: ProductKey, from: string, to: string) => client.get<HubOverview>(`${base(p)}/overview${query({ from, to })}`);

export const fetchAnalytics = (p: ProductKey, from: string, to: string, compare: boolean, filters: Filters) =>
  client.get<HubAnalytics>(`${base(p)}/analytics${query({ from, to, compare: compare ? 'previous' : undefined }, filters)}`);

export const fetchDatasets = (p: ProductKey) => client.get<HubDatasetList>(`${base(p)}/datasets`);

export type DatasetQuery = { page: number; pageSize: number; q?: string; sort?: string; dir?: 'asc' | 'desc'; filters: Filters };

const datasetQuery = (q: Omit<DatasetQuery, 'page' | 'pageSize'> & { page?: number; pageSize?: number }) =>
  query({ page: q.page, pageSize: q.pageSize, q: q.q, sort: q.sort, dir: q.dir }, q.filters);

export const fetchDataset = (p: ProductKey, id: string, q: DatasetQuery) => client.get<HubDatasetPage>(`${base(p)}/datasets/${encodeURIComponent(id)}${datasetQuery(q)}`);

export const exportDataset = (p: ProductKey, id: string, q: Omit<DatasetQuery, 'page' | 'pageSize'>) =>
  client.download(`${base(p)}/datasets/${encodeURIComponent(id)}/export${datasetQuery(q)}`, `${p}-${id}.csv`);

export const fetchActivity = (p: ProductKey, page: number) => client.get<HubActivityPage>(`${base(p)}/activity${query({ page })}`);

/** Yapay zekâ kullanımı ve kalan hak (Mesaj 6); `period` ('YYYY-MM') verilmezse bu ay. 403/404: o üründe yetki ya da uç yok. */
export const fetchAiUsage = (p: ProductKey, period?: string) => client.get<HubAiUsage>(`${base(p)}/ai-usage${query({ period })}`);

/** Ayrıntılı dökümün süzgeçleri: dönem, tür, kişi (`HUB_AI_MEMBER_NONE`: kişisi silinmiş satırlar). */
export type AiCallsFilter = { period?: string; kind?: string; member?: string };

export const fetchAiCalls = (p: ProductKey, f: AiCallsFilter, page: number, pageSize = HUB_AI_CALLS_PAGE_SIZE) =>
  client.get<HubAiCallPage>(`${base(p)}/ai-usage/calls${query({ ...f, page, pageSize })}`);

/** Excel (ayar + dışa aktarma izni). Dosya adı sunucudan (isteğin dilinde); gelmezse yedek ad. */
export const exportAiCalls = (p: ProductKey, f: AiCallsFilter) => client.download(`${base(p)}/ai-usage/calls/export${query(f)}`, `${p}-ai-usage-${f.period ?? 'current'}.xlsx`);
