import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_PROVIDERS,
  PRODUCTS,
  aiMicrosToAmount,
  type AiAdminKey,
  type AiAdminLimits,
  type AiAdminOrgRow,
  type AiAllowanceState,
  type AiProvider,
  type ProductKey,
} from '@sellerondata/contracts';
import { Button, ErrorState, Field, Modal, ModalAction, Notice, PageHeader, Tag, formatDate, formatMoney, toast, type Tone } from '@sellerondata/shell';
import { fetchAdminKeys, fetchAdminLimits, fetchAdminStatus, patchAdminLimits, putOrgCap, removeAdminKey, setAdminKey, testAdminKey } from '../../api/ai.ts';
import { apiMessage } from '../../lib/hooks.ts';
import { Panel, Row } from '../account/AccountLayout.tsx';
import { SpendView } from '../account/AiSpendParts.tsx';
import { StepUpCancelled, useStepUp } from './StepUp.tsx';

/*
 * Platform › Yapay zekâ (yalnız platform yöneticisi; rota `RequireAccess isPlatformOperator`, uçlar da `op` ister).
 * `/platform/ai`: sağlayıcı anahtarları, platform tavanları ve acil durdurma, firma hakları (Hesabım'ın Panel/Row diliyle).
 * `/platform/ai/spend`: bütün firmaların harcaması (firma ekranının görünümü, firma kırılımı ve süzgeciyle; TL ya da USD).
 * Değiştiren işlemler önce şifre ister (`useStepUp`); acil durdurma istemez (hızlı olsun), geri açma ister. Anahtar hiçbir zaman
 * ekranda görünmez: yalnız son dört hane ve durum (sözleşme `AiAdminKey`).
 */

const ADMIN_KEY = ['ai-admin'] as const;
const STATE_TONE: Record<AiAllowanceState, Tone> = { ok: 'green', warn: 'yellow', capped: 'red', paused: 'gray' };
const KEY_TONE: Record<AiAdminKey['state'], Tone> = { ok: 'green', missing: 'gray', rejected: 'red' };

function PlatformTabs() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const items = [
    { to: '/platform/ai', label: t('platform.ai.tabs.manage'), on: pathname === '/platform/ai' },
    { to: '/platform/ai/spend', label: t('platform.ai.tabs.spend'), on: pathname.startsWith('/platform/ai/spend') },
  ];
  return (
    <nav className="ptabs hub-tool-tabs" aria-label={t('platform.ai.tabs.label')}>
      {items.map((i) => (
        <Link key={i.to} to={i.to} className={`hub-tool-tab${i.on ? ' on' : ''}`} aria-current={i.on ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function PlatformAiSpend() {
  const { t } = useTranslation();
  return <SpendView scope="platform" title={t('platform.ai.title')} tabs={<PlatformTabs />} />;
}

/** Hata iletisi; şifre penceresi kapatıldıysa sessiz. */
function useFailToast() {
  const { t } = useTranslation();
  return (title: string) => (e: unknown) => {
    if (e instanceof StepUpCancelled) return;
    toast.err(title, apiMessage(e, t('common.unexpected')));
  };
}

export function PlatformAi() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const stepUp = useStepUp();
  const status = useQuery({ queryKey: [...ADMIN_KEY, 'status'], queryFn: fetchAdminStatus });
  const stale = status.data?.stalePrices ?? [];
  return (
    <div className="hub-page acc">
      <PageHeader title={t('platform.ai.title')} sub={t('platform.ai.sub')} tabs={<PlatformTabs />} />
      <div className="d9-wrap">
        <div className="acc-main d9-lift">
          {status.data?.paused && <Notice tone="err">{t('platform.status.paused')}</Notice>}
          {status.data && !status.data.paused && !status.data.available && <Notice tone="warn">{t('platform.status.unavailable')}</Notice>}
          {stale.length > 0 && (
            <Notice tone="warn">{t('platform.status.stale', { providers: stale.map((p) => t(`platform.provider.${p}`)).join(', ') })}</Notice>
          )}
          <KeysPanel run={stepUp.run} />
          <LimitsPanels run={stepUp.run} lng={lng} />
        </div>
      </div>
      {stepUp.modal}
    </div>
  );
}

type Run = ReturnType<typeof useStepUp>['run'];

// ---------- Sağlayıcı anahtarları ----------

function KeysPanel({ run }: { run: Run }) {
  const { t } = useTranslation();
  const keys = useQuery({ queryKey: [...ADMIN_KEY, 'keys'], queryFn: fetchAdminKeys });
  return (
    <Panel id="pf-keys" title={t('platform.keys.title')} sub={t('platform.keys.sub')}>
      {keys.isError && <ErrorState error={keys.error} onRetry={() => keys.refetch()} />}
      {keys.isPending && AI_PROVIDERS.map((p) => <Row key={p} label={t(`platform.provider.${p}`)} value={<span className="acc-muted">…</span>} />)}
      {keys.data?.keys.map((k) => (
        <KeyRow key={k.provider} k={k} run={run} />
      ))}
    </Panel>
  );
}

function KeyRow({ k, run }: { k: AiAdminKey; run: Run }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const qc = useQueryClient();
  const failed = useFailToast();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ADMIN_KEY });
  const when = (iso: string) => formatDate(iso, lng, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const name = t(`platform.provider.${k.provider}`);
  const test = useMutation({
    mutationFn: () => testAdminKey(k.provider),
    onSuccess: (r) => {
      void refresh();
      if (r.lastTest?.ok) toast.ok(t('platform.keys.tested'));
      else toast.err(t('platform.keys.testFailed'));
    },
    onError: failed(t('platform.keys.testFailed')),
  });
  const remove = useMutation({
    mutationFn: () => run((token) => removeAdminKey(k.provider, token)),
    onSuccess: () => {
      setConfirmRemove(false);
      void refresh();
      toast.ok(t('platform.keys.removed'));
    },
    onError: failed(t('platform.keys.removeFailed')),
  });
  const notes = [
    k.setBy && k.setAt ? t('platform.keys.setBy', { name: k.setBy, date: when(k.setAt) }) : null,
    k.lastTest
      ? t(k.lastTest.ok ? 'platform.keys.lastTestOk' : 'platform.keys.lastTestFail', { date: when(k.lastTest.at), status: k.lastTest.httpStatus ?? '' })
      : null,
  ].filter(Boolean);
  const present = k.state !== 'missing';
  return (
    <Row
      label={name}
      value={
        <>
          <Tag tone={KEY_TONE[k.state]} small>
            {t(`platform.keyState.${k.state}`)}
          </Tag>{' '}
          {k.last4 && <span className="num">•••• {k.last4}</span>}
        </>
      }
      note={notes.length ? <small>{notes.join(' · ')}</small> : undefined}
      actions={
        editing ? null : (
          <>
            <button type="button" className="acc-act" onClick={() => setEditing(true)}>
              {present ? t('platform.keys.change') : t('platform.keys.add')}
            </button>
            {present && (
              <button type="button" className="acc-act mute" disabled={test.isPending} onClick={() => test.mutate()}>
                {t('platform.keys.test')}
              </button>
            )}
            {present && (
              <button type="button" className="acc-act danger" onClick={() => setConfirmRemove(true)}>
                {t('platform.keys.remove')}
              </button>
            )}
          </>
        )
      }
    >
      {editing && <KeyEditor provider={k.provider} run={run} onDone={() => setEditing(false)} />}
      {confirmRemove && (
        <Modal
          title={t('platform.keys.removeTitle', { provider: name })}
          onClose={() => setConfirmRemove(false)}
          busy={remove.isPending}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setConfirmRemove(false)}>
                {t('common.cancel')}
              </ModalAction>
              <ModalAction kind="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                {t('platform.keys.remove')}
              </ModalAction>
            </>
          }
        >
          <p>{t('platform.keys.removeBody')}</p>
        </Modal>
      )}
    </Row>
  );
}

function KeyEditor({ provider, run, onDone }: { provider: AiProvider; run: Run; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => run((token) => setAdminKey(provider, key.trim(), token)),
    onSuccess: () => {
      setKey('');
      void qc.invalidateQueries({ queryKey: ADMIN_KEY });
      toast.ok(t('platform.keys.saved'));
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };
  const id = `pf-key-${provider}`;
  return (
    <form className="acc-form" onSubmit={submit}>
      <Field label={t('platform.keys.inputLabel')} htmlFor={id} help={t('platform.keys.inputHelp')}>
        {/* Anahtar ekranda okunmasın, tarayıcı da saklamasın: parola alanı, otomatik doldurma kapalı. */}
        <input id={id} className="inp" type="password" autoFocus autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      {save.isError && !(save.error instanceof StepUpCancelled) && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
      <div className="acc-form-acts">
        <Button type="submit" loading={save.isPending} disabled={!key.trim()}>
          {t('common.save')}
        </Button>
        <Button kind="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ---------- Tavanlar ve firmalar ----------

/** Platform yöneticisine tutar USD ve TL birlikte (karar 2026-11-21). */
function useBoth(lng: string, rate: number) {
  return (micro: number) => `${formatMoney(aiMicrosToAmount(micro), 'USD', lng)} (${formatMoney(aiMicrosToAmount(Math.round(micro * rate)), 'TRY', lng)})`;
}

function LimitsPanels({ run, lng }: { run: Run; lng: string }) {
  const { t } = useTranslation();
  const limits = useQuery({ queryKey: [...ADMIN_KEY, 'limits'], queryFn: fetchAdminLimits });
  if (limits.isError) {
    return (
      <Panel id="pf-limits" title={t('platform.limits.title')}>
        <ErrorState error={limits.error} onRetry={() => limits.refetch()} />
      </Panel>
    );
  }
  if (!limits.data) {
    return (
      <Panel id="pf-limits" title={t('platform.limits.title')}>
        <Row label={t('platform.limits.today')} value={<span className="acc-muted">…</span>} />
      </Panel>
    );
  }
  return (
    <>
      <PlatformLimits l={limits.data} run={run} lng={lng} />
      <OrgsPanel l={limits.data} run={run} lng={lng} />
    </>
  );
}

function Meter({ used, cap, label }: { used: number; cap: number; label: string }) {
  const pct = cap > 0 ? Math.min(100, Math.max(0, Math.round((used / cap) * 100))) : 0;
  return (
    <span
      className={`aiu-meter${used >= cap ? ' is-full' : pct >= 80 ? ' is-warn' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

function PlatformLimits({ l, run, lng }: { l: AiAdminLimits; run: Run; lng: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const failed = useFailToast();
  const both = useBoth(lng, l.tryPerUsd);
  const [editing, setEditing] = useState<'daily' | 'monthly' | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const p = l.platform;
  const apply = (next: AiAdminLimits) => qc.setQueryData([...ADMIN_KEY, 'limits'], next);
  const refreshStatus = () => qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'status'] });
  const pause = useMutation({
    mutationFn: () => patchAdminLimits({ paused: true }, null),
    onSuccess: (next) => {
      apply(next);
      void refreshStatus();
      setConfirmPause(false);
      toast.ok(t('platform.limits.pausedToast'));
    },
    onError: failed(t('platform.limits.pauseFailed')),
  });
  const resume = useMutation({
    mutationFn: () => run((token) => patchAdminLimits({ paused: false }, token)),
    onSuccess: (next) => {
      apply(next);
      void refreshStatus();
      toast.ok(t('platform.limits.resumedToast'));
    },
    onError: failed(t('platform.limits.resumeFailed')),
  });
  const when = (iso: string) => formatDate(iso, lng, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const capRow = (kind: 'daily' | 'monthly', label: string, used: number, cap: number) => (
    <Row
      label={label}
      value={
        <>
          {t('platform.limits.usage', { used: both(used), cap: both(cap) })}
          <Meter used={used} cap={cap} label={label} />
        </>
      }
      actions={
        editing === kind ? null : (
          <button type="button" className="acc-act" onClick={() => setEditing(kind)}>
            {t('platform.limits.change')}
          </button>
        )
      }
    >
      {editing === kind && (
        <UsdEditor
          id={`pf-cap-${kind}`}
          label={t('platform.limits.capLabel')}
          initial={aiMicrosToAmount(cap)}
          run={run}
          // Boş değer burada geçersiz (`allowEmpty` yok): `usd` hep sayıdır.
          save={(usd, token) => patchAdminLimits(kind === 'daily' ? { platformDailyUsd: usd ?? 0 } : { platformMonthlyUsd: usd ?? 0 }, token)}
          onSaved={(next) => {
            apply(next);
            toast.ok(t('platform.limits.saved'));
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </Row>
  );
  return (
    <Panel id="pf-limits" title={t('platform.limits.title')} sub={t('platform.limits.sub')}>
      {capRow('daily', t('platform.limits.today'), p.todayUsedMicroUsd, p.dailyCapMicroUsd)}
      {capRow('monthly', t('platform.limits.month'), p.monthUsedMicroUsd, p.monthlyCapMicroUsd)}
      <Row
        label={t('platform.limits.state')}
        value={
          <Tag tone={p.paused ? 'red' : 'green'} small>
            {p.paused ? t('platform.limits.paused') : t('platform.limits.running')}
          </Tag>
        }
        note={p.paused && p.pausedAt ? <small>{t('platform.limits.pausedBy', { name: p.pausedBy ?? '', date: when(p.pausedAt) })}</small> : undefined}
        actions={
          p.paused ? (
            <button type="button" className="acc-act" disabled={resume.isPending} onClick={() => resume.mutate()}>
              {t('platform.limits.resume')}
            </button>
          ) : (
            <button type="button" className="acc-act danger" onClick={() => setConfirmPause(true)}>
              {t('platform.limits.pause')}
            </button>
          )
        }
      />
      {confirmPause && (
        <Modal
          title={t('platform.limits.pauseTitle')}
          onClose={() => setConfirmPause(false)}
          busy={pause.isPending}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setConfirmPause(false)}>
                {t('common.cancel')}
              </ModalAction>
              <ModalAction kind="danger" loading={pause.isPending} onClick={() => pause.mutate()}>
                {t('platform.limits.pause')}
              </ModalAction>
            </>
          }
        >
          <p>{t('platform.limits.pauseBody')}</p>
        </Modal>
      )}
    </Panel>
  );
}

function OrgsPanel({ l, run, lng }: { l: AiAdminLimits; run: Run; lng: string }) {
  const { t } = useTranslation();
  const both = useBoth(lng, l.tryPerUsd);
  return (
    <Panel id="pf-orgs" title={t('platform.orgs.title')} sub={t('platform.orgs.sub', { cap: both(l.orgDefaultCapMicroUsd) })}>
      {l.orgs.length === 0 ? (
        <p className="acc-card-text">{t('platform.orgs.none')}</p>
      ) : (
        l.orgs.map((o) => <OrgRow key={o.orgId} o={o} run={run} both={both} />)
      )}
    </Panel>
  );
}

function OrgRow({ o, run, both }: { o: AiAdminOrgRow; run: Run; both: (micro: number) => string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const tools = (Object.entries(o.byProduct) as [ProductKey, number][]).filter(([, v]) => v > 0).map(([k, v]) => `${PRODUCTS[k]?.name ?? k} ${both(v)}`);
  const label: ReactNode = o.orgName ?? <span className="acc-muted">{t('platform.orgs.deleted')}</span>;
  return (
    <Row
      label={label}
      value={
        <>
          {t('platform.orgs.usage', { used: both(o.usedMicroUsd), cap: both(o.capMicroUsd), pct: o.usedPct })}{' '}
          <Tag tone={STATE_TONE[o.state]} small>
            {t(`platform.state.${o.state}`)}
          </Tag>
          {o.capOverridden && (
            <>
              {' '}
              <Tag tone="blue" small>
                {t('platform.orgs.overridden')}
              </Tag>
            </>
          )}
        </>
      }
      note={tools.length ? <small>{tools.join(' · ')}</small> : undefined}
      actions={
        editing || o.orgName === null ? null : (
          <button type="button" className="acc-act" onClick={() => setEditing(true)}>
            {t('platform.orgs.change')}
          </button>
        )
      }
    >
      {editing && (
        <UsdEditor
          id={`pf-org-${o.orgId}`}
          label={t('platform.orgs.capLabel')}
          help={t('platform.orgs.capHelp')}
          initial={o.capOverridden ? aiMicrosToAmount(o.capMicroUsd) : null}
          allowEmpty
          run={run}
          save={(usd, token) => putOrgCap(o.orgId, usd, token)}
          onSaved={(next) => {
            qc.setQueryData([...ADMIN_KEY, 'limits'], next);
            toast.ok(t('platform.orgs.saved'));
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </Row>
  );
}

/** Tutar (USD) düzenleyici; `allowEmpty`: boş bırakmak varsayılana döner (null gönderilir). */
function UsdEditor({
  id,
  label,
  help,
  initial,
  allowEmpty,
  run,
  save,
  onSaved,
  onCancel,
}: {
  id: string;
  label: string;
  help?: string;
  initial: number | null;
  allowEmpty?: boolean;
  run: Run;
  save: (usd: number | null, token: string) => Promise<AiAdminLimits>;
  onSaved: (next: AiAdminLimits) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(initial === null ? '' : String(initial));
  const value = raw.trim() === '' ? null : Number(raw.replace(',', '.'));
  const valid = value === null ? !!allowEmpty : Number.isFinite(value) && value >= 0 && value <= 1_000_000;
  const go = useMutation({ mutationFn: () => run((token) => save(value, token)), onSuccess: onSaved });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) go.mutate();
  };
  return (
    <form className="acc-form" onSubmit={submit}>
      <Field label={label} htmlFor={id} help={help}>
        <input
          id={id}
          className="inp w-sm"
          inputMode="decimal"
          autoFocus
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-invalid={!valid || undefined}
        />
      </Field>
      {go.isError && !(go.error instanceof StepUpCancelled) && <Notice tone="err">{apiMessage(go.error, t('common.unexpected'))}</Notice>}
      <div className="acc-form-acts">
        <Button type="submit" loading={go.isPending} disabled={!valid}>
          {t('common.save')}
        </Button>
        <Button kind="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
