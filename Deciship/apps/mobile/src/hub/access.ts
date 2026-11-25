import { PRODUCTS, type MeResponse, type ProductKey } from './contracts';

/** Görünürlük tek yerde. Kod rol adına bakmaz; `orgRole` ve `me.products[].permissions`a bakar (ARCHITECTURE §8). */
type MeProduct = MeResponse['products'][number];

function activeMembershipOk(me: MeResponse): boolean {
  const org = me.activeOrg;
  if (!org) return false;
  return me.orgs.find((o) => o.id === org.id)?.status !== 'SUSPENDED';
}

const usable = (p: MeProduct) => p.available && !!p.subscription;
const canAnalytics = (p: MeProduct) => {
  const perm = PRODUCTS[p.key]?.hub?.analytics;
  return !!perm && p.permissions.includes(perm);
};

export function isOrgAdmin(me: MeResponse): boolean {
  if (!activeMembershipOk(me)) return false;
  const role = me.activeOrg?.orgRole;
  return role === 'OWNER' || role === 'ADMIN';
}

/** Merkez sekmesi: OWNER/ADMIN veya bir üründe rapor izni. Yalnız Ölçüm rolündeki kişi görmez. */
export function canSeeHub(me: MeResponse): boolean {
  if (!activeMembershipOk(me)) return false;
  return isOrgAdmin(me) || me.products.some((p) => usable(p) && canAnalytics(p));
}

/** Genel Bakış'ta bölümü olan araçlar. Sunucu yine izne göre süzer; 403 alan bölüm gizlenir (§7). */
export function overviewTools(me: MeResponse): ProductKey[] {
  return me.products.filter((p) => usable(p) && (canAnalytics(p) || p.permissions.includes(`${p.key}.web.access`))).map((p) => p.key);
}

export function analyticsTools(me: MeResponse): ProductKey[] {
  return me.products.filter((p) => usable(p) && canAnalytics(p)).map((p) => p.key);
}

/** Ölçüm ekranları için: kaydı uygulamada açabilir mi, yoksa web'e mi gitmeli. */
export function canOpenMeasurements(me: MeResponse): boolean {
  const p = me.products.find((x) => x.key === 'deciship');
  return !!p && usable(p) && (p.permissions.includes('deciship.measurements.view_all') || p.permissions.includes('deciship.measurements.capture'));
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Önbelleğin sahibi: kişi + firma + yetkiler. Biri değişirse kayıtlı veri silinir. */
export function hubScope(me: MeResponse): string {
  const rights = me.products
    .map((p) => [p.key, p.role, p.subscription?.status ?? null, [...p.permissions].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return `${me.person.id}|${me.activeOrg?.id ?? '-'}|${hash(JSON.stringify([me.activeOrg?.orgRole ?? null, rights]))}`;
}
