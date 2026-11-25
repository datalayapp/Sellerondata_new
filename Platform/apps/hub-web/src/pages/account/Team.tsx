import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { JOIN_CODE_MAX_ATTEMPTS, PRODUCTS, pickInviteRole, type OrgRole, type ProductKey } from '@sellerondata/contracts';
import {
  ActionMenu,
  ApiError,
  Button,
  Empty,
  ErrorState,
  Field,
  Icon,
  Modal,
  ModalAction,
  Notice,
  PageHeader,
  ProductMark,
  Skel,
  SlideOver,
  Tag,
  currentLocale,
  formatDate,
  formatPhone,
  formatRelative,
  toast,
  useMe,
} from '@sellerondata/shell';
import { asList, type InviteBody, type InviteResult, type OrgInvitation, type OrgMember, type ProductRoles, type ResetCodeResult } from '../../api/types.ts';
import { apiMessage, copyText, useIsPhone, useScope } from '../../lib/hooks.ts';
import { teamProducts } from '../../lib/access.ts';
import { client } from '../../lib/session.ts';
import { useOrgRoles, useProductRoles, useRoleViewer } from '../../lib/orgRoles.ts';
import { findRole, isUpgrade, ownerOnlyIn, roleName, type RolesProduct } from '../../lib/roles.ts';
import { RoleDrawer, RolesTab, type RoleDrawerStart } from './TeamRoles.tsx';

/** Ekip ekranındaki araçlar: `me`'den (bu firmada açık ve abonelikli). */
function useTeamProducts(): ProductKey[] {
  const { me } = useMe();
  return useMemo(() => teamProducts(me), [me]);
}
const NO_ROLE = '';
/** Süzgeçte "Erişim yok": rol kimliğiyle çakışmaz. */
const NO_ROLE_FILTER = '__none';
const UNDO_MS = 10_000;

type CodeInfo = { code: string; name: string; purpose: 'join' | 'reset' };

/** Hata kodunu metne çevirir. Sunucu kuralı söylüyor, arayüz yalnız yerini gösteriyor. */
function teamError(e: unknown, fallback: string, t?: (k: string) => string) {
  if (t && e instanceof ApiError && e.code === 'RESET_CODE_NOT_ALLOWED') {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (reason) return t(`team.resetReason.${reason}`);
  }
  return apiMessage(e, fallback);
}

type LinkInfo = { link: string; name: string; mailSent?: boolean };

/** Davet sınırı: firmanın saatlik hakkı doldu. Form silinmez, kişi ne zaman deneyeceğini okur. */
function inviteError(e: unknown, t: TFunction): string {
  if (e instanceof ApiError && e.code === 'TOO_MANY_ATTEMPTS') {
    const minutes = e.retryAfterSeconds ? Math.max(1, Math.ceil(e.retryAfterSeconds / 60)) : null;
    return minutes ? t('team.inviteLimitIn', { minutes }) : t('team.inviteLimit');
  }
  return teamError(e, t('common.unexpected'));
}

const ORG_ROLES: OrgRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

const TEAM_TABS = ['people', 'invites', 'roles'] as const;
type TeamTab = (typeof TEAM_TABS)[number];

/** Firma rolünün adı. Araçtaki "Yönetici" ile karışmasın diye "Firma yöneticisi". */
function orgRoleLabel(role: OrgRole, t: TFunction): string {
  return t(`team.orgRoles.${role}`);
}

const folded = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase('tr');

type PeopleFilter = { q: string; orgRole: string; toolRole: string; status: string };
const NO_FILTER: PeopleFilter = { q: '', orgRole: '', toolRole: '', status: '' };

/** Araç rolü süzgeci: tek araçta değer rolün kendisi, birden çok araçta `<araç>:<rol>`. */
function matchesPeople(m: OrgMember, f: PeopleFilter, tools: readonly ProductKey[]): boolean {
  const q = folded(f.q.trim());
  if (q && !folded(m.name).includes(q) && !folded(m.email).includes(q) && !(m.phone ?? '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000')) return false;
  if (f.orgRole && m.orgRole !== f.orgRole) return false;
  if (f.status && m.status !== f.status) return false;
  if (f.toolRole) {
    const single = tools.length <= 1;
    // Özel rol anahtarı da iki nokta taşır (`custom:<uuid>`): araç anahtarı yalnız ilk iki noktaya kadardır.
    const cut = f.toolRole.indexOf(':');
    const [key, want] = single ? [tools[0], f.toolRole] : ([f.toolRole.slice(0, cut), f.toolRole.slice(cut + 1)] as [ProductKey, string]);
    if (key && (m.productRoles[key] ?? NO_ROLE_FILTER) !== want) return false;
  }
  return true;
}

export function Team() {
  const { t } = useTranslation();
  const { me } = useMe();
  const scope = useScope();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TeamTab = asked === 'invites' || asked === 'roles' ? asked : 'people';
  const setTab = (next: TeamTab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === 'people') out.delete('tab');
        else out.set('tab', next);
        return out;
      },
      { replace: true },
    );
  // Sekmeler tek durak (roving tabIndex): Tab sekme grubuna girer, oklar sekmeler arasında gezer, Home ve End uçlara gider. Odak gelen sekme açılır.
  const TABS = TEAM_TABS;
  const onTabKey = (e: KeyboardEvent) => {
    // Başlangıç odaklı sekmedir: adres (ve `tab`) bir önceki tuşla henüz güncellenmemiş olabilir; hızlı basışta ok yanlış yöne gitmesin.
    const focused = TABS.findIndex((k) => (e.target as HTMLElement).id === `team-tab-${k}`);
    const at = focused >= 0 ? focused : TABS.indexOf(tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % TABS.length : e.key === 'ArrowLeft' ? (at - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to]!);
    document.getElementById(`team-tab-${TABS[to]}`)?.focus();
  };
  const [inviteOpen, setInviteOpen] = useState(false);
  const [code, setCode] = useState<CodeInfo | null>(null);
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [reinvite, setReinvite] = useState<OrgInvitation | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const [filter, setFilter] = useState<PeopleFilter>(NO_FILTER);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [guide, setGuide] = useState(false);
  const [drawer, setDrawer] = useState<RoleDrawerStart | null>(null);

  // Kişi başka cihazdan katılır: ekrana dönünce liste güncel olsun (30 sn tazelik burada beklenmez).
  const members = useQuery({ queryKey: [...scope, 'members'], queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')), refetchOnWindowFocus: 'always' });
  const invitations = useQuery({ queryKey: [...scope, 'invitations'], queryFn: async () => asList<OrgInvitation>(await client.get('/api/account/org/invitations')), refetchOnWindowFocus: 'always' });

  const active = members.data?.filter((m) => m.status === 'ACTIVE').length ?? 0;
  const pending = invitations.data?.length ?? 0;
  const tools = useTeamProducts();
  const list = useMemo(() => (members.data ?? []).filter((m) => matchesPeople(m, filter, tools)), [members.data, filter, tools]);
  const roles = useOrgRoles(scope);
  const roleCount = roles.data ? roles.data.products.filter((p) => tools.includes(p.key)).reduce((n, p) => n + p.roles.length, 0) : null;
  // "Bu roldekileri gör": Kişiler sekmesi o rolle süzülür, süzgeç satırı açık.
  const showPeople = (k: ProductKey, key: string) => {
    setFilter({ ...NO_FILTER, toolRole: tools.length <= 1 ? key : `${k}:${key}` });
    setFiltersOpen(true);
    setTab('people');
  };

  return (
    <div className="hub-page d9">
      <PageHeader
        title={t('team.title')}
        sub={members.data ? t('team.sub', { people: active, invites: pending }) : t('team.subLoading')}
        actions={
          <>
            <Button kind="ghost" onClick={() => setGuide(true)}>
              {t('team.guide')}
            </Button>
            <Button icon="plus" onClick={() => setInviteOpen(true)}>
              {t('team.invite')}
            </Button>
          </>
        }
      />
      <div className="d9-wrap d9-team">
        <div className="d9-bar">
          <div className="d9-tabs" role="tablist" aria-label={t('team.tabs')} onKeyDown={onTabKey}>
            <button type="button" role="tab" id="team-tab-people" aria-controls="team-panel" aria-selected={tab === 'people'} tabIndex={tab === 'people' ? 0 : -1} onClick={() => setTab('people')}>
              {t('team.tabPeople')} <span className="d9-cnt">{members.data?.length ?? '–'}</span>
            </button>
            <button type="button" role="tab" id="team-tab-invites" aria-controls="team-panel" aria-selected={tab === 'invites'} tabIndex={tab === 'invites' ? 0 : -1} onClick={() => setTab('invites')}>
              {t('team.tabInvites')} <span className="d9-cnt">{invitations.data ? pending : '–'}</span>
            </button>
            <button type="button" role="tab" id="team-tab-roles" aria-controls="team-panel" aria-selected={tab === 'roles'} tabIndex={tab === 'roles' ? 0 : -1} onClick={() => setTab('roles')}>
              {t('roles.tab')} <span className="d9-cnt">{roleCount ?? '–'}</span>
            </button>
          </div>
          {tab === 'people' && <PeopleSearch value={filter} onChange={setFilter} filtersOpen={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} />}
          {tab === 'roles' && tools.length > 0 && (
            <Button kind="secondary" small icon="plus" disabled={!roles.data} onClick={() => setDrawer({ mode: 'new' })}>
              {t('roles.newRole')}
            </Button>
          )}
        </div>
        {tab === 'people' && filtersOpen && <PeopleFilters value={filter} onChange={setFilter} shown={list.length} total={members.data?.length ?? 0} />}
        <div id="team-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`}>
          {tab === 'roles' ? (
            <RolesTab tools={tools} onOpen={setDrawer} onShowPeople={showPeople} />
          ) : tab === 'invites' ? (
            <PendingInvites
              query={invitations}
              onCode={setCode}
              onLink={setLink}
              onReinvite={(i) => {
                setReinvite(i);
                setInviteOpen(true);
              }}
            />
          ) : members.isError && !members.data ? (
            <ErrorState error={members.error} onRetry={() => members.refetch()} />
          ) : (
            <>
              <section className="d9-matrix-wrap" aria-label={t('team.matrix')}>
                {members.isPending ? (
                  <div className="d9-skel" aria-busy="true">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Skel key={i} h={36} />
                    ))}
                  </div>
                ) : list.length === 0 ? (
                  <Empty
                    compact
                    icon="search"
                    title={t('team.noMatchTitle')}
                    actions={
                      <Button kind="secondary" small onClick={() => setFilter(NO_FILTER)}>
                        {t('filter.clearAll')}
                      </Button>
                    }
                  >
                    {t('team.noMatchBody')}
                  </Empty>
                ) : (
                  <MemberList members={list} onCode={setCode} onRemove={setRemoving} />
                )}
              </section>
              {members.data && <p className="d9-total d9-help">{t('team.total', { count: members.data.length })}</p>}
              <AppShare />
            </>
          )}
        </div>
      </div>

      {inviteOpen && (
        <InvitePanel
          viewerRole={me!.activeOrg!.orgRole}
          initial={reinvite}
          onClose={() => {
            setInviteOpen(false);
            setReinvite(null);
          }}
          onCode={(c) => {
            setInviteOpen(false);
            setReinvite(null);
            setTab('invites');
            setCode(c);
          }}
          onLink={(l) => {
            setInviteOpen(false);
            setReinvite(null);
            setTab('invites');
            setLink(l);
          }}
        />
      )}
      {code && <CodeDialog {...code} onClose={() => setCode(null)} />}
      {link && <LinkDialog {...link} onClose={() => setLink(null)} />}
      {removing && <RemoveDialog member={removing} onClose={() => setRemoving(null)} />}
      {guide && <RoleGuide onClose={() => setGuide(false)} />}
      {drawer && <RoleDrawer start={drawer} tools={tools} onClose={() => setDrawer(null)} />}
    </div>
  );
}

/** Ölçüm Android uygulamasıyla yapılır, uygulama mağazada değil: dağıtım yöneticide. Bağlantı kurulumda tanımlanır (docs/KURULUM.md). */
function AppShare() {
  const { t } = useTranslation();
  const url = (import.meta.env.VITE_ANDROID_APK_URL as string | undefined)?.trim();
  return (
    <section className="d9-app" aria-labelledby="hub-app-share">
      <div className="d9-app-text">
        <h2 id="hub-app-share">{t('team.appShareTitle')}</h2>
        <p>{t('team.appShareBody')}</p>
        {!url && <p className="d9-help">{t('team.appShareNoLink')}</p>}
      </div>
      {url && (
        <div className="d9-app-acts">
          <a className="btn btn-secondary btn-sm" href={url}>
            <Icon name="download" /> {t('team.appShareDownload')}
          </a>
          <Button
            kind="secondary"
            small
            icon="copy"
            onClick={async () => {
              if (await copyText(url)) toast.ok(t('team.linkCopied'));
              else toast.err(t('team.copyFailed'));
            }}
          >
            {t('team.copyLink')}
          </Button>
        </div>
      )}
    </section>
  );
}

function PeopleSearch({ value, onChange, filtersOpen, onToggle }: { value: PeopleFilter; onChange: (f: PeopleFilter) => void; filtersOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const count = [value.orgRole, value.toolRole, value.status].filter(Boolean).length;
  return (
    <div className="d9-find">
      <Field label={t('team.search')} htmlFor="team-q" className="d9-search">
        <div className="search">
          <Icon name="search" />
          <input id="team-q" className="inp sm" type="search" value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} placeholder={t('team.searchHint')} />
        </div>
      </Field>
      <button type="button" className="d9-filter-btn" aria-expanded={filtersOpen} aria-controls="team-filters" onClick={onToggle}>
        <Icon name="filter" size={16} />
        {t('d9.team.filters')}
        {count > 0 && <span className="d9-cnt on">{count}</span>}
      </button>
    </div>
  );
}

function PeopleFilters({ value, onChange, shown, total }: { value: PeopleFilter; onChange: (f: PeopleFilter) => void; shown: number; total: number }) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const rolesOf = useProductRoles(useScope());
  const set = (patch: Partial<PeopleFilter>) => onChange({ ...value, ...patch });
  const active = value.q || value.orgRole || value.toolRole || value.status;
  return (
    <div className="d9-filters" id="team-filters">
      <Field label={t('team.orgRole')} htmlFor="team-f-org">
        <select id="team-f-org" className="sel sm" value={value.orgRole} onChange={(e) => set({ orgRole: e.target.value })}>
          <option value="">{t('filter.all')}</option>
          {ORG_ROLES.map((r) => (
            <option key={r} value={r}>
              {orgRoleLabel(r, t)}
            </option>
          ))}
        </select>
      </Field>
      {AVAILABLE.length > 0 && (
        <Field label={AVAILABLE.length === 1 ? t('team.toolRoleOf', { tool: PRODUCTS[AVAILABLE[0]!].name }) : t('team.toolRolePlain')} htmlFor="team-f-tool">
          <select id="team-f-tool" className="sel sm" value={value.toolRole} onChange={(e) => set({ toolRole: e.target.value })}>
            <option value="">{t('filter.all')}</option>
            {AVAILABLE.length === 1 ? (
              <>
                {rolesOf(AVAILABLE[0]!).roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
                <option value={NO_ROLE_FILTER}>{t('team.noAccess')}</option>
              </>
            ) : (
              AVAILABLE.map((k) => (
                <optgroup key={k} label={PRODUCTS[k].name}>
                  {rolesOf(k).roles.map((r) => (
                    <option key={r.key} value={`${k}:${r.key}`}>
                      {r.name}
                    </option>
                  ))}
                  <option value={`${k}:${NO_ROLE_FILTER}`}>{t('team.noAccess')}</option>
                </optgroup>
              ))
            )}
          </select>
        </Field>
      )}
      <Field label={t('team.status')} htmlFor="team-f-status">
        <select id="team-f-status" className="sel sm" value={value.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">{t('filter.all')}</option>
          <option value="ACTIVE">{t('team.statusActive')}</option>
          <option value="SUSPENDED">{t('team.suspended')}</option>
        </select>
      </Field>
      <div className="d9-filters-end">
        {active ? (
          <button type="button" className="btn btn-ghost plain btn-sm" onClick={() => onChange(NO_FILTER)}>
            <Icon name="close" /> {t('filter.clear')}
          </button>
        ) : null}
        <span className="d9-help" aria-live="polite">
          {active ? t('team.shownOf', { shown, total }) : ''}
        </span>
      </div>
    </div>
  );
}

/** Masaüstünde tablo (yapışkan başlık, düz metin hücre), telefonda kişi kartı. */
function MemberList({ members, onCode, onRemove }: { members: OrgMember[]; onCode: (c: CodeInfo) => void; onRemove: (m: OrgMember) => void }) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const phone = useIsPhone();
  const locale = currentLocale();
  if (phone) {
    return (
      <ul className="d9-cards">
        {members.map((m) => (
          <MemberCard key={m.id} member={m} locale={locale} onCode={onCode} onRemove={onRemove} />
        ))}
      </ul>
    );
  }
  return (
    <table className="d9-tbl d9-matrix">
      <thead>
        <tr>
          <th scope="col">{t('team.person')}</th>
          <th scope="col">{t('team.orgRole')}</th>
          {AVAILABLE.map((k) => (
            <th key={k} scope="col">
              <span className="d9-th-tool">
                <ProductMark product={k} size={18} />
                {PRODUCTS[k].name}
              </span>
            </th>
          ))}
          <th scope="col">{t('team.lastSeen')}</th>
          <th scope="col" className="d9-td-act">
            <span className="sr-only">{t('table.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <MemberRow key={m.id} member={m} locale={locale} onCode={onCode} onRemove={onRemove} />
        ))}
      </tbody>
    </table>
  );
}

type RoleChange = {
  body: { orgRole?: OrgRole; productRoles?: ProductRoles; status?: 'ACTIVE' | 'SUSPENDED' };
  undo: RoleChange['body'];
  done: string;
  confirm?: { title: string; body: string; action: string; danger?: boolean };
};

/** Bir kişinin satırı ve kartı aynı kuralları kullanır: kilitler, onay, geri alma. */
function useMemberControls(m: OrgMember, onCode: (c: CodeInfo) => void, onRemove: (m: OrgMember) => void) {
  const { t } = useTranslation();
  const { me } = useMe();
  const scope = useScope();
  const qc = useQueryClient();
  const locale = currentLocale();
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<RoleChange | null>(null);
  const rolesOf = useProductRoles(scope);
  const viewer = me!.activeOrg!;
  const isSelf = m.id === viewer.membershipId;
  const isOwner = m.orgRole === 'OWNER';
  const viewerIsOwner = viewer.orgRole === 'OWNER';
  const lockedOwner = isOwner && !viewerIsOwner;
  // Sunucu kuralı: ADMIN başka ADMIN'e dokunamaz. Sahip kendi araç rolünü değiştirebilir, üyeliğini değil.
  const lockedAdmin = !viewerIsOwner && m.orgRole === 'ADMIN';
  const manageLocked = isSelf || lockedOwner || lockedAdmin;
  const roleLocked = (isSelf && !viewerIsOwner) || lockedOwner || lockedAdmin;
  const lockReason = isSelf ? t('team.lockSelf') : lockedOwner ? t('team.lockOwner') : lockedAdmin ? t('team.lockAdmin') : undefined;
  const key = [...scope, 'members'];

  const patch = useMutation({
    mutationFn: (change: RoleChange) => client.patch<OrgMember>(`/api/account/org/members/${m.id}`, change.body),
    onMutate: async (change) => {
      setError(null);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<OrgMember[]>(key);
      const body = change.body;
      qc.setQueryData<OrgMember[]>(key, (list) =>
        list?.map((x) => (x.id === m.id ? { ...x, ...('orgRole' in body ? { orgRole: body.orgRole! } : {}), ...('status' in body ? { status: body.status! } : {}), productRoles: { ...x.productRoles, ...body.productRoles } } : x)),
      );
      return { prev };
    },
    onError: (e, _c, ctx) => {
      if (ctx) qc.setQueryData(key, ctx.prev);
      setError(teamError(e, t('common.unexpected')));
    },
    onSuccess: (_r, change) => {
      // Yetki hemen geçerli: kişi yanlış seçimi hemen geri alabilsin.
      toast.ok(change.done, t('team.effectiveNow'), {
        duration: UNDO_MS,
        action: {
          label: t('team.undo'),
          onClick: () => {
            void client
              .patch(`/api/account/org/members/${m.id}`, change.undo)
              .then(() => toast.info(t('team.undone', { name: m.name })))
              .catch((e) => toast.err(t('team.undoFailed'), teamError(e, t('common.unexpected'))))
              .finally(() => qc.invalidateQueries({ queryKey: key }));
          },
        },
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  const resetCode = useMutation({
    mutationFn: () => client.post<ResetCodeResult>(`/api/account/org/members/${m.id}/reset-code`),
    onSuccess: (r) => onCode({ code: r.code, name: m.name, purpose: 'reset' }),
    onError: (e) => setError(teamError(e, t('common.unexpected'), t)),
  });

  const request = (change: RoleChange) => {
    if (change.confirm) setAsk(change);
    else patch.mutate(change);
  };

  const changeOrgRole = (role: OrgRole) => {
    const label = orgRoleLabel(role, t);
    request({
      body: { orgRole: role },
      undo: { orgRole: m.orgRole },
      done: t('team.doneOrgRole', { name: m.name, role: label }),
      confirm: role === 'ADMIN' ? { title: t('team.confirmAdminTitle', { name: m.name }), body: t('team.confirmAdminBody', { name: m.name }), action: t('team.confirmAdminAction') } : undefined,
    });
  };

  const changeToolRole = (k: ProductKey, value: string) => {
    const tool = PRODUCTS[k].name;
    const rp = rolesOf(k);
    const role = value ? (roleName(rp, value, locale) ?? value) : t('team.noAccess');
    const up = isUpgrade(rp, m.productRoles[k], value);
    const confirm = isSelf
      ? value
        ? { title: t('team.confirmSelfTitle', { tool, role }), body: t(up ? 'team.confirmSelfUpBody' : 'team.confirmSelfBody', { tool }), action: t('team.confirmSelfAction'), danger: !up }
        : { title: t('team.confirmSelfNoAccessTitle', { tool }), body: t('team.confirmSelfNoAccessBody', { tool }), action: t('team.confirmNoAccessAction'), danger: true }
      : !value
        ? { title: t('team.confirmNoAccessTitle', { name: m.name, tool }), body: t('team.confirmNoAccessBody', { name: m.name, tool }), action: t('team.confirmNoAccessAction'), danger: true }
        : undefined;
    request({
      body: { productRoles: { [k]: value || null } },
      undo: { productRoles: { [k]: m.productRoles[k] ?? null } },
      done: value ? t('team.doneToolRole', { name: m.name, tool, role }) : t('team.doneNoAccess', { name: m.name, tool }),
      confirm,
    });
  };

  const suspended = m.status === 'SUSPENDED';
  const toggleSuspend = () =>
    request(
      suspended
        ? { body: { status: 'ACTIVE' }, undo: { status: 'SUSPENDED' }, done: t('team.doneResume', { name: m.name }) }
        : {
            body: { status: 'SUSPENDED' },
            undo: { status: 'ACTIVE' },
            done: t('team.doneSuspend', { name: m.name }),
            confirm: { title: t('team.confirmSuspendTitle', { name: m.name }), body: t('team.confirmSuspendBody', { name: m.name }), action: t('team.suspend'), danger: true },
          },
    );

  const menu = [
    ...(!m.email && !isSelf
      ? [{ label: t('team.newCode'), icon: 'key' as const, onSelect: () => resetCode.mutate(), disabled: suspended || lockedOwner || lockedAdmin, hint: suspended ? t('team.newCodeSuspended') : lockReason }]
      : []),
    {
      label: suspended ? t('team.resume') : t('team.suspend'),
      icon: suspended ? ('play' as const) : ('pause' as const),
      onSelect: toggleSuspend,
      disabled: manageLocked || isOwner,
      hint: isOwner ? t('team.lockOwnerAction') : lockReason,
    },
    { label: t('team.remove'), icon: 'trash' as const, danger: true, onSelect: () => onRemove(m), disabled: manageLocked || isOwner, hint: isOwner ? t('team.lockOwnerAction') : lockReason },
  ];

  const dialog = ask ? (
    <Modal
      title={ask.confirm!.title}
      onClose={() => setAsk(null)}
      actions={
        <>
          <ModalAction kind="dark" onClick={() => setAsk(null)}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction
            kind={ask.confirm!.danger ? 'danger' : 'prim'}
            data-autofocus
            onClick={() => {
              patch.mutate(ask);
              setAsk(null);
            }}
          >
            {ask.confirm!.action}
          </ModalAction>
        </>
      }
    >
      <p className="hub-code-how flush">{ask.confirm!.body}</p>
    </Modal>
  ) : null;

  return { isSelf, isOwner, manageLocked, roleLocked, lockReason, canAssignAdmin: viewerIsOwner, suspended, menu, error, setError, busy: patch.isPending, menuBusy: resetCode.isPending, changeOrgRole, changeToolRole, dialog, rolesOf };
}

function RowError({ name, error, onDismiss }: { name: string; error: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <Notice
      tone="err"
      action={
        <button type="button" className="link-btn act" onClick={onDismiss}>
          {t('common.dismiss')}
        </button>
      }
    >
      <b>{name}:</b> {error}
    </Notice>
  );
}

function OrgRoleSelect({ m, c, plain }: { m: OrgMember; c: ReturnType<typeof useMemberControls>; plain?: boolean }) {
  const { t } = useTranslation();
  return (
    <select className={`sel sm${plain ? ' hub-plain' : ''}`} aria-label={t('team.orgRoleOf', { name: m.name })} value={m.orgRole} disabled={c.manageLocked} title={c.lockReason} onChange={(e) => c.changeOrgRole(e.target.value as OrgRole)}>
      {c.canAssignAdmin || m.orgRole === 'ADMIN' ? <option value="ADMIN">{orgRoleLabel('ADMIN', t)}</option> : null}
      <option value="MEMBER">{orgRoleLabel('MEMBER', t)}</option>
    </select>
  );
}

/**
 * Rol seçenekleri firmanın rolleri (`GET /org/roles`). Sahibe özel izinli rolü yalnız firma sahibi verir (kapalı seçenek);
 * kişinin bugünkü rolü listede yoksa (gizlenmiş ya da eski rol) seçili kalsın diye yine gösterilir.
 */
function RoleOptions({ p, current, locale, isOwner }: { p: RolesProduct; current?: string | null; locale: 'tr' | 'en'; isOwner: boolean }) {
  const { t } = useTranslation();
  const extra = current && !findRole(p, current) ? current : null;
  return (
    <>
      {p.roles.map((r) => {
        const ownerOnly = !isOwner && r.key !== current && ownerOnlyIn(p, r.permissions).length > 0;
        return (
          <option key={r.key} value={r.key} disabled={ownerOnly}>
            {ownerOnly ? `${r.name} ${t('roles.delete.ownerOnlySuffix')}` : r.name}
          </option>
        );
      })}
      {extra && <option value={extra}>{roleName(p, extra, locale) ?? extra}</option>}
    </>
  );
}

function ToolRoleSelect({ m, k, c, locale, plain }: { m: OrgMember; k: ProductKey; c: ReturnType<typeof useMemberControls>; locale: 'tr' | 'en'; plain?: boolean }) {
  const { t } = useTranslation();
  const isOwner = useRoleViewer()(k).isOwner;
  return (
    <select
      className={`sel sm${plain ? ' hub-plain' : ''}${m.productRoles[k] ? '' : ' is-none'}`}
      aria-label={t('team.productRoleOf', { name: m.name, tool: PRODUCTS[k].name })}
      value={m.productRoles[k] ?? NO_ROLE}
      disabled={c.roleLocked}
      title={c.lockReason}
      onChange={(e) => c.changeToolRole(k, e.target.value)}
    >
      <option value={NO_ROLE}>{t('team.noAccess')}</option>
      <RoleOptions p={c.rolesOf(k)} current={m.productRoles[k]} locale={locale} isOwner={isOwner} />
    </select>
  );
}

function MemberRow({ member: m, locale, onCode, onRemove }: { member: OrgMember; locale: 'tr' | 'en'; onCode: (c: CodeInfo) => void; onRemove: (m: OrgMember) => void }) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const c = useMemberControls(m, onCode, onRemove);
  return (
    <>
      <tr className={c.suspended ? 'is-suspended' : undefined}>
        <td>
          <span className="d9-who">
            <b title={m.name}>
              <span className="ellipsis">{m.name}</span>
              {c.isSelf && <span className="d9-you">{t('team.you')}</span>}
            </b>
            <small className="ellipsis" title={m.email ?? undefined}>
              {m.email ? null : <Icon name="phone" size={13} />}
              {m.email ?? formatPhone(m.phone)}
            </small>
          </span>
        </td>
        <td data-label={t('team.orgRole')}>
          {c.isOwner ? (
            <span className="d9-locked">
              <Icon name="lock" size={13} />
              {orgRoleLabel('OWNER', t)}
            </span>
          ) : (
            <OrgRoleSelect m={m} c={c} plain />
          )}
        </td>
        {AVAILABLE.map((k) => (
          <td key={k} data-label={PRODUCTS[k].name}>
            <ToolRoleSelect m={m} k={k} c={c} locale={locale} plain />
          </td>
        ))}
        <td className="d9-seen">
          {c.busy ? (
            <Icon name="spin" className="spin" size={14} />
          ) : c.suspended ? (
            <Tag tone="yellow" small>
              {t('team.suspended')}
            </Tag>
          ) : m.lastActiveAt ? (
            formatRelative(m.lastActiveAt, locale)
          ) : (
            t('team.never')
          )}
        </td>
        <td className="d9-td-act">
          <ActionMenu iconOnly label={t('team.actionsFor', { name: m.name })} items={c.menu} busy={c.menuBusy} />
          {c.dialog}
        </td>
      </tr>
      {c.error && (
        <tr className="d9-row-error">
          <td colSpan={99}>
            <RowError name={m.name} error={c.error} onDismiss={() => c.setError(null)} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Telefon: kişi ve rol özeti kartta; seçiciler istenince altta açılır. */
function MemberCard({ member: m, locale, onCode, onRemove }: { member: OrgMember; locale: 'tr' | 'en'; onCode: (c: CodeInfo) => void; onRemove: (m: OrgMember) => void }) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const c = useMemberControls(m, onCode, onRemove);
  const [open, setOpen] = useState(false);
  const tools = AVAILABLE.map((k) => `${PRODUCTS[k].name}: ${roleName(c.rolesOf(k), m.productRoles[k], locale) ?? t('team.noAccess')}`);
  const canEdit = !c.roleLocked || !c.manageLocked;
  return (
    <li className={`d9-card${c.suspended ? ' is-suspended' : ''}`}>
      <div className="head">
        <span className="d9-who">
          <b title={m.name}>
            <span className="ellipsis">{m.name}</span>
            {c.isSelf && <span className="d9-you">{t('team.you')}</span>}
          </b>
          <small>{m.email ?? formatPhone(m.phone)}</small>
        </span>
        <ActionMenu iconOnly label={t('team.actionsFor', { name: m.name })} items={c.menu} busy={c.menuBusy} />
      </div>
      <p className="summary">
        {c.suspended && (
          <Tag tone="yellow" small>
            {t('team.suspended')}
          </Tag>
        )}
        <span>{[orgRoleLabel(m.orgRole, t), ...tools].join(' · ')}</span>
      </p>
      <p className="seen">{m.lastActiveAt ? t('team.seenAt', { when: formatRelative(m.lastActiveAt, locale) }) : t('team.never')}</p>
      {canEdit && (
        <button type="button" className="d9-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('team.hideRoles') : t('team.editRoles')}
        </button>
      )}
      {open && (
        <div className="editors">
          {!c.isOwner && (
            <label>
              <span>{t('team.orgRole')}</span>
              <OrgRoleSelect m={m} c={c} />
            </label>
          )}
          {AVAILABLE.map((k) => (
            <label key={k}>
              <span>{PRODUCTS[k].name}</span>
              <ToolRoleSelect m={m} k={k} c={c} locale={locale} />
            </label>
          ))}
        </div>
      )}
      {c.error && <RowError name={m.name} error={c.error} onDismiss={() => c.setError(null)} />}
      {c.dialog}
    </li>
  );
}

function PendingInvites({
  query,
  onCode,
  onLink,
  onReinvite,
}: {
  query: ReturnType<typeof useQuery<OrgInvitation[]>>;
  onCode: (c: CodeInfo) => void;
  onLink: (l: LinkInfo) => void;
  onReinvite: (i: OrgInvitation) => void;
}) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const locale = currentLocale();
  const scope = useScope();
  const rolesOf = useProductRoles(scope);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [...scope, 'invitations'] });
  const [exhausted, setExhausted] = useState<OrgInvitation | null>(null);
  const [revokeAsk, setRevokeAsk] = useState<OrgInvitation | null>(null);
  const resend = useMutation({
    mutationFn: (i: OrgInvitation) => client.post<InviteResult>(`/api/account/org/invitations/${i.id}/resend`),
    onSuccess: async (r, i) => {
      await refresh();
      if (r?.code) onCode({ code: r.code, name: i.name ?? formatPhone(i.phone), purpose: i.kind === 'PHONE_RESET' ? 'reset' : 'join' });
      else if (r?.link) onLink({ link: r.link, name: i.name ?? i.email ?? '', mailSent: r.mailSent });
      else toast.ok(t('team.resent'));
    },
    onError: (e, i) => {
      // Kodun deneme hakkı bitti: yeni kod üretilmez, davet iptal edilip yeniden yapılır.
      if (e instanceof ApiError && e.code === 'INVITE_ATTEMPTS_EXHAUSTED') setExhausted(i);
      else toast.err(t('team.resendFailed'), inviteError(e, t));
    },
  });
  const revoke = useMutation({
    mutationFn: (i: OrgInvitation) => client.delete(`/api/account/org/invitations/${i.id}`),
    onSuccess: async () => {
      await refresh();
      toast.ok(t('team.revoked'));
    },
    onError: (e) => toast.err(t('team.revokeFailed'), teamError(e, t('common.unexpected'))),
  });
  const redo = useMutation({
    mutationFn: (i: OrgInvitation) => client.delete(`/api/account/org/invitations/${i.id}`),
    onSuccess: async (_r, i) => {
      await refresh();
      setExhausted(null);
      onReinvite(i);
    },
    onError: (e) => toast.err(t('team.revokeFailed'), teamError(e, t('common.unexpected'))),
  });
  const list = query.data ?? [];
  if (query.isPending) return null;
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} title={t('team.invitesError')} />;
  return (
    <section className="d9-invs-wrap" aria-label={t('team.pendingTitle')}>
      {list.length === 0 ? (
        <p className="d9-empty">{t('team.pendingEmpty')}</p>
      ) : (
        <ul className="d9-invs">
          {list.map((i) => {
            const who = i.name ?? i.email ?? formatPhone(i.phone);
            const resending = resend.isPending && resend.variables?.id === i.id;
            const revoking = revoke.isPending && revoke.variables?.id === i.id;
            // Kodun hatalı giriş hakkı bitti (Y34): yeni kod üretilmez, satır baştan söyler ve menü iptal edip yeniden davete götürür.
            const codeDead = i.kind !== 'EMAIL' && (i.attempts ?? 0) >= JOIN_CODE_MAX_ATTEMPTS;
            return (
              <li key={i.id} className="d9-inv">
                <span className="d9-who">
                  <b>{who}</b>
                  <small>
                    <Icon name={i.kind === 'EMAIL' ? 'mail' : i.kind === 'PHONE_RESET' ? 'key' : 'phone'} size={13} />
                    {[i.email ?? formatPhone(i.phone), orgRoleLabel(i.orgRole, t), i.kind === 'PHONE_RESET' ? t('team.resetLabel') : null, ...AVAILABLE.map((k) => roleName(rolesOf(k), i.productRoles?.[k], locale)).filter(Boolean)].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <span className="d9-inv-exp">
                  {codeDead ? (
                    <Tag tone="yellow" small>
                      {t('team.codeExhausted')}
                    </Tag>
                  ) : i.expired ? (
                    <Tag tone="yellow" small>
                      {t('team.expired')}
                    </Tag>
                  ) : (
                    t('team.expires', { date: formatDate(i.expiresAt, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })
                  )}
                </span>
                <ActionMenu
                  iconOnly
                  label={t('d9.team.inviteActionsFor', { name: who })}
                  busy={resending || revoking}
                  items={[
                    codeDead
                      ? { label: t('team.exhaustedAction'), icon: 'refresh', onSelect: () => setExhausted(i) }
                      : { label: i.kind === 'EMAIL' ? t('team.resend') : t('team.newCode'), icon: 'refresh', onSelect: () => resend.mutate(i) },
                    { label: t('team.revoke'), icon: 'close', danger: true, onSelect: () => setRevokeAsk(i) },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
      {revokeAsk && (
        <Modal
          title={t('team.revokeConfirmTitle')}
          onClose={() => setRevokeAsk(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setRevokeAsk(null)}>
                {t('team.keep')}
              </ModalAction>
              <ModalAction
                kind="danger"
                data-autofocus
                onClick={() => {
                  revoke.mutate(revokeAsk);
                  setRevokeAsk(null);
                }}
              >
                {t('team.revokeConfirm')}
              </ModalAction>
            </>
          }
        >
          <p className="hub-code-how flush">{t('team.revokeConfirmBody', { email: revokeAsk.email ?? revokeAsk.name ?? formatPhone(revokeAsk.phone) })}</p>
        </Modal>
      )}
      {exhausted && (
        <Modal
          title={t('team.exhaustedTitle')}
          onClose={() => setExhausted(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setExhausted(null)}>
                {t('common.cancel')}
              </ModalAction>
              <ModalAction kind="prim" loading={redo.isPending} onClick={() => redo.mutate(exhausted)}>
                {t('team.exhaustedAction')}
              </ModalAction>
            </>
          }
        >
          <p className="hub-code-how flush">{t('team.exhaustedBody', { name: exhausted.name ?? formatPhone(exhausted.phone) })}</p>
        </Modal>
      )}
    </section>
  );
}

/** Roller ne yapar: katalogdan gelir, kod ve arayüz tek kaynağı okur. */
function RoleGuide({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const locale = currentLocale();
  const rolesOf = useProductRoles(useScope());
  return (
    <Modal
      title={t('team.guide')}
      size="wide"
      onClose={onClose}
      actions={
        <ModalAction kind="dark" onClick={onClose}>
          {t('common.done')}
        </ModalAction>
      }
    >
      <div className="d9-guide-tool">
        <h3>{t('team.guideOrg')}</h3>
        <ul className="d9-guide-roles">
          {ORG_ROLES.map((r) => (
            <li key={r}>
              <b>{orgRoleLabel(r, t)}</b>
              <span>{t(`team.orgRoleDesc.${r}`)}</span>
            </li>
          ))}
        </ul>
      </div>
      {AVAILABLE.map((k) => {
        const def = PRODUCTS[k];
        // Firmanın rolleri (özel ve adı değişmiş roller dahil, gizlenen hazır roller hariç) ve izinleri yanıttan.
        const rp = rolesOf(k);
        const perms = rp.permissions;
        return (
          <div key={k} className="d9-guide-tool">
            <h3>{def.name}</h3>
            <ul className="d9-guide-roles">
              {rp.roles.map((r) => (
                <li key={r.key}>
                  <b>{r.name}</b>
                  {r.description && <span>{r.description}</span>}
                </li>
              ))}
            </ul>
            <div className="table-wrap">
              <table className="dt compact d9-guide-table">
                <thead>
                  <tr>
                    <th>{t('team.permission')}</th>
                    {rp.roles.map((r) => (
                      <th key={r.key} className="center">
                        {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {perms.map((p) => (
                    <tr key={p.key}>
                      <td>{p.label[locale]}</td>
                      {rp.roles.map((r) => (
                        <td key={r.key} className="center">
                          {r.permissions.includes(p.key) ? (
                            <>
                              <Icon name="check" size={14} className="d9-yes" />
                              <span className="sr-only">{t('team.yes')}</span>
                            </>
                          ) : (
                            <span className="sr-only">{t('team.no')}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

function InvitePanel({
  viewerRole,
  initial,
  onClose,
  onCode,
  onLink,
}: {
  viewerRole: OrgRole;
  /** Yeniden davet: iptal edilen davetin bilgileri hazır gelir. */
  initial?: OrgInvitation | null;
  onClose: () => void;
  onCode: (c: CodeInfo) => void;
  onLink: (l: LinkInfo) => void;
}) {
  const { t } = useTranslation();
  const AVAILABLE = useTeamProducts();
  const locale = currentLocale();
  const scope = useScope();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'EMAIL' | 'PHONE_CODE'>(initial?.kind === 'EMAIL' ? 'EMAIL' : 'PHONE_CODE');
  const [name, setName] = useState(initial?.name ?? '');
  const [contact, setContact] = useState(initial?.email ?? (initial?.phone ? formatPhone(initial.phone) : ''));
  const [orgRole, setOrgRole] = useState<OrgRole>(initial?.orgRole ?? 'MEMBER');
  const rolesOf = useProductRoles(scope);
  const viewerOf = useRoleViewer();
  // Seçilmeyen araçta önseçim: yeniden davette eski davetin rolü, yoksa davet varsayılanı (`pickInviteRole`: silinmişse kalan
  // ilk rol; firma yöneticisine sahibe özel izinli rol önerilmez). Roller sonradan yüklense de önseçim onlara uyar.
  const [picked, setPicked] = useState<Record<string, string>>(initial?.productRoles ? Object.fromEntries(Object.entries(initial.productRoles).map(([k, v]) => [k, v ?? ''])) : {});
  const roleOf = (k: ProductKey): string => {
    if (k in picked) return picked[k]!;
    const rp = rolesOf(k);
    const open = rp.roles.filter((r) => viewerOf(k).isOwner || ownerOnlyIn(rp, r.permissions).length === 0).map((r) => r.key);
    return pickInviteRole(k, open) ?? '';
  };

  const invite = useMutation({
    mutationFn: (body: InviteBody) => client.post<InviteResult>('/api/account/org/members/invite', body),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: [...scope, 'invitations'] });
      if (r.code) onCode({ code: r.code, name, purpose: 'join' });
      else if (r.link) onLink({ link: r.link, name, mailSent: r.mailSent });
      else {
        toast.ok(t('team.invited'));
        onClose();
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const productRoles: ProductRoles = {};
    for (const k of AVAILABLE) productRoles[k] = roleOf(k) || null;
    invite.mutate({ kind, name: name.trim(), ...(kind === 'EMAIL' ? { email: contact.trim() } : { phone: contact.trim() }), orgRole, productRoles });
  };
  const validation = invite.error instanceof ApiError && invite.error.code === 'VALIDATION';

  return (
    <SlideOver
      title={t('team.inviteTitle')}
      description={t('team.inviteBody')}
      onClose={onClose}
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="hub-invite" loading={invite.isPending}>
            {kind === 'EMAIL' ? t('team.sendInvite') : t('team.createCode')}
          </Button>
        </>
      }
    >
      <form id="hub-invite" onSubmit={submit} className="form-stack">
        <div className="seg hub-seg-full" role="group" aria-label={t('team.inviteKind')}>
          <button type="button" className={kind === 'PHONE_CODE' ? 'on' : undefined} aria-pressed={kind === 'PHONE_CODE'} onClick={() => setKind('PHONE_CODE')}>
            <Icon name="phone" /> {t('team.kindPhone')}
          </button>
          <button type="button" className={kind === 'EMAIL' ? 'on' : undefined} aria-pressed={kind === 'EMAIL'} onClick={() => setKind('EMAIL')}>
            <Icon name="mail" /> {t('team.kindEmail')}
          </button>
        </div>
        <p className="hub-sheet-note flush">{kind === 'PHONE_CODE' ? t('team.kindPhoneHelp') : t('team.kindEmailHelp')}</p>
        <Field label={t('team.name')} htmlFor="inv-name" className="req">
          <input id="inv-name" className="inp" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        {kind === 'EMAIL' ? (
          <Field label={t('team.email')} htmlFor="inv-contact" className="req">
            <input id="inv-contact" className="inp" type="email" required value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" aria-invalid={validation || undefined} />
          </Field>
        ) : (
          <Field label={t('team.phone')} htmlFor="inv-contact" className="req" help={t('team.phoneHelp')}>
            <input id="inv-contact" className="inp" type="tel" required value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" inputMode="tel" aria-invalid={validation || undefined} />
          </Field>
        )}
        <Field label={t('team.orgRole')} htmlFor="inv-org" help={viewerRole === 'OWNER' ? t('team.orgRoleHelp') : t('team.orgRoleHelpAdmin')}>
          <select id="inv-org" className="sel" value={orgRole} onChange={(e) => setOrgRole(e.target.value as OrgRole)}>
            <option value="MEMBER">{orgRoleLabel('MEMBER', t)}</option>
            {viewerRole === 'OWNER' && <option value="ADMIN">{orgRoleLabel('ADMIN', t)}</option>}
          </select>
        </Field>
        {AVAILABLE.map((k: ProductKey) => {
          const selected = roleOf(k);
          const rp = rolesOf(k);
          const desc = selected ? (findRole(rp, selected)?.description ?? '') : undefined;
          return (
            <Field key={k} label={PRODUCTS[k].name} htmlFor={`inv-${k}`} help={desc === undefined ? t('team.noAccessHelp') : desc || undefined}>
              <select id={`inv-${k}`} className="sel" value={selected} onChange={(e) => setPicked({ ...picked, [k]: e.target.value })}>
                <option value="">{t('team.noAccess')}</option>
                <RoleOptions p={rp} current={initial?.productRoles?.[k] ?? null} locale={locale} isOwner={viewerOf(k).isOwner} />
              </select>
            </Field>
          );
        })}
        {invite.isError && <Notice tone="err">{inviteError(invite.error, t)}</Notice>}
      </form>
    </SlideOver>
  );
}

/** E-posta daveti bağlantısı. Yalnız üretildiği anda görünür; sonra "Yeniden gönder" yenisini üretir. */
function LinkDialog({ link, name, mailSent, onClose }: LinkInfo & { onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useMe();
  const mailOff = me?.account?.mailEnabled === false;
  // Yerel kurulum: posta yalnız deneme kutusuna yazılır (SMTP yok); "gönderildi" denmez.
  const localOnly = !mailOff && me?.account?.mailDelivers === false;
  const url = new URL(link, window.location.origin).href;
  return (
    <Modal
      label={t('team.kindEmail')}
      title={t('team.linkTitle')}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.done')}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="copy"
            data-autofocus
            onClick={async () => {
              if (await copyText(url)) toast.ok(t('team.linkCopied'));
              else toast.err(t('team.copyFailed'));
            }}
          >
            {t('team.copyLink')}
          </ModalAction>
        </>
      }
    >
      {mailOff ? <Notice tone="warn">{t('team.mailOff')}</Notice> : localOnly ? <Notice tone="warn">{t('team.mailLocalOnly')}</Notice> : mailSent === false && <Notice tone="warn">{t('team.mailNotSent')}</Notice>}
      <p className="hub-code-how flush">{t('team.linkBody', { name })}</p>
      <input className="inp mono" readOnly value={url} aria-label={t('team.copyLink')} onFocus={(e) => e.target.select()} />
      <p className="hub-code-how">{mailOff || localOnly || mailSent === false ? t('team.linkHintManual') : t('team.linkHintSent')}</p>
    </Modal>
  );
}

/** Kod bir kez gösterilir. Kapatmadan önce kopyalanır; sunucu yalnız özetini saklar. */
function CodeDialog({ code, name, purpose, onClose }: { code: string; name: string; purpose: 'join' | 'reset'; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useMe();
  const [copied, setCopied] = useState(false);
  const joinUrl = `${window.location.origin}/join`;
  const message = useMemo(() => t(purpose === 'join' ? 'team.codeMessage' : 'team.resetMessage', { org: me?.activeOrg?.name, url: joinUrl, code }), [t, purpose, me, joinUrl, code]);
  return (
    <Modal
      label={purpose === 'join' ? t('team.codeLabel') : t('team.resetLabel')}
      title={t('team.codeTitle', { name })}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {copied ? t('common.done') : t('team.codeClose')}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="copy"
            data-autofocus
            onClick={async () => {
              if (await copyText(message)) {
                setCopied(true);
                toast.ok(t('team.messageCopied'));
              } else toast.err(t('team.copyFailed'));
            }}
          >
            {t('team.copyMessage')}
          </ModalAction>
        </>
      }
    >
      <div className="hub-code">
        <output className="mono" aria-label={t('team.codeAria')}>
          {code}
        </output>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              toast.ok(t('team.codeCopied'));
            } else toast.err(t('team.copyFailed'));
          }}
        >
          <Icon name="copy" /> {t('team.copyCode')}
        </button>
      </div>
      <Notice tone="warn">{t('team.codeOnce')}</Notice>
      <p className="hub-code-how">{t('team.codeHow', { url: joinUrl })}</p>
      {purpose === 'join' && <p className="hub-code-how">{t('team.codeAppNote')}</p>}
    </Modal>
  );
}

function RemoveDialog({ member, onClose }: { member: OrgMember; onClose: () => void }) {
  const { t } = useTranslation();
  const scope = useScope();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => client.delete(`/api/account/org/members/${member.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [...scope, 'members'] });
      toast.ok(t('team.removed', { name: member.name }));
      onClose();
    },
  });
  return (
    <Modal
      title={t('team.removeTitle', { name: member.name })}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('team.remove')}
          </ModalAction>
        </>
      }
    >
      <p>{t('team.removeBody')}</p>
      {remove.isError && <Notice tone="err">{teamError(remove.error, t('common.unexpected'))}</Notice>}
    </Modal>
  );
}

