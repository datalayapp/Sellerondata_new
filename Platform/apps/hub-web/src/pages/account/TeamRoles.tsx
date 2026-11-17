import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation } from '@tanstack/react-query';
import { PRODUCTS, ROLE_DESCRIPTION_MAX_LENGTH, ROLE_NAME_MAX_LENGTH, pickInviteRole, type CreateRoleBody, type DeleteRoleResponse, type Locale, type OrgProductRole, type PatchRoleBody, type ProductKey, type RoleResponse } from '@sellerondata/contracts';
import { ActionMenu, Button, ErrorState, Field, Icon, Modal, ModalAction, Notice, ProductMark, Skel, SlideOver, Tag, currentLocale, toast, type MenuItem, type Tone } from '@sellerondata/shell';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { client } from '../../lib/session.ts';
import { useOrgRoles, useRoleViewer, useRolesRefresh } from '../../lib/orgRoles.ts';
import {
  canEverDelete,
  copyName,
  defaultReassign,
  deleteRolePath,
  descriptionTooLong,
  effectivePermissions,
  findRole,
  ownerOnlyIn,
  permissionRows,
  permissionsToSave,
  reassignTargets,
  resetRolePath,
  roleErrorOf,
  roleInUse,
  roleKindOf,
  roleNameIssue,
  rolePath,
  sameSet,
  templatePermissions,
  togglePermission,
  type RoleKindView,
  type RoleViewer,
  type RolesProduct,
} from '../../lib/roles.ts';

/*
 * Ekip ve yetkiler · Roller sekmesi (tasarım tuvali "Özel Roller" sürüm 3, kullanıcı onayı 2026-11-13).
 * Her araç için rol tablosu, ⋯ menüsü (Düzenle, Kopyala, Bu roldekileri gör, Varsayılana dön, Sil), sağdan açılan rol
 * düzenleyici (şablon → yetkiler) ve kullanımdaki rolü taşıyarak silme. Kurallar sunucudadır; ekran yalnız yansıtır.
 */

/** Düzenleyicinin açılışı: yeni rol (şablon adımıyla), var olan rolü düzenleme ya da kopyalama (doğrudan yetkiler adımı). */
export type RoleDrawerStart = { mode: 'new'; product?: ProductKey } | { mode: 'edit' | 'copy'; product: ProductKey; key: string };

const KIND_TONE: Record<RoleKindView, Tone> = { builtin: 'gray', edited: 'yellow', custom: 'blue' };
const PILLS = 4;

/** İznin kısa adı (tablo hapı); sözlükte yoksa yanıttaki tam ad. */
function shortPerm(t: TFunction, p: RolesProduct, key: string, locale: Locale): string {
  const full = p.permissions.find((x) => x.key === key)?.label[locale] ?? key;
  return t(`roles.permShort.${key}`, { defaultValue: full });
}
const permLabel = (p: RolesProduct, key: string, locale: Locale) => p.permissions.find((x) => x.key === key)?.label[locale] ?? key;

/** Rol neden yönetilemiyor (menü ipucu). Yanıt yalnız `editable` der; neden sahibe özel izinden ya da rolü taşıyanlardan gelir. */
function lockHint(t: TFunction, p: RolesProduct, r: OrgProductRole, viewer: RoleViewer): string {
  return !viewer.isOwner && ownerOnlyIn(p, r.permissions).length ? t('roles.hint.owner_only') : t('roles.hint.unmanageable_holder');
}

/** Rol hatası → metin. Ad çakışması alanda gösterilir, burada değil. */
function roleErrorText(e: unknown, t: TFunction, p: RolesProduct | undefined, locale: Locale): string {
  const v = roleErrorOf(e);
  const list = (keys: string[]) => keys.map((k) => (p ? permLabel(p, k, locale) : k)).join(', ');
  switch (v.kind) {
    case 'version':
      return t('roles.error.version');
    case 'forbidden': {
      // Sahibin kendisi için engel bekleyen yönetici davetleridir: hangi davetler ve ne yapılacağı söylenir, izin listesi eklenmez.
      if (v.reason === 'pending_admin_invites') {
        return v.invitations?.length ? t('roles.error.pendingInvites', { list: v.invitations.join(', ') }) : t('roles.error.forbidden.pending_admin_invites');
      }
      const message = t(`roles.error.forbidden.${v.reason ?? 'other'}`);
      return v.permissions.length ? t('roles.error.forbiddenPerms', { message, list: list(v.permissions) }) : message;
    }
    case 'invalid_permissions':
      return t('roles.error.invalidPerms', { list: list([...new Set(v.missing.flatMap((m) => m.requires))]) });
    case 'limit':
      return t('roles.error.limit');
    case 'locked':
      return t('roles.error.locked');
    case 'in_use':
      return t('roles.error.inUse');
    case 'name_taken':
      return t('roles.issue.taken');
    default:
      return apiMessage(e, t('common.unexpected'));
  }
}

// ---------- Sekme ----------

export function RolesTab({ tools, onOpen, onShowPeople }: { tools: readonly ProductKey[]; onOpen: (s: RoleDrawerStart) => void; onShowPeople: (product: ProductKey, key: string) => void }) {
  const { t } = useTranslation();
  const scope = useScope();
  const roles = useOrgRoles(scope);
  const [removing, setRemoving] = useState<{ product: ProductKey; role: OrgProductRole } | null>(null);
  const [resetting, setResetting] = useState<{ product: ProductKey; role: OrgProductRole } | null>(null);
  const [restoring, setRestoring] = useState<ProductKey | null>(null);

  if (roles.isPending) {
    return (
      <div className="d9-skel" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skel key={i} h={44} />
        ))}
      </div>
    );
  }
  if (roles.isError && !roles.data) return <ErrorState error={roles.error} onRetry={() => roles.refetch()} title={t('roles.loadError')} />;
  const products = roles.data.products.filter((p) => tools.includes(p.key));
  return (
    <section className="d9-roles" aria-label={t('roles.tab')}>
      {products.map((p) => (
        <ProductRoles key={p.key} p={p} onOpen={onOpen} onShowPeople={onShowPeople} onDelete={(role) => setRemoving({ product: p.key, role })} onReset={(role) => setResetting({ product: p.key, role })} onRestore={() => setRestoring(p.key)} />
      ))}
      {removing && <DeleteRoleDialog product={removing.product} role={removing.role} onClose={() => setRemoving(null)} />}
      {resetting && <ResetRoleDialog product={resetting.product} role={resetting.role} onClose={() => setResetting(null)} />}
      {restoring && <RestoreDialog product={restoring} onClose={() => setRestoring(null)} />}
    </section>
  );
}

function ProductRoles({
  p,
  onOpen,
  onShowPeople,
  onDelete,
  onReset,
  onRestore,
}: {
  p: RolesProduct;
  onOpen: (s: RoleDrawerStart) => void;
  onShowPeople: (product: ProductKey, key: string) => void;
  onDelete: (r: OrgProductRole) => void;
  onReset: (r: OrgProductRole) => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const viewer = useRoleViewer()(p.key);
  const custom = p.roles.filter((r) => r.kind === 'custom').length;
  const atLimit = custom >= p.customRoleLimit;
  const titleId = `roles-${p.key}`;
  return (
    <div className="d9-roles-tool">
      <h2 className="d9-roles-head" id={titleId}>
        <ProductMark product={p.key} size={18} />
        {PRODUCTS[p.key].name}
        <small>· {t('roles.summary', { builtin: p.roles.length - custom, custom })}</small>
      </h2>
      <table className="d9-tbl d9-roles-tbl" aria-labelledby={titleId}>
        <thead>
          <tr>
            <th scope="col">{t('roles.col.role')}</th>
            <th scope="col">{t('roles.col.kind')}</th>
            <th scope="col">{t('roles.col.people')}</th>
            <th scope="col">{t('roles.col.perms')}</th>
            <th scope="col" className="d9-td-act">
              <span className="sr-only">{t('table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {p.roles.map((r) => {
            const kind = roleKindOf(r);
            const hint = r.editable ? undefined : lockHint(t, p, r, viewer);
            const items: MenuItem[] = [
              { label: t('roles.menu.edit'), icon: 'edit', onSelect: () => onOpen({ mode: 'edit', product: p.key, key: r.key }), disabled: !r.editable, hint },
              { label: t('roles.menu.copy'), icon: 'copy', onSelect: () => onOpen({ mode: 'copy', product: p.key, key: r.key }), disabled: atLimit, hint: atLimit ? t('roles.hint.limit', { count: p.customRoleLimit }) : undefined },
              { label: t('roles.menu.people'), icon: 'users', onSelect: () => onShowPeople(p.key, r.key), disabled: r.memberCount === 0, hint: r.memberCount === 0 ? t('roles.hint.nobody') : undefined },
              ...(kind === 'edited' ? [{ label: t('roles.menu.reset'), icon: 'refresh' as const, onSelect: () => onReset(r), disabled: !r.editable, hint }] : []),
              ...(canEverDelete(p, r) ? [{ label: t('roles.menu.delete'), icon: 'trash' as const, danger: true, onSelect: () => onDelete(r), disabled: !r.deletable, hint: r.deletable ? undefined : hint }] : []),
            ];
            const shown = r.permissions.slice(0, PILLS);
            return (
              <tr key={r.key}>
                <td>
                  <span className="d9-role-name">
                    <b>{r.name}</b>
                    {r.permissionsLocked && (
                      <span className="d9-role-lock">
                        <Icon name="lock" size={12} />
                        {t('roles.locked')}
                      </span>
                    )}
                  </span>
                  {r.description && <small className="d9-role-desc">{r.description}</small>}
                </td>
                <td>
                  <Tag tone={KIND_TONE[kind]} small>
                    {t(`roles.kind.${kind}`)}
                  </Tag>
                </td>
                <td className="d9-role-count">
                  {r.memberCount ? t('roles.people', { count: r.memberCount }) : <span className="d9-muted">{t('roles.nobody')}</span>}
                  {r.inviteCount > 0 && <small>{t('roles.invites', { count: r.inviteCount })}</small>}
                </td>
                <td>
                  {r.permissions.length === 0 ? (
                    <span className="d9-muted">{t('roles.noPerms')}</span>
                  ) : (
                    <ul className="d9-pills" aria-label={r.permissions.map((k) => permLabel(p, k, locale)).join(', ')}>
                      {shown.map((k) => (
                        <li key={k} aria-hidden="true">
                          {shortPerm(t, p, k, locale)}
                        </li>
                      ))}
                      {r.permissions.length > PILLS && <li aria-hidden="true">{t('roles.morePerms', { count: r.permissions.length - PILLS })}</li>}
                    </ul>
                  )}
                </td>
                <td className="d9-td-act">
                  <ActionMenu
                    iconOnly
                    compact
                    label={t('roles.actionsFor', { name: r.name })}
                    header={
                      <>
                        <b>{r.name}</b> · {t(`roles.kindLong.${kind}`)}
                      </>
                    }
                    items={items}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {p.hiddenBuiltins.length > 0 && (
        <button type="button" className="d9-link d9-roles-restore" onClick={onRestore}>
          {t('roles.restoreLink', { count: p.hiddenBuiltins.length })}
        </button>
      )}
    </div>
  );
}

// ---------- Düzenleyici (sağ panel) ----------

type Template = { key: string; name: string; description?: string; permissions: string[] } | null;

/** Kendi `key` ile yeniden kurulur: başka bir rol ya da "son halini yükle" formu baştan açar. */
export function RoleDrawer({ start, tools, onClose }: { start: RoleDrawerStart; tools: readonly ProductKey[]; onClose: () => void }) {
  const scope = useScope();
  const roles = useOrgRoles(scope);
  const [round, setRound] = useState(0);
  const products = (roles.data?.products ?? []).filter((p) => tools.includes(p.key));
  if (!roles.data) return <RoleDrawerLoading onClose={onClose} error={roles.isError ? roles.error : null} onRetry={() => roles.refetch()} />;
  return (
    <RoleDrawerBody
      key={round}
      start={start}
      products={products}
      onClose={onClose}
      onReload={async () => {
        await roles.refetch();
        setRound((n) => n + 1);
      }}
    />
  );
}

function RoleDrawerLoading({ onClose, error, onRetry }: { onClose: () => void; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <SlideOver title={t('roles.drawer.pickTitle')} onClose={onClose}>
      {error ? (
        <ErrorState error={error} onRetry={onRetry} title={t('roles.loadError')} />
      ) : (
        <div className="d9-skel" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skel key={i} h={56} />
          ))}
        </div>
      )}
    </SlideOver>
  );
}

function RoleDrawerBody({ start, products, onClose, onReload }: { start: RoleDrawerStart; products: RolesProduct[]; onClose: () => void; onReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const scope = useScope();
  const refresh = useRolesRefresh(scope);
  const viewerOf = useRoleViewer();

  // Başlangıç: düzenlenen/kopyalanan rol ya da ilk araç.
  // Açılış anının fotoğrafı: yanıt yenilense de form kendiliğinden değişmez ("son halini yükle" yeniden kurar).
  const [init] = useState(() => {
    const product = products.find((p) => p.key === start.product) ?? products[0];
    const source = start.mode !== 'new' && product ? findRole(product, start.key) : undefined;
    return { product, source };
  });

  const [productKey, setProductKey] = useState<ProductKey | undefined>(init.product?.key);
  const p = products.find((x) => x.key === productKey);
  const viewer = productKey ? viewerOf(productKey) : { isOwner: false, permissions: [] };
  const editing = start.mode === 'edit' ? init.source : undefined;
  const locked = !!editing?.permissionsLocked;
  const original = useMemo(() => new Set(editing?.permissions ?? []), [editing]);

  const builtinTemplates = (pp: RolesProduct | undefined): Template[] => (pp ? [...pp.roles.filter((r) => r.kind === 'builtin').map((r) => ({ key: r.key, name: r.name, description: r.description, permissions: r.permissions })), null] : []);
  const defaultTemplate = (pp: RolesProduct | undefined): string => {
    if (!pp) return '';
    return pickInviteRole(pp.key, pp.roles.filter((r) => r.kind === 'builtin').map((r) => r.key)) ?? '';
  };

  const fromCopy = start.mode === 'copy' && init.source && init.product ? templatePermissions(init.product, viewerOf(init.product.key), init.source.permissions) : null;
  const [step, setStep] = useState<1 | 2>(start.mode === 'new' ? 1 : 2);
  // Şablon seçimi: hazır rol anahtarı ya da '' (boş rol).
  const [tpl, setTpl] = useState<string>(() => defaultTemplate(init.product));
  const [chosen, setChosen] = useState<string[]>(() => (editing ? [...editing.permissions] : (fromCopy?.chosen ?? [])));
  const [dropped, setDropped] = useState<number>(fromCopy?.dropped.length ?? 0);
  const [name, setName] = useState(() => (editing ? editing.name : start.mode === 'copy' && init.source && init.product ? copyName(init.product, (n) => t('roles.copyName', { name: n }), init.source.name) : ''));
  const [description, setDescription] = useState(() => (editing ? (editing.description ?? '') : start.mode === 'copy' ? (init.source?.description ?? '') : ''));
  const basedOn = start.mode === 'copy' ? (init.source?.kind === 'builtin' ? init.source.key : init.source?.basedOn) : step === 2 && tpl ? tpl : undefined;
  const [tried, setTried] = useState(false);
  const [nameTaken, setNameTaken] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const perms = permissionsToSave(p!, chosen);
      if (editing) {
        const body: PatchRoleBody = { version: editing.version };
        if (name.trim() !== editing.name) body.name = name.trim();
        const desc = description.trim();
        if (desc !== (editing.description ?? '')) body.description = desc ? desc : null;
        if (!locked && !sameSet(perms, editing.permissions)) body.permissions = perms;
        return client.patch<RoleResponse>(rolePath(p!.key, editing.key), body);
      }
      const body: CreateRoleBody = { product: p!.key, name: name.trim(), permissions: perms, ...(description.trim() ? { description: description.trim() } : {}), ...(basedOn ? { basedOn } : {}) };
      return client.post<RoleResponse>('/api/account/org/roles', body);
    },
    onSuccess: async (r) => {
      await refresh();
      toast.ok(t(editing ? 'roles.done.saved' : 'roles.done.created', { name: r?.role?.name ?? name.trim() }), editing && editing.memberCount > 0 ? t('roles.drawer.liveNote') : undefined);
      onClose();
    },
    onError: (e) => {
      if (roleErrorOf(e).kind === 'name_taken') setNameTaken(true);
    },
  });

  if (!p) return <RoleDrawerLoading onClose={onClose} error={null} onRetry={() => undefined} />;
  const tool = PRODUCTS[p.key].name;
  const effective = effectivePermissions(p, chosen);
  const customCount = p.roles.filter((r) => r.kind === 'custom').length;
  const atLimit = !editing && customCount >= p.customRoleLimit;
  const issue = roleNameIssue(p, name, editing?.key);
  const nameError = nameTaken ? t('roles.issue.taken') : tried && issue ? t(`roles.issue.${issue}`, { max: ROLE_NAME_MAX_LENGTH }) : undefined;
  const descError = descriptionTooLong(description) ? t('roles.issue.descriptionTooLong', { max: ROLE_DESCRIPTION_MAX_LENGTH }) : undefined;
  const dirty = editing
    ? name.trim() !== editing.name || description.trim() !== (editing.description ?? '') || !sameSet(effective, editing.permissions)
    : step === 2 || tpl !== defaultTemplate(p);
  const templates = builtinTemplates(p);
  const chosenTemplate = templates.find((x) => (x?.key ?? '') === tpl);
  const sourceName = start.mode === 'copy' ? init.source?.name : chosenTemplate?.name;

  const toStep2 = () => {
    const picked = templatePermissions(p, viewer, chosenTemplate?.permissions ?? []);
    setChosen(picked.chosen);
    setDropped(picked.dropped.length);
    setStep(2);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (issue || descError || nameTaken) {
      document.getElementById('role-name')?.focus();
      return;
    }
    save.mutate();
  };

  const err = save.error ? roleErrorOf(save.error) : null;
  const stepLabel = editing ? t('roles.drawer.editStep', { tool }) : t('roles.drawer.newStep', { tool, step });

  if (step === 1) {
    return (
      <SlideOver
        title={t('roles.drawer.pickTitle')}
        description={
          <>
            <span className="d9-role-step">{stepLabel}</span> {t('roles.drawer.pickBody')}
          </>
        }
        onClose={onClose}
        dirty={dirty}
        actions={
          <>
            <Button kind="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={toStep2} disabled={atLimit}>
              {t('roles.drawer.continue')}
            </Button>
          </>
        }
      >
        {products.length > 1 && (
          <Field label={t('roles.drawer.product')} htmlFor="role-product">
            <select
              id="role-product"
              className="sel"
              value={p.key}
              onChange={(e) => {
                const next = products.find((x) => x.key === e.target.value);
                setProductKey(next?.key);
                setTpl(defaultTemplate(next));
              }}
            >
              {products.map((x) => (
                <option key={x.key} value={x.key}>
                  {PRODUCTS[x.key].name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {atLimit && <Notice tone="warn">{t('roles.drawer.limitReached', { count: p.customRoleLimit })}</Notice>}
        <fieldset className="d9-tpls">
          <legend className="sr-only">{t('roles.drawer.templates')}</legend>
          {templates.map((x) => {
            const key = x?.key ?? '';
            return (
              <label key={key || 'blank'} className={`d9-tpl${key === tpl ? ' on' : ''}${x ? '' : ' blank'}`}>
                <input type="radio" name="role-template" value={key} checked={key === tpl} onChange={() => setTpl(key)} />
                <span className="d9-tpl-text">
                  <b>{x ? x.name : t('roles.drawer.blank')}</b>
                  <small>{x ? x.description : t('roles.drawer.blankDesc')}</small>
                </span>
                <span className="d9-tpl-count">{t('roles.drawer.permCount', { count: x ? x.permissions.length : 0 })}</span>
              </label>
            );
          })}
        </fieldset>
      </SlideOver>
    );
  }

  const rows = permissionRows(p, viewer, chosen, original, locked);
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const groups = p.groups.length ? p.groups : [{ key: '', label: { tr: '', en: '' } }];
  const neededNames = (keys: string[]) => {
    const names = keys.map((k) => permLabel(p, k, locale));
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  };
  const sourceNote = editing ? null : start.mode === 'copy' || tpl ? t('roles.drawer.fromTemplate', { name: sourceName }) : t('roles.drawer.fromBlank');

  return (
    <SlideOver
      title={editing ? t('roles.drawer.editTitle') : t('roles.drawer.reviewTitle')}
      description={<span className="d9-role-step">{[stepLabel, sourceNote].filter(Boolean).join(' · ')}</span>}
      onClose={onClose}
      busy={save.isPending}
      dirty={dirty}
      actions={
        <>
          <span className="d9-role-sel" aria-live="polite">
            {t('roles.drawer.selected', { count: effective.length })}
          </span>
          {start.mode === 'new' ? (
            <Button kind="secondary" onClick={() => setStep(1)} disabled={save.isPending}>
              {t('roles.drawer.back')}
            </Button>
          ) : (
            <Button kind="secondary" onClick={onClose} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" form="role-form" loading={save.isPending} disabled={atLimit}>
            {editing ? t('roles.drawer.save') : t('roles.drawer.create')}
          </Button>
        </>
      }
    >
      <form id="role-form" className="form-stack d9-role-form" onSubmit={submit} noValidate>
        {atLimit && <Notice tone="warn">{t('roles.drawer.limitReached', { count: p.customRoleLimit })}</Notice>}
        <Field label={t('roles.drawer.name')} htmlFor="role-name" className="req" error={nameError}>
          <input
            id="role-name"
            className="inp"
            value={name}
            maxLength={ROLE_NAME_MAX_LENGTH + 10}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameTaken(false);
            }}
          />
        </Field>
        <Field label={t('roles.drawer.description')} htmlFor="role-desc" error={descError}>
          <input id="role-desc" className="inp" value={description} autoComplete="off" aria-invalid={descError ? true : undefined} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {locked && <Notice tone="info">{t('roles.drawer.lockedBanner')}</Notice>}
        {dropped > 0 && <Notice tone="warn">{t('roles.drawer.dropped', { count: dropped })}</Notice>}
        {groups.map((g) => {
          const perms = p.permissions.filter((x) => (g.key ? x.group === g.key : true));
          if (!perms.length) return null;
          return (
            <fieldset key={g.key || 'all'} className="d9-perm-group">
              <legend>{g.key ? g.label[locale] : t('roles.drawer.permissions')}</legend>
              {perms.map((perm) => {
                const row = rowOf.get(perm.key)!;
                const auto = row.checked && row.neededBy.length > 0;
                const reason = auto
                  ? t('roles.drawer.neededBy', { names: neededNames(row.neededBy) })
                  : row.block && row.block.reason !== 'locked'
                    ? t(`roles.block.${row.block.reason}`, { perm: row.block.via ? permLabel(p, row.block.via, locale) : '' })
                    : undefined;
                const id = `perm-${perm.key}`;
                return (
                  <div key={perm.key} className={`d9-perm${auto ? ' is-auto' : ''}${row.block && row.block.reason !== 'locked' ? ' is-blocked' : ''}`}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={row.checked}
                      disabled={row.disabled || save.isPending}
                      aria-describedby={reason ? `${id}-why` : undefined}
                      onChange={() => setChosen((c) => togglePermission(p, viewer, c, original, locked, perm.key))}
                    />
                    <label htmlFor={id}>
                      {perm.label[locale]}
                      {reason && (
                        <small id={`${id}-why`} className={row.block ? 'warn' : undefined}>
                          {reason}
                        </small>
                      )}
                    </label>
                  </div>
                );
              })}
            </fieldset>
          );
        })}
        {!locked && <p className="d9-help d9-perm-legend">{t('roles.drawer.autoLegend')}</p>}
        {err && err.kind !== 'name_taken' && (
          <Notice
            tone="err"
            action={
              err.kind === 'version' ? (
                <button type="button" className="link-btn act" onClick={() => void onReload()}>
                  {t('roles.error.reload')}
                </button>
              ) : undefined
            }
          >
            {roleErrorText(save.error, t, p, locale)}
          </Notice>
        )}
      </form>
    </SlideOver>
  );
}

// ---------- Silme, varsayılana dönüş, geri getirme ----------

function DeleteRoleDialog({ product, role, onClose }: { product: ProductKey; role: OrgProductRole; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const scope = useScope();
  const roles = useOrgRoles(scope);
  const refresh = useRolesRefresh(scope);
  const viewer = useRoleViewer()(product);
  const p = roles.data?.products.find((x) => x.key === product);
  // Sunucu "bu arada birine verildi" derse (409 ROLE_IN_USE) sayılar ondan gelir ve taşıma adımı açılır.
  const [counts, setCounts] = useState<{ members: number; invites: number } | null>(null);
  const members = counts?.members ?? role.memberCount;
  const invites = counts?.invites ?? role.inviteCount;
  const inUse = roleInUse({ memberCount: members, inviteCount: invites });
  const targets = p ? reassignTargets(p, role.key, viewer) : [];
  const [target, setTarget] = useState<string>(() => (p ? (defaultReassign(p, role.key, viewer) ?? '') : ''));
  const remove = useMutation({
    mutationFn: () => client.delete<DeleteRoleResponse>(deleteRolePath(product, role.key, inUse ? target : null)),
    onSuccess: async (r) => {
      await refresh();
      const moved = (r?.reassigned?.members ?? 0) + (r?.reassigned?.invites ?? 0);
      const to = targets.find((x) => x.key === target)?.name;
      toast.ok(t('roles.done.deleted', { name: role.name }), moved > 0 && to ? t('roles.done.moved', { count: moved, to }) : undefined);
      onClose();
    },
    onError: (e) => {
      const v = roleErrorOf(e);
      if (v.kind === 'in_use') {
        setCounts({ members: v.members, invites: v.invites });
        if (!target && p) setTarget(defaultReassign(p, role.key, viewer) ?? '');
        void refresh();
      }
    },
  });
  const what = [members > 0 ? t('roles.delete.membersIn', { count: members }) : null, invites > 0 ? t('roles.delete.invitesIn', { count: invites }) : null].filter((x): x is string => !!x);
  const noTarget = inUse && !targets.some((x) => !x.disabled);
  const err = remove.error ? roleErrorOf(remove.error) : null;
  return (
    <Modal
      title={t('roles.delete.title', { name: role.name })}
      onClose={onClose}
      busy={remove.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="danger" loading={remove.isPending} disabled={noTarget || (inUse && !target)} onClick={() => remove.mutate()}>
            {inUse ? t('roles.delete.move') : t('roles.delete.action')}
          </ModalAction>
        </>
      }
    >
      {inUse ? (
        <>
          <p className="hub-code-how flush">{what.length === 2 ? t('roles.delete.inUseBoth', { members: what[0], invites: what[1] }) : t('roles.delete.inUseOne', { what: what[0] })}</p>
          {noTarget ? (
            <Notice tone="warn">{t('roles.delete.noTarget')}</Notice>
          ) : (
            <Field label={t('roles.delete.newRole')} htmlFor="role-reassign">
              <select id="role-reassign" className="sel" value={target} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((x) => (
                  <option key={x.key} value={x.key} disabled={x.disabled}>
                    {x.disabled ? `${x.name} ${t('roles.delete.ownerOnlySuffix')}` : x.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="hub-code-how">{t('roles.delete.sessions')}</p>
        </>
      ) : (
        <p className="hub-code-how flush">{t('roles.delete.unused')}</p>
      )}
      {role.kind === 'builtin' && <p className="hub-code-how">{t('roles.delete.builtinNote')}</p>}
      {err && err.kind !== 'in_use' && <Notice tone="err">{roleErrorText(remove.error, t, p, locale)}</Notice>}
      {err?.kind === 'in_use' && <Notice tone="warn">{t('roles.error.inUse')}</Notice>}
    </Modal>
  );
}

function ResetRoleDialog({ product, role, onClose }: { product: ProductKey; role: OrgProductRole; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const scope = useScope();
  const roles = useOrgRoles(scope);
  const refresh = useRolesRefresh(scope);
  const reset = useMutation({
    mutationFn: () => client.post<RoleResponse>(resetRolePath(product, role.key)),
    onSuccess: async (r) => {
      await refresh();
      toast.ok(t('roles.done.reset', { name: r?.role?.name ?? role.name }));
      onClose();
    },
  });
  return (
    <Modal
      title={t('roles.reset.title', { name: role.name })}
      onClose={onClose}
      busy={reset.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="prim" data-autofocus loading={reset.isPending} onClick={() => reset.mutate()}>
            {t('roles.reset.action')}
          </ModalAction>
        </>
      }
    >
      <p className="hub-code-how flush">{t('roles.reset.body')}</p>
      {reset.isError && <Notice tone="err">{roleErrorText(reset.error, t, roles.data?.products.find((x) => x.key === product), locale)}</Notice>}
    </Modal>
  );
}

function RestoreDialog({ product, onClose }: { product: ProductKey; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const scope = useScope();
  const roles = useOrgRoles(scope);
  const refresh = useRolesRefresh(scope);
  const p = roles.data?.products.find((x) => x.key === product);
  const hidden = p?.hiddenBuiltins ?? [];
  const restore = useMutation({
    mutationFn: (key: string) => client.post<RoleResponse>(resetRolePath(product, key)),
    onSuccess: async (r, key) => {
      await refresh();
      toast.ok(t('roles.restored', { name: r?.role?.name ?? hidden.find((h) => h.key === key)?.name ?? key }));
      if (hidden.length <= 1) onClose();
    },
  });
  return (
    <Modal
      title={t('roles.restoreTitle')}
      onClose={onClose}
      busy={restore.isPending}
      actions={
        <ModalAction kind="dark" onClick={onClose}>
          {t('common.done')}
        </ModalAction>
      }
    >
      <p className="hub-code-how flush">{t('roles.restoreBody')}</p>
      <ul className="d9-restore">
        {hidden.map((h) => (
          <li key={h.key}>
            <b>{h.name}</b>
            <Button kind="secondary" small icon="refresh" loading={restore.isPending && restore.variables === h.key} disabled={restore.isPending} onClick={() => restore.mutate(h.key)}>
              {t('roles.restore')}
            </Button>
          </li>
        ))}
      </ul>
      {restore.isError && <Notice tone="err">{roleErrorText(restore.error, t, p, locale)}</Notice>}
    </Modal>
  );
}
