import { ORG_ROLE_LABEL, PRODUCTS, isCustomRoleKey, PRODUCT_KEYS, productRole, type HubAlert, type HubKpi, type HubOverview, type HubTone, type Locale, type MeResponse, type OrgRole, type ProductKey } from './contracts';

/** Sözleşme verisini telefon ekranının okuduğu şekle çevirir. Saf: RN bilmez, test edilir. */

const TONE_RANK: Record<HubTone, number> = { bad: 0, warning: 1, info: 2, neutral: 3, good: 4 };

const alertAmount = (a: HubAlert) => (typeof a.amount?.value === 'number' && Number.isFinite(a.amount.value) ? a.amount.value : null);

/* ───────────── Araç seçici (web Merkez `ToolPicker` ile aynı, Tümü yok): açık araçlar · yakında ───────────── */

/**
 * Seçim: tek araç ya da `null` (henüz seçilmedi). Telefonda araç seçen tek ekran Genel Bakış; Tümü yok (web `Home` gibi).
 * Seçim yoksa ya da izinsizse ilk açık araç gösterilir (`overviewTool`). "Web'de aç" kartı da aynı aracı açar.
 */
export type ToolChoice = ProductKey | null;

export type ToolPickerItem = { key: ProductKey; state: 'pick' | 'soon' };

/** Açık mı: `me` varsa sunucu (`available` ve `launch !== 'off'`); `me` yoksa gömülü katalog (çevrimdışı açılış). */
function isOpen(key: ProductKey, me?: MeResponse | null): boolean {
  if (!me) return PRODUCTS[key].launch === 'public';
  const p = me.products.find((x) => x.key === key);
  return !!p && p.available && p.launch !== 'off';
}

/** Katalog sırasıyla araçlar. Yakında araçlar görünür ama seçilemez; izni olmayan açık araç hiç görünmez. */
export function toolPickerItems(allowed: readonly ProductKey[], me?: MeResponse | null): ToolPickerItem[] {
  if (allowed.length === 0) return [];
  const items: ToolPickerItem[] = [];
  for (const key of PRODUCT_KEYS) {
    if (!isOpen(key, me)) items.push({ key, state: 'soon' });
    else if (allowed.includes(key)) items.push({ key, state: 'pick' });
  }
  return items;
}

/**
 * Genel Bakış'ın gösterdiği araç (web `Home` ile aynı): her zaman tek aracın özeti.
 * Seçim izinliyse o; seçim yoksa, izinsiz ya da bilinmeyen seçimde ilk açık araç. Hiç araç yoksa `null`.
 */
export function overviewTool(choice: ToolChoice, allowed: readonly ProductKey[]): ProductKey | null {
  if (choice !== null && allowed.includes(choice)) return choice;
  return allowed[0] ?? null;
}

/** Bekleyenler: en büyük tutar üstte. Tutarsızlar sonda, önem sırasıyla. */
export function sortAlerts(alerts: readonly HubAlert[]): HubAlert[] {
  return alerts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const ax = alertAmount(x.a);
      const ay = alertAmount(y.a);
      if (ax !== null && ay !== null && ax !== ay) return ay - ax;
      if (ax !== null && ay === null) return -1;
      if (ax === null && ay !== null) return 1;
      return (TONE_RANK[x.a.tone] ?? 9) - (TONE_RANK[y.a.tone] ?? 9) || x.i - y.i;
    })
    .map((x) => x.a);
}

export type SetupState = { state: 'none' } | { state: 'done' } | { state: 'open'; href: string; label: string };

export type OverviewView = {
  lead: HubKpi | null;
  rest: HubKpi[];
  alerts: HubAlert[];
  setup: SetupState;
  /** Baş rakam yok: henüz veri yok. */
  noData: boolean;
};

export function overviewView(o: HubOverview): OverviewView {
  const kpis = o.kpis ?? [];
  const lead = kpis[0] ?? null;
  const setup: SetupState = !o.setup ? { state: 'none' } : o.setup.completed ? { state: 'done' } : { state: 'open', href: o.setup.href, label: o.setup.label };
  return { lead, rest: kpis.slice(1), alerts: sortAlerts(o.alerts ?? []), setup, noData: !lead || lead.value === null || lead.value === undefined };
}

/** Hesap API üye şekli. `contracts` içinde yok; web `api/types.ts` ve `account-api/routes/org.ts` ile aynı. */
export type OrgMember = {
  id: string;
  name: string;
  orgRole: OrgRole;
  status: 'ACTIVE' | 'SUSPENDED';
  lastActiveAt: string | null;
  productRoles?: Partial<Record<ProductKey, string | null>>;
  /** Sunucu rol adlarını da gönderirse (firmada düzenlenmiş ya da özel rol): o gösterilir. Eski sunucuda yok. */
  productRoleLabels?: Partial<Record<ProductKey, string | null>>;
};

/**
 * Rolün gösterilecek adı. Sıra: sunucunun verdiği ad, kişinin kendi rolüyse `me.products[].roleLabel`, katalog adı, son olarak
 * tarafsız metin (`neutral`). Ham anahtar (`custom:...`) hiç gösterilmez.
 */
export function roleLabelOf(product: ProductKey, role: string, locale: Locale, opts: { me?: MeResponse | null; serverLabel?: string | null; neutral?: string } = {}): string {
  if (opts.serverLabel) return opts.serverLabel;
  const mine = opts.me?.products.find((p) => p.key === product);
  if (mine?.role === role && mine.roleLabel) return mine.roleLabel;
  const known = productRole(product, role)?.label[locale];
  if (known) return known;
  // Özel rolün ham anahtarı (`custom:<uuid>`) görünmez; bilinmeyen hazır rol anahtarı eskisi gibi gösterilir.
  return isCustomRoleKey(role) ? (opts.neutral ?? '—') : role;
}

export type TeamRow = {
  id: string;
  name: string;
  orgRole: string;
  suspended: boolean;
  lastActiveAt: string | null;
  tools: { key: ProductKey; name: string; role: string | null }[];
};

const ROLE_RANK: Record<OrgRole, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };

/** Ekip listesi: etkinler üstte, sonra firma rolü, sonra ad. Yalnız açık araçların rolü yazılır. */
export function teamView(members: readonly OrgMember[], lng: string, me?: MeResponse | null, customRoleText?: string): { rows: TeamRow[]; active: number; suspended: number } {
  const locale: Locale = lng === 'en' ? 'en' : 'tr';
  const open = PRODUCT_KEYS.filter((k) => isOpen(k, me));
  const rows = [...members]
    .sort((a, b) => Number(a.status === 'SUSPENDED') - Number(b.status === 'SUSPENDED') || (ROLE_RANK[a.orgRole] ?? 9) - (ROLE_RANK[b.orgRole] ?? 9) || a.name.localeCompare(b.name, lng))
    .map<TeamRow>((m) => ({
      id: m.id,
      name: m.name,
      orgRole: ORG_ROLE_LABEL[m.orgRole]?.[locale] ?? m.orgRole,
      suspended: m.status === 'SUSPENDED',
      lastActiveAt: m.lastActiveAt ?? null,
      tools: open.map((key) => {
        const role = m.productRoles?.[key] ?? null;
        return { key, name: PRODUCTS[key].name, role: role ? roleLabelOf(key, role, locale, { me, serverLabel: m.productRoleLabels?.[key], ...(customRoleText ? { neutral: customRoleText } : {}) }) : null };
      }),
    }));
  const suspended = rows.filter((r) => r.suspended).length;
  return { rows, active: rows.length - suspended, suspended };
}

/** Sunucu dizi ya da `{ members }`/`{ items }` dönebilir; arayüz tek şekil görür. */
export function asMembers(x: unknown): OrgMember[] {
  if (Array.isArray(x)) return x as OrgMember[];
  const o = (x ?? {}) as { members?: unknown; items?: unknown };
  if (Array.isArray(o.members)) return o.members as OrgMember[];
  if (Array.isArray(o.items)) return o.items as OrgMember[];
  return [];
}

/**
 * Önbellekte ve bellekte kişi iletişim bilgisi tutulmaz: ekranda da gerekmiyor.
 * Telefon ve e-posta burada düşer, cihaza yazılmaz.
 */
export const stripContact = (members: readonly OrgMember[]): OrgMember[] =>
  members.map(({ id, name, orgRole, status, lastActiveAt, productRoles, productRoleLabels }) => ({
    id,
    name,
    orgRole,
    status,
    lastActiveAt,
    ...(productRoles ? { productRoles } : {}),
    ...(productRoleLabels ? { productRoleLabels } : {}),
  }));
