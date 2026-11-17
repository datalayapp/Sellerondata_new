import { PRODUCTS, type AuditMemberChange, type HubActivityItem, type HubActivityPage, type Locale, type MeResponse, type ProductKey } from './contracts';
import { roleLabelOf } from './views';

/**
 * Etkinlik (web Merkez `pages/Activity.tsx` ile aynı kaynaklar ve birleştirme). Saf: RN bilmez, test edilir.
 * Kaynaklar: hesap denetim izi (`GET /api/account/org/audit`, yalnız OWNER/ADMIN) + rapor izni olan her aracın
 * akışı (`GET /api/<ürün>/platform/activity`). Telefonda süzgeç yok; süzgeçler web'de.
 */

export type ActivitySource = 'platform' | ProductKey;
export type ActivityItem = HubActivityItem & { source: ActivitySource };

/** Hesap API denetim kaydı (hub-web `api/types.ts` `AuditItem`). Kişi adı ve hedef adı sunucudan gelir. */
export type AuditItem = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  label?: string;
  targetName?: string | null;
  details?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
};
export type AuditPage = { items: AuditItem[]; page: number; pageSize: number; total: number };

/** Web ile aynı sayfa boyu. */
export const AUDIT_PAGE_SIZE = 30;

export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Sonraki sayfa numarası; yoksa `null` (web `getNextPageParam`). */
export function nextPage(last: Pick<HubActivityPage, 'page' | 'pageSize' | 'total'> | undefined): number | null {
  if (!last) return null;
  return last.page * last.pageSize < last.total ? last.page + 1 : null;
}

/**
 * Önbelleğe ve belleğe yalnız ekranın okuduğu alanlar yazılır: `details` içinden yalnız `changes` ve `name`.
 * Destek ayrıntısı gibi başka alanlar cihaza inmez.
 */
export function slimAudit(page: AuditPage): AuditPage {
  return {
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    items: (page.items ?? []).map((it) => {
      const d = it.details ?? it.meta ?? null;
      const changes = Array.isArray(d?.changes) ? d.changes : undefined;
      const name = typeof d?.name === 'string' ? d.name : undefined;
      const details = changes || name ? { ...(changes ? { changes } : {}), ...(name ? { name } : {}) } : null;
      return { id: it.id, at: it.at, actor: it.actor ?? null, action: it.action, target: it.target ?? null, ...(it.label ? { label: it.label } : {}), targetName: it.targetName ?? null, details };
    }),
  };
}

/** "Üyeliği değiştirdi" neyin değiştiğini söyler: `details.changes` (web `memberChange`). */
function memberChange(item: AuditItem, t: Translate, locale: Locale, orgRole: (role: string) => string, me?: MeResponse | null): string | null {
  const changes = (item.details ?? item.meta)?.changes as AuditMemberChange[] | undefined;
  if (!Array.isArray(changes) || !changes.length) return null;
  return changes
    .map((c) => {
      if (c.field === 'status') return t(c.to === 'SUSPENDED' ? 'activity.member.suspended' : 'activity.member.resumed');
      if (c.field === 'orgRole') return t('activity.member.orgRole', { role: orgRole(c.to) });
      const k = c.product as ProductKey;
      const tool = PRODUCTS[k]?.name ?? c.product;
      return c.to ? t('activity.member.toolRole', { tool, role: roleLabelOf(k, c.to, locale, { me, serverLabel: c.toLabel, neutral: t('customRole') }) }) : t('activity.member.noAccess', { tool });
    })
    .join(', ');
}

/** Hesap denetim izi kod taşır; eylem metni çeviriden, bilinmeyen eylem sunucunun etiketinden (web `readAudit`). */
export function readAudit(item: AuditItem, t: Translate, locale: Locale, orgRole: (role: string) => string, me?: MeResponse | null): HubActivityItem {
  const metaName = item.targetName ?? (typeof item.details?.name === 'string' ? item.details.name : typeof item.meta?.name === 'string' ? item.meta.name : undefined);
  const action =
    item.action === 'member.updated'
      ? (memberChange(item, t, locale, orgRole, me) ?? t('activity.actions.member.updated'))
      : t(`activity.actions.${item.action}`, { defaultValue: item.label ?? t('activity.actions.unknown') });
  return { id: item.id, at: item.at, actor: item.actor, action, ...(metaName ? { target: metaName } : {}) };
}

export type LoadedFeed = { source: ActivitySource; pages: readonly HubActivityPage[] };

/**
 * Akışlar tek zaman çizelgesinde, yeniden eskiye. Daha fazla kaydı olan akışın son yüklenen kaydından eskiler gösterilmez:
 * öteki akışın daha eski kayıtları araya girip sırayı yanıltmasın (web ile aynı kural). "Daha fazla" aralığı genişletir.
 */
export function mergeFeeds(feeds: readonly LoadedFeed[]): ActivityItem[] {
  const merged: ActivityItem[] = feeds.flatMap((f) => f.pages.flatMap((p) => (p.items ?? []).map((it) => ({ ...it, source: f.source }))));
  merged.sort((a, b) => b.at.localeCompare(a.at));
  const horizon = feeds
    .filter((f) => nextPage(f.pages.at(-1)) !== null)
    .map((f) => f.pages.at(-1)?.items.at(-1)?.at)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  return horizon ? merged.filter((m) => m.at >= horizon) : merged;
}

export type DayGroup = { day: string; items: ActivityItem[] };

/** Ardışık aynı günler tek grupta. Gün anahtarını çağıran verir (firma saat dilimi: `lib/format` `dayKey`). */
export function groupByDay(items: readonly ActivityItem[], dayOf: (iso: string) => string): DayGroup[] {
  const out: DayGroup[] = [];
  for (const it of items) {
    const day = dayOf(it.at);
    const last = out.at(-1);
    if (last?.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}
