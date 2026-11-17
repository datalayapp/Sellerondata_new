import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { clearOnboardingRedirect } from '../lib/onboarding';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { boxPresets, referenceCard, settings, type SettingsView } from '../api/endpoints';
import type { BoxPreset } from '../api/types';
import { useAuth, usePermission, useProductMe } from '../auth/AuthContext';
import { CompanyNameField } from '../components/CompanyNameField';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import { ActionMenu, Affix, Button, Card, ErrorState, Field, Modal, ModalAction, PageHeader, Skel, errorMessage } from '../components/ui';
import { currencySymbol, ttkApplies } from '@deciship/core';
import { fmtNum, numToInput, parseMeasure, parseTrNumber, desiOf } from '../lib/format';
import { relocalizeFields, useLocaleSwitch } from '../lib/localeSwitch';
import { useLeaveGuard } from '../components/LeaveGuard';
import { BulkBand } from './invoice-detail/BulkBand';
import { useRecalcFlow } from './invoice-detail/RecalcDialog';

/** Karşılaştırma ayarı (faturada `compareSettings` olarak saklanır): değişirse eski faturalar eski ayarla kalır. */
const RULE_FIELDS = ['edgeTolCm', 'weightTolKg', 'amountTol', 'fxTolerancePct', 'unknownSurchargesAsDiff'] as const;

type Form = { edgeTolCm: string; weightTolKg: string; amountTol: string; desiDivisor: string; requiredBoxPhotos: string; warnEdgeCm: string; warnWeightKg: string; scaleAiRead: boolean; fxTolerancePct: string; unknownSurchargesAsDiff: boolean; disputeReminders: boolean };

function toForm(s: SettingsView): Form {
  return {
    edgeTolCm: numToInput(s.edgeTolCm),
    weightTolKg: numToInput(s.weightTolKg),
    amountTol: numToInput(s.amountTol, 2),
    desiDivisor: String(s.desiDivisor ?? 3000),
    requiredBoxPhotos: String(s.requiredBoxPhotos ?? 1),
    warnEdgeCm: String(s.warnEdgeCm ?? 150),
    warnWeightKg: String(s.warnWeightKg ?? 70),
    scaleAiRead: s.scaleAiRead === true,
    fxTolerancePct: numToInput(s.fxTolerancePct ?? 1.5, 2),
    unknownSurchargesAsDiff: s.unknownSurchargesAsDiff === true,
    disputeReminders: s.disputeReminders !== false,
  };
}

/** Tam sayı ve aralıkta mı (ölçü uyarısı eşikleri; API ile aynı aralık). */
const intIn = (v: string, lo: number, hi: number) => /^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi;

/** Ayarlar bölüm dizini (geniş ekranda soldaki gezinti). */
const SECTIONS = [
  ['company', 'company.title'],
  ['tolerances', 'tolerances.title'],
  ['fx', 'fx.title'],
  ['mobile', 'mobile.title'],
  ['refcard', 'refCard.title'],
  ['presets', 'presets.title'],
] as const;

export function SettingsPage() {
  const { t } = useTranslation('settings');
  const me = useProductMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { refreshMe } = useAuth();
  const canManage = usePermission('deciship.settings.manage');
  const q = useQuery({ queryKey: ['settings'], queryFn: settings.get });
  const [f, setF] = useState<Form | null>(null);
  // K36 incelemesi: arayüz dili değişince yazılmış sayılar anlamını korur (Türkçe "6.000" İngilizcede 6 olmasın)
  useLocaleSwitch((from, to) => setF((x) => x && relocalizeFields(x, ['amountTol', 'desiDivisor', 'fxTolerancePct'], ['edgeTolCm', 'weightTolKg'], from, to)));
  const [touched, setTouched] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);

  useEffect(() => {
    if (q.data) setF(toForm(q.data));
  }, [q.data]);

  const errs = f
    ? {
        edgeTolCm: (parseMeasure(f.edgeTolCm) ?? -1) < 0 || (parseMeasure(f.edgeTolCm) ?? 0) > 10 ? t('errors.validValue') : null,
        weightTolKg: (parseMeasure(f.weightTolKg) ?? -1) < 0 ? t('errors.validValue') : null,
        amountTol: (parseTrNumber(f.amountTol) ?? -1) < 0 ? t('errors.validValue') : null,
        desiDivisor: (parseTrNumber(f.desiDivisor) ?? 0) <= 0 ? t('errors.positive') : null,
        requiredBoxPhotos: !/^\d+$/.test(f.requiredBoxPhotos) || Number(f.requiredBoxPhotos) > 10 ? t('errors.photosRange') : null,
        warnEdgeCm: !intIn(f.warnEdgeCm, 10, 400) ? t('errors.warnEdgeRange') : null,
        warnWeightKg: !intIn(f.warnWeightKg, 1, 999) ? t('errors.warnWeightRange') : null,
        fxTolerancePct: (() => {
          const v = parseTrNumber(f.fxTolerancePct);
          return v == null || v < 0 || v > 20 ? t('errors.pctRange') : null;
        })(),
      }
    : {};
  const dirty = Boolean(f && q.data && JSON.stringify(f) !== JSON.stringify(toForm(q.data)));
  const { dialog: leaveDialog } = useLeaveGuard(dirty);

  // Mesaj 4: ayar kaydedilince tek soru "N fatura eski ayarla hesaplı; yeni ayara geçirilsin mi?" (vazgeçilirse eski ayarla kalır)
  const recalc = useRecalcFlow();
  const save = useMutation({
    mutationFn: (_rulesChanged: boolean) =>
      settings.update({
        edgeTolCm: parseMeasure(f!.edgeTolCm)!,
        weightTolKg: parseMeasure(f!.weightTolKg)!,
        amountTol: parseTrNumber(f!.amountTol)!,
        desiDivisor: parseTrNumber(f!.desiDivisor)!,
        requiredBoxPhotos: Number(f!.requiredBoxPhotos),
        warnEdgeCm: Number(f!.warnEdgeCm.trim()),
        warnWeightKg: Number(f!.warnWeightKg.trim()),
        scaleAiRead: f!.scaleAiRead,
        fxTolerancePct: parseTrNumber(f!.fxTolerancePct)!,
        unknownSurchargesAsDiff: f!.unknownSurchargesAsDiff,
        ...(ttkApplies(q.data?.country) ? { disputeReminders: f!.disputeReminders } : {}),
      }),
    onSuccess: (s, rulesChanged) => {
      qc.setQueryData(['settings'], s);
      toast.ok(t('toast.saved'), t('toast.savedBody'));
      setTouched(false);
      refreshMe().catch(() => undefined);
      if (rulesChanged) recalc.start({ kind: 'settings' }, { quiet: true });
    },
  });

  const submit = () => {
    setTouched(true);
    if (Object.values(errs).some(Boolean) || !f || !q.data) return;
    const was = toForm(q.data);
    save.mutate(RULE_FIELDS.some((k) => f[k] !== was[k]));
  };

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => f && setF({ ...f, [k]: e.target.value });

  return (
    <>
      {leaveDialog}
      <PageHeader
        title={t('page.title')}
        sub={me.company.name}
        actions={
          canManage && (
            <ActionMenu
              iconOnly
              label={t('page.more')}
              items={[
                { label: t('page.openSetup'), icon: 'flag', onSelect: () => nav('/setup') },
                ...(q.data?.dataResetEnabled === true
                  ? [{ label: t('page.dataSection'), icon: 'table' as const, onSelect: () => document.getElementById('set-data')?.scrollIntoView({ block: 'start' }) }]
                  : []),
              ]}
            />
          )
        }
      />
      <div className="content set-layout">
        {f && !q.isError && (
          <nav className="set-idx" aria-label={t('page.sections')}>
            {SECTIONS.map(([id, key]) => (
              <a key={id} href={`#set-${id}`}>
                {t(key)}
              </a>
            ))}
          </nav>
        )}
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !f ? (
          <div className="col set-stack">
            <Skel h={140} />
            <Skel h={200} />
          </div>
        ) : (
          <fieldset className="ds-ro set-stack" disabled={!canManage}>
            <BulkBand refType="Company" refId={me.company.id} ns="settings" onStale={(r) => recalc.showStale({ kind: 'settings' }, r)} />
            <Card id="set-company" title={t('company.title')} description={t('company.desc')}>
              <div className="form-stack">
                <CompanyNameField id="s-name" />
              </div>
            </Card>

            <Card
              id="set-tolerances"
              title={t('tolerances.title')}
              description={t('tolerances.desc')}
              actions={
                <>
                  {dirty && (
                    <span id="set-recompare-hint" className="muted s12">
                      {t('tolerances.saveFirst')}
                    </span>
                  )}
                  <Button
                    kind="secondary"
                    small
                    icon="refresh"
                    loading={recalc.busy}
                    disabled={dirty}
                    aria-describedby={dirty ? 'set-recompare-hint' : undefined}
                    onClick={() => recalc.start({ kind: 'settings' })}
                  >
                    {t('tolerances.recompare')}
                  </Button>
                </>
              }
            >
              <div className="form-grid c3 set-grid">
                <Field label={t('tolerances.edge')} htmlFor="s-edge" help={t('tolerances.edgeHelp')} error={touched ? errs.edgeTolCm : null}>
                  <Affix sfx="cm" className="set-unit">
                    <input id="s-edge" className="inp num" inputMode="decimal" value={f.edgeTolCm} onChange={set('edgeTolCm')} />
                  </Affix>
                </Field>
                <Field label={t('tolerances.weight')} htmlFor="s-wt" error={touched ? errs.weightTolKg : null}>
                  <Affix sfx="kg" className="set-unit">
                    <input id="s-wt" className="inp num" inputMode="decimal" value={f.weightTolKg} onChange={set('weightTolKg')} />
                  </Affix>
                </Field>
                <Field label={t('tolerances.amount')} htmlFor="s-amt" error={touched ? errs.amountTol : null} help={t('tolerances.amountHelp')}>
                  <Affix sfx={currencySymbol(q.data?.currency)} className="set-unit">
                    <input id="s-amt" className="inp num" inputMode="decimal" value={f.amountTol} onChange={set('amountTol')} />
                  </Affix>
                </Field>
              </div>
              <label className="check set-check">
                <input
                  type="checkbox"
                  checked={f.unknownSurchargesAsDiff}
                  onChange={(e) => setF({ ...f, unknownSurchargesAsDiff: e.target.checked })}
                />
                <span>
                  {t('tolerances.unknownSurcharges')}
                  <span className="set-check-sub">{t('tolerances.unknownSurchargesHelp')}</span>
                </span>
              </label>
            </Card>

            <Card id="set-fx" title={t('fx.title')} description={t('fx.desc')}>
              <div className="form-grid set-grid">
                <Field
                  label={t('fx.tolerance')}
                  htmlFor="s-fx"
                  error={touched ? errs.fxTolerancePct : null}
                >
                  <Affix sfx="%" className="set-unit">
                    <input id="s-fx" className="inp num" inputMode="decimal" value={f.fxTolerancePct} onChange={set('fxTolerancePct')} />
                  </Affix>
                </Field>
                <Field label={t('fx.source')} htmlFor="s-fxsrc" help={t('fx.sourceHelp')}>
                  <input id="s-fxsrc" className="inp w-lg" readOnly aria-readonly="true" value={q.data?.fxSource ?? t('fx.sourceDefault')} />
                </Field>
              </div>
            </Card>

            {ttkApplies(q.data?.country) && (
              <Card id="set-reminders" title={t('reminders.title')}>
                <label className="check set-check">
                  <input type="checkbox" checked={f.disputeReminders} onChange={(e) => setF({ ...f, disputeReminders: e.target.checked })} />
                  <span>
                    {t('reminders.on')}
                    <span className="set-check-sub">{t('reminders.help')}</span>
                  </span>
                </label>
              </Card>
            )}

            <Card id="set-mobile" title={t('mobile.title')} description={t('mobile.desc')}>
              <div className="form-grid set-grid">
                <Field
                  label={t('mobile.divisor')}
                  htmlFor="s-div"
                  error={touched ? errs.desiDivisor : null}
                  help={t('mobile.divisorHelp', { desi: fmtNum(desiOf(40, 30, 25, parseTrNumber(f.desiDivisor) || 3000), 0, 2) })}
                >
                  <input id="s-div" className="inp num w-sm" inputMode="numeric" value={f.desiDivisor} onChange={set('desiDivisor')} />
                </Field>
                <Field label={t('mobile.photos')} htmlFor="s-ph" error={touched ? errs.requiredBoxPhotos : null} help={t('mobile.photosHelp')}>
                  <Affix sfx={t('mobile.unitPcs')} className="set-unit">
                    <input id="s-ph" className="inp num" inputMode="numeric" value={f.requiredBoxPhotos} onChange={set('requiredBoxPhotos')} />
                  </Affix>
                </Field>
                {/* Y44: akla aykırı ölçü uyarısının eşikleri. Yalnız telefonda soru; kayıt engellenmez. */}
                <Field label={t('mobile.warnEdge')} htmlFor="s-wedge" error={touched ? errs.warnEdgeCm : null} help={t('mobile.warnEdgeHelp')}>
                  <Affix sfx="cm" className="set-unit">
                    <input id="s-wedge" className="inp num" inputMode="numeric" value={f.warnEdgeCm} onChange={set('warnEdgeCm')} />
                  </Affix>
                </Field>
                <Field label={t('mobile.warnWeight')} htmlFor="s-wkg" error={touched ? errs.warnWeightKg : null} help={t('mobile.warnWeightHelp')}>
                  <Affix sfx="kg" className="set-unit">
                    <input id="s-wkg" className="inp num" inputMode="numeric" value={f.warnWeightKg} onChange={set('warnWeightKg')} />
                  </Affix>
                </Field>
              </div>
              {/* Kullanıcı kararı 2026-11-12: tartı fotoğrafını ücretli yapay zekâ okusun mu (varsayılan kapalı). */}
              <label className="check set-check">
                <input type="checkbox" checked={f.scaleAiRead} onChange={(e) => setF({ ...f, scaleAiRead: e.target.checked })} />
                <span>
                  {t('mobile.scaleAiRead')}
                  <span className="set-check-sub">{t('mobile.scaleAiReadHelp')}</span>
                </span>
              </label>
            </Card>

            <section className="card set-ref" id="set-refcard" aria-labelledby="set-ref-t">
              <div className="set-ref-body">
                <h2 id="set-ref-t" className="section-title">
                  {t('refCard.title')}
                </h2>
                <p className="section-desc">{t('refCard.desc')}</p>
                <ol className="set-steps">
                  <li>
                    <Trans i18nKey="refCard.step1" ns="settings" components={{ b: <b /> }} />
                  </li>
                  <li>
                    <Trans i18nKey="refCard.step2" ns="settings" components={{ b: <b /> }} />
                  </li>
                  <li>{t('refCard.step3')}</li>
                </ol>
              </div>
              <Button
                kind="secondary"
                icon="download"
                loading={cardBusy}
                onClick={async () => {
                  setCardBusy(true);
                  try {
                    await referenceCard.download();
                  } catch (e) {
                    toast.err(t('refCard.downloadFailed'), errorMessage(e));
                  } finally {
                    setCardBusy(false);
                  }
                }}
              >
                {t('refCard.download')}
              </Button>
            </section>

            <BoxPresets />

            {/* sunucuda ENABLE_DATA_RESET kapalıysa bu uç da kartı da yoktur (ARCHITECTURE §11) */}
            {q.data?.dataResetEnabled === true && <DemoData />}

            {/* only while there is something to save: an idle bar with a disabled button is noise */}
            {recalc.dialog}
            {(dirty || save.isPending) && (
              <div className="savebar set-savebar is-dirty" role="region" aria-label={t('savebar.label')}>
                <div className="savebar-in">
                  <div className="savebar-state" aria-live="polite">
                    <span className="savebar-dot" aria-hidden="true" />
                    <span>
                      <b>{t('savebar.unsaved')}</b> <span className="sub">{t('savebar.unsavedHint')}</span>
                    </span>
                  </div>
                  <div className="savebar-actions">
                    <Button icon="check" loading={save.isPending} onClick={submit}>
                      {t('savebar.save')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        )}
      </div>
    </>
  );
}

/**
 * GEÇİCİ (deneme dönemi): sistemi sıfırla / örnek verileri yükle. Canlıya geçmeden kaldırılacak
 * (api: routes/settings.ts `/settings/data/reset`, services/companyData.ts).
 */
function DemoData() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { refreshMe } = useAuth();
  const nav = useNavigate();
  const [ask, setAsk] = useState<'empty' | 'samples' | null>(null);
  const run = useMutation({
    mutationFn: (samples: boolean) => settings.resetData(samples),
    onSuccess: (r) => {
      setAsk(null);
      // her sayfanın verisi değişti: önbellekteki her şey yeniden yüklensin
      qc.invalidateQueries();
      // sıfırlama kurulum sihirbazını yeniden açar, örnek veri kurulumu tamamlar (menü ve Pano bandı)
      refreshMe().catch(() => undefined);
      if (r.loaded) toast.ok(
        t('demo.toast.loaded'),
        t('demo.toast.loadedBody', {
          carriers: t('demo.toast.carriers', { count: r.loaded.carriers }),
          tariffs: t('demo.toast.tariffs', { count: r.loaded.tariffs }),
          measurements: t('demo.toast.measurements', { count: r.loaded.measurements }),
        }),
      );
      else {
        clearOnboardingRedirect();
        toast.ok(t('demo.toast.reset'), t('demo.toast.resetBody'), {
          action: { label: t('demo.toast.startSetup'), onClick: () => nav('/setup') },
        });
      }
    },
    onError: (e) => toast.err(t('demo.toast.failed'), errorMessage(e)),
  });
  return (
    <Card id="set-data" title={t('demo.title')} description={t('demo.desc')}>
      <div className="set-data">
        <div className="set-data-row">
          <div>
            <b>{t('demo.reset.title')}</b>
            <p className="t3 s12">{t('demo.reset.desc')}</p>
          </div>
          <Button kind="danger-outline" icon="trash" onClick={() => setAsk("empty")}>
            {t('demo.reset.title')}
          </Button>
        </div>
        <div className="set-data-row">
          <div>
            <b>{t('demo.samples.title')}</b>
            <p className="t3 s12">{t('demo.samples.desc')}</p>
          </div>
          <Button kind="secondary" icon="refresh" onClick={() => setAsk('samples')}>
            {t('demo.samples.title')}
          </Button>
        </div>
      </div>
      {ask && (
        <Modal
          label={t('demo.modal.label')}
          title={ask === 'empty' ? t('demo.modal.resetTitle') : t('demo.modal.samplesTitle')}
          onClose={() => !run.isPending && setAsk(null)}
          busy={run.isPending}
          actions={
            <>
              <ModalAction kind="dark" disabled={run.isPending} onClick={() => setAsk(null)}>
                {t('common.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon={ask === 'empty' ? 'trash' : 'refresh'} loading={run.isPending} onClick={() => run.mutate(ask === 'samples')}>
                {ask === 'empty' ? t('demo.modal.resetAction') : t('demo.modal.samplesAction')}
              </ModalAction>
            </>
          }
        >
          <p>
            <Trans i18nKey={ask === 'samples' ? 'demo.modal.bodySamples' : 'demo.modal.bodyReset'} ns="settings" components={{ b: <b /> }} />
          </p>
        </Modal>
      )}
    </Card>
  );
}

type PresetDraft = { name: string; l: string; w: string; h: string };

/** Ayarlar ve kurulum sihirbazı (Hazır koliler adımı) ortak kullanır. */
export function BoxPresets() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['box-presets'], queryFn: boxPresets.list });
  const [edit, setEdit] = useState<BoxPreset | 'new' | null>(null);
  const [del, setDel] = useState<BoxPreset | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['box-presets'] });

  const move = useMutation({
    mutationFn: async ({ list, from, to }: { list: BoxPreset[]; from: number; to: number }) => {
      const arr = [...list];
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
      await Promise.all(arr.map((p, i) => (p.sortOrder !== i ? boxPresets.update(p.id, { sortOrder: i }) : null)));
    },
    onSettled: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (p: BoxPreset) => boxPresets.update(p.id, { active: !p.active }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => boxPresets.remove(id),
    onSuccess: () => {
      toast.ok(t('presets.toast.deleted'));
      setDel(null);
      invalidate();
    },
  });

  const list = q.data ?? [];
  return (
    <Card
      id="set-presets"
      flush
      title={t('presets.title')}
      description={t('presets.desc')}
      actions={
        <Button kind="secondary" small icon="plus" onClick={() => setEdit('new')}>
          {t('presets.add')}
        </Button>
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div style={{ padding: '0 24px 24px' }}>
          <Skel h={120} />
        </div>
      ) : list.length === 0 ? (
        <p className="muted" style={{ padding: '0 24px 24px' }}>
          {t('presets.empty')}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="dt compact dt-cards set-presets">
            <thead>
              <tr>
                <th style={{ width: 96 }}>{t('presets.col.order')}</th>
                <th>{t('presets.col.name')}</th>
                <th className="r">{t('presets.col.length')}</th>
                <th className="r">{t('presets.col.width')}</th>
                <th className="r">{t('presets.col.height')}</th>
                <th className="r">{t('presets.col.desi')}</th>
                <th>{t('presets.col.status')}</th>
                <th>
                  <span className="sr-only">{t('presets.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.6 }}>
                  <td data-label={t('presets.col.order')} className="set-order">
                    <span className="row" style={{ gap: 0 }}>
                      <Button kind="plain" small icon="up" aria-label={t('presets.moveUp', { name: p.name })} disabled={i === 0 || move.isPending} onClick={() => move.mutate({ list, from: i, to: i - 1 })} />
                      <Button
                        kind="plain"
                        small
                        icon="down"
                        aria-label={t('presets.moveDown', { name: p.name })}
                        disabled={i === list.length - 1 || move.isPending}
                        onClick={() => move.mutate({ list, from: i, to: i + 1 })}
                      />
                    </span>
                  </td>
                  <td className="sb card-title">{p.name}</td>
                  <td data-label={t('presets.col.length')} className="r num">{fmtNum(p.lengthCm, 0, 1)} cm</td>
                  <td data-label={t('presets.col.width')} className="r num">{fmtNum(p.widthCm, 0, 1)} cm</td>
                  <td data-label={t('presets.col.height')} className="r num">{fmtNum(p.heightCm, 0, 1)} cm</td>
                  <td data-label={t('presets.col.desi')} className="r num">{fmtNum(desiOf(p.lengthCm, p.widthCm, p.heightCm, 3000), 0, 2)}</td>
                  <td data-label={t('presets.col.status')}>
                    <label className="check">
                      <input type="checkbox" checked={p.active} onChange={() => toggle.mutate(p)} />
                      {p.active ? t('presets.active') : t('presets.inactive')}
                    </label>
                  </td>
                  <td className="actions">
                    <span className="row" style={{ gap: 0 }}>
                      <Button kind="plain" small icon="edit" aria-label={t('presets.edit', { name: p.name })} onClick={() => setEdit(p)} />
                      <Button kind="plain" small icon="trash" aria-label={t('presets.delete', { name: p.name })} onClick={() => setDel(p)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <PresetModal preset={edit === 'new' ? null : edit} nextOrder={list.length} onClose={() => setEdit(null)} />}
      {del && (
        <Modal
          label={t('presets.modal.label')}
          title={t('presets.modal.deleteTitle', { name: del.name })}
          onClose={() => setDel(null)}
          busy={remove.isPending}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setDel(null)}>
                {t('common.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={remove.isPending} onClick={() => remove.mutate(del.id)}>
                {t('common.delete')}
              </ModalAction>
            </>
          }
        >
          <p>{t('presets.modal.deleteBody')}</p>
        </Modal>
      )}
    </Card>
  );
}

function PresetModal({ preset, nextOrder, onClose }: { preset: BoxPreset | null; nextOrder: number; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [f, setF] = useState<PresetDraft>({
    name: preset?.name ?? `K${nextOrder + 1}`,
    l: numToInput(preset?.lengthCm, 1),
    w: numToInput(preset?.widthCm, 1),
    h: numToInput(preset?.heightCm, 1),
  });
  const [touched, setTouched] = useState(false);
  const pos = (s: string) => (parseMeasure(s) ?? 0) > 0;
  const errs = { name: !f.name.trim() ? t('presets.errors.nameRequired') : null, l: pos(f.l) ? null : t('presets.errors.required'), w: pos(f.w) ? null : t('presets.errors.required'), h: pos(f.h) ? null : t('presets.errors.required') };
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), lengthCm: parseMeasure(f.l)!, widthCm: parseMeasure(f.w)!, heightCm: parseMeasure(f.h)! };
      return preset ? boxPresets.update(preset.id, body) : boxPresets.create({ ...body, sortOrder: nextOrder, active: true });
    },
    onSuccess: () => {
      toast.ok(preset ? t('presets.toast.updated') : t('presets.toast.added'), f.name);
      qc.invalidateQueries({ queryKey: ['box-presets'] });
      onClose();
    },
  });
  return (
    <Modal
      label={t('presets.modal.label')}
      title={preset ? t('presets.modal.editTitle', { name: preset.name }) : t('presets.add')}
      onClose={onClose}
      busy={m.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            loading={m.isPending}
            onClick={() => {
              setTouched(true);
              if (!Object.values(errs).some(Boolean)) m.mutate();
            }}
          >
            {t('common.save')}
          </ModalAction>
        </>
      }
    >
      <div className="form-stack">
        <Field label={t('presets.col.name')} htmlFor="p-n" className="req" error={touched ? errs.name : null}>
          <input id="p-n" className="inp w-md" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="set-dims">
          <Field label={t('presets.col.length')} htmlFor="p-l" error={touched ? errs.l : null}>
            <Affix sfx="cm" className="set-unit">
              <input id="p-l" data-measure className="inp num" inputMode="decimal" value={f.l} onChange={(e) => setF({ ...f, l: e.target.value })} />
            </Affix>
          </Field>
          <Field label={t('presets.col.width')} htmlFor="p-w" error={touched ? errs.w : null}>
            <Affix sfx="cm" className="set-unit">
              <input id="p-w" data-measure className="inp num" inputMode="decimal" value={f.w} onChange={(e) => setF({ ...f, w: e.target.value })} />
            </Affix>
          </Field>
          <Field label={t('presets.col.height')} htmlFor="p-h" error={touched ? errs.h : null}>
            <Affix sfx="cm" className="set-unit">
              <input id="p-h" data-measure className="inp num" inputMode="decimal" value={f.h} onChange={(e) => setF({ ...f, h: e.target.value })} />
            </Affix>
          </Field>
        </div>
      </div>
      <p className="s12 muted mt8">
        <Icon name="info" /> {t('presets.col.desi')}:{' '}
        {pos(f.l) && pos(f.w) && pos(f.h) ? fmtNum(desiOf(parseMeasure(f.l)!, parseMeasure(f.w)!, parseMeasure(f.h)!, 3000), 0, 2) : '—'}
      </p>
    </Modal>
  );
}
