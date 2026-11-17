import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { jobs, tariffImports } from '../api/endpoints';
import type { AiTariffReview, ImportFix, ImportIssue, ImportMeta, ImportOptions, TariffImportApplyResult, TariffImportDraft } from '../api/types';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import { Modal, ModalAction, errorMessage } from '../components/ui';
import { fmtNum, numToInput, parseTrNumber } from '../lib/format';
import { relocalizeFields, useLocaleSwitch } from '../lib/localeSwitch';
import { headlineOf } from '../lib/importHeadline';
import { JobLeft, JobStopped, waitJob } from '../lib/waitJob';
import { AiPanel } from './tariff-import/AiPanel';
import { ChecksDetail, ComparisonDetail, DocInfoRow, NewTariffFields, PdfSourceDetail, PricePreview, type NewForm } from './tariff-import/Sections';
import { isExpired, isOutlier, optsKey, type AiState } from './tariff-import/shared';

// Kontrol ekranı: önce özet, ayrıntılar kapalı; yapay zekâ yalnız istenince.
// Parçalar tariff-import/ altında (Sections: form ve ayrıntı bölümleri, AiPanel, shared: ortak yardımcılar).

/** Tarifenin içe aktarma öncesi bilgileri (editördeki değerler). */
export interface CurrentMeta {
  name: string;
  service: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** tarifenin şu anki para birimi */
  currency: string;
  fuelPct?: number;
  divisor?: number;
  /** yeni tarifenin yakıt türü önerisi (taşıyıcının kapsamı; KALANLAR 1.1) */
  fuelVariable?: boolean;
}

export function TariffImportWizard({
  initial,
  dirty,
  current,
  onClose,
  onBack,
  onApplied,
  newTariff = false,
  suggestedName,
}: {
  initial: TariffImportDraft;
  dirty: boolean;
  current: CurrentMeta;
  onClose: () => void;
  /** PDF: "Tablolara dön" */
  onBack?: () => void;
  /** `checks`: the checks of the preview that was applied (follow-up hints after import) */
  onApplied: (r: TariffImportApplyResult, checks: ImportIssue[]) => void;
  /** taslak yeni bir tarife oluşturur */
  newTariff?: boolean;
  /** yeni tarife adı önerisi (ör. PDF'teki taşıyıcı + hizmet) */
  suggestedName?: string;
}) {
  const { t } = useTranslation('tariffImport');
  const isNew = newTariff || initial.target?.kind === 'new';
  const [draft, setDraft] = useState(initial);
  /** options the current `draft` was checked with */
  const [applied, setApplied] = useState<ImportOptions>({});
  /** options shown in the toggles (may be ahead of `applied` while rechecking) */
  const [opts, setOpts] = useState<ImportOptions>({});
  const [allFixes, setKnownFixes] = useState<ImportFix[]>(initial.fixes);
  // new tariff: the currency field below already does what "setCurrency" does
  const knownFixes = isNew ? allFixes.filter((f) => f.id !== 'setCurrency') : allFixes;
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [ackForced, setAckForced] = useState(false);

  // ---- AI review: only on demand ----
  const [ai, setAi] = useState<AiState>({ s: 'idle' });
  const aiSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // KALANLAR 6.18: inceleme arka plan işidir (202); sonuç ve hata yoklamayla gelir, "Durdur" ile vazgeçilir
  const runAi = () => {
    const key = optsKey(applied);
    const n = ++aiSeq.current;
    const live = () => n === aiSeq.current && mountedRef.current;
    setAi({ s: 'loading' });
    (async (): Promise<AiTariffReview> => {
      const started = await tariffImports.review(draft.draftId, applied);
      if ('review' in started) return started.review;
      return (await waitJob(started.job, { get: jobs.get, alive: live, onUpdate: (job, at) => live() && setAi({ s: 'loading', job, at }) })) as AiTariffReview;
    })().then(
      (r) => n === aiSeq.current && setAi({ s: 'done', r, key }),
      (e) => {
        if (n !== aiSeq.current || e instanceof JobLeft) return;
        if (e instanceof JobStopped) return setAi({ s: 'idle' });
        if (isExpired(e)) setExpired(true);
        setAi(e instanceof ApiError && e.code === 'AI_DISABLED' ? { s: 'off' } : { s: 'error', e });
      },
    );
  };
  const stopAi = () => {
    if (ai.s !== 'loading' || !ai.job) return;
    const n = aiSeq.current;
    jobs.cancel(ai.job.id).then(
      (job) => n === aiSeq.current && setAi((cur) => (cur.s === 'loading' && cur.job?.id === job.id ? { ...cur, job, at: Date.now() } : cur)),
      () => undefined, // iş bu arada bitti: gerçek durum yoklamayla gelir
    );
  };
  const aiCurrent = ai.s === 'done' && ai.key === optsKey(applied);
  const strong = aiCurrent && ai.r.verdict === 'reject';

  const recheck = useMutation({
    mutationFn: (o: ImportOptions) => tariffImports.recheck(draft.draftId, o),
    onSuccess: (d, o) => {
      setDraft(d);
      setApplied(o);
      // numberFormat / discountUnit: same id, two values (one of them is chosen)
      setKnownFixes((prev) => [...prev, ...d.fixes.filter((f) => !prev.some((p) => p.id === f.id && p.value === f.value))]);
      setApplyErr(null);
    },
    onError: (e) => {
      setOpts(applied);
      if (isExpired(e)) setExpired(true);
      else toast.err(t('wizard.recheckFailed'), errorMessage(e));
    },
  });
  const changeOpts = (next: ImportOptions) => {
    setOpts(next);
    recheck.mutate(next);
  };
  const toggleFix = (f: ImportFix, on: boolean) => {
    const next: ImportOptions = { ...opts };
    if (f.id === 'convertLbToKg') next.convertLbToKg = on || undefined;
    if (f.id === 'setCurrency') next.currency = on ? f.value : undefined;
    if (f.id === 'numberFormat') next.numberFormat = on ? (f.value as ImportOptions['numberFormat']) : undefined;
    if (f.id === 'discountUnit') next.discountUnit = on ? (f.value as ImportOptions['discountUnit']) : undefined;
    if (f.id === 'openBandMode') next.openBandMode = on ? (f.value as ImportOptions['openBandMode']) : undefined;
    changeOpts(next);
  };
  const fixOn = (f: ImportFix) =>
    f.id === 'convertLbToKg'
      ? Boolean(opts.convertLbToKg)
      : f.id === 'numberFormat'
        ? opts.numberFormat === f.value
        : f.id === 'discountUnit'
          ? opts.discountUnit === f.value
          : f.id === 'openBandMode'
            ? opts.openBandMode === f.value
            : Boolean(opts.currency && opts.currency === f.value);

  // ---- new tariff: info fields · existing: accept values found in the document ----
  const sm = draft.suggestedMeta ?? {};
  const [form, setForm] = useState<NewForm>(() => ({
    name: current.name || suggestedName || '',
    service: current.service ?? '',
    validFrom: (current.validFrom ?? sm.validFrom ?? '').slice(0, 10),
    discountPct: sm.discountPct != null ? numToInput(sm.discountPct) : '',
    fuelPct: current.fuelPct != null ? numToInput(current.fuelPct) : sm.fuelPct != null ? numToInput(sm.fuelPct) : '',
    divisor: numToInput(current.divisor ?? initial.suggestedDefaults?.divisor ?? 5000),
    fuelMode: (current.fuelVariable ?? initial.suggestedDefaults?.fuelVariable ?? true) ? 'variable' : 'fixed',
  }));
  // K36 incelemesi: arayüz dili değişince yazılmış sayılar anlamını korur (Türkçe "6.000" İngilizcede 6 olmasın)
  useLocaleSwitch((from, to) => setForm((f) => relocalizeFields(f, ['discountPct', 'fuelPct', 'divisor'], [], from, to)));
  const touched = useRef(new Set<keyof NewForm>());
  const edit = (k: keyof NewForm, v: string) => {
    touched.current.add(k);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const discountNum = parseTrNumber(form.discountPct);
  const discountBad = isNew && form.discountPct.trim() !== '' && (discountNum === null || discountNum < 0 || discountNum > 100);
  // Kişi oranı yazdı: "Dosyada indirim yok" uyarısının sorduğu şey yanıtlandı, onay istenmez
  const discountGiven = isNew && discountNum !== null && !discountBad;
  const checks = discountGiven ? draft.checks.filter((c) => c.code !== 'NO_DISCOUNT') : draft.checks;
  const answeredDiscount = checks.length !== draft.checks.length;

  // ---- derived ----
  // eski sunucu headline göndermezse aynı mantık burada kurulur
  const head =
    (answeredDiscount ? undefined : draft.headline) ??
    headlineOf(checks, {
      canApply: draft.canApply,
      okLines: [
        t('wizard.okLine', {
          weights: t('units.weights', { count: draft.summary.weightCount, formatted: fmtNum(draft.summary.weightCount) }),
          zones: t('units.zones', { count: draft.summary.zoneCount, formatted: fmtNum(draft.summary.zoneCount) }),
        }),
      ],
    });
  const errors = checks.filter((c) => c.severity === 'error');
  const warnings = checks.filter((c) => c.severity === 'warning');
  const infos = checks.filter((c) => c.severity === 'info');
  const blocked = head.status === 'error' || errors.length > 0 || !draft.canApply;
  const outliers = (isNew ? [] : (draft.comparison ?? [])).filter((c) => isOutlier(c.ratio));
  const s = draft.summary;
  const tariffCur = s.tariffCurrency || applied.currency || current.currency;
  const unit = applied.convertLbToKg ? 'kg' : (s.detectedWeightUnit ?? 'kg');

  // ---- ack: code warnings, or an AI review (current options) that is not "ok" ----
  const reasons: string[] = [];
  if (warnings.length) reasons.push(t('wizard.reasons.warnings', { count: warnings.length, formatted: fmtNum(warnings.length) }));
  if (aiCurrent && ai.r.verdict === 'caution') reasons.push(t('wizard.reasons.aiCaution'));
  if (strong) reasons.push(t('wizard.reasons.aiReject'));
  if (ackForced && !reasons.length) reasons.push(t('wizard.reasons.serverAsked'));
  const needAck = reasons.length > 0;
  const [ack, setAck] = useState(false);
  const ackKey = `${reasons.join('|')}`;
  useEffect(() => setAck(false), [ackKey]);

  // AI suggestion fills the empty name/service once (user edits win)
  useEffect(() => {
    if (!isNew || ai.s !== 'done' || !ai.r.identity) return;
    const id = ai.r.identity;
    setForm((f) => ({
      ...f,
      name: !touched.current.has('name') && !f.name.trim() && id.suggestedName ? id.suggestedName : f.name,
      service: !touched.current.has('service') && !f.service.trim() && id.suggestedService ? id.suggestedService : f.service,
    }));
  }, [isNew, ai]);
  const [take, setTake] = useState<{ fuel: boolean; from: boolean; service: boolean }>({ fuel: false, from: false, service: false });
  const docFuel = !isNew && sm.fuelPct != null && sm.fuelPct !== (current.fuelPct ?? 0) ? sm.fuelPct : null;
  const docService = !isNew && sm.service && sm.service.trim().toLocaleLowerCase('tr') !== (current.service ?? '').trim().toLocaleLowerCase('tr') ? sm.service.trim() : null;
  const docFrom = !isNew && sm.validFrom && sm.validFrom.slice(0, 10) !== (current.validFrom ?? '').slice(0, 10) ? sm.validFrom.slice(0, 10) : null;

  const fuelNum = parseTrNumber(form.fuelPct);
  const fuelBad = isNew && form.fuelPct.trim() !== '' && (fuelNum === null || fuelNum < 0 || fuelNum > 100);
  const divBad = isNew && !((parseTrNumber(form.divisor) ?? 0) > 0);
  const nameBad = isNew && !form.name.trim();
  // show the red field error only after the user has touched the name field
  const [nameTouched, setNameTouched] = useState(false);
  const nameErr = nameBad && nameTouched;
  const invalidForm = fuelBad || discountBad || divBad || nameBad;

  const meta = (): ImportMeta | undefined => {
    if (isNew) {
      const m: ImportMeta = { name: form.name.trim(), service: form.service.trim() || null, validFrom: form.validFrom || null, currency: tariffCur };
      const div = parseTrNumber(form.divisor);
      if (div) m.divisor = div;
      m.fuelVariable = form.fuelMode === 'variable';
      if (fuelNum !== null) m.fuelPct = fuelNum;
      if (discountNum !== null) m.discountPct = discountNum;
      return m;
    }
    const m: ImportMeta = {};
    if (take.fuel && docFuel != null) m.fuelPct = docFuel;
    if (take.from && docFrom) m.validFrom = docFrom;
    if (take.service && docService) m.service = docService;
    return Object.keys(m).length ? m : undefined;
  };

  const apply = useMutation({
    // Yazılan indirim oranı `meta` ile gider, sunucu NO_DISCOUNT uyarısını kendisi düşürür; kişinin vermediği onay gönderilmez
    mutationFn: () => tariffImports.apply(draft.draftId, applied, needAck ? ack : false, meta()),
    onSuccess: (r) => onApplied(r, checks),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'IMPORT_BLOCKED') {
        const checks = (e.details as { checks?: ImportIssue[] } | undefined)?.checks;
        if (checks) setDraft((d) => ({ ...d, checks, canApply: false, headline: undefined }));
        setApplyErr(t('wizard.err.blocked'));
      } else if (e instanceof ApiError && e.code === 'ACK_REQUIRED') {
        setAckForced(true);
        setApplyErr(t('wizard.err.ackRequired'));
      } else if (isExpired(e)) {
        setExpired(true);
        setApplyErr(null);
      } else setApplyErr(t('wizard.err.generic', { message: errorMessage(e) }));
    },
  });

  const why = expired
    ? t('wizard.why.expired')
    : blocked
      ? t(knownFixes.length ? 'wizard.why.blockedFixable' : 'wizard.why.blocked')
      : nameBad
        ? t('wizard.why.name')
        : divBad
          ? t('wizard.why.divisor')
          : fuelBad
            ? t('wizard.why.fuel')
            : recheck.isPending
              ? t('wizard.why.rechecking')
              : null;

  const priceCur = s.detectedCurrency ?? tariffCur;

  const aiOffered = draft.aiAvailable && ai.s !== 'off';
  const icon = head.status === 'ok' ? 'ok' : head.status === 'warning' ? 'warn' : 'err';

  return (
    <Modal
      busy={apply.isPending}
      dirty={Boolean(onBack) || ai.s === 'done'}
      label={draft.fileName}
      title={t(isNew ? 'wizard.titleNew' : 'wizard.titleImport')}
      size="wide"
      className="iw"
      onClose={onClose}
      actions={
        <>
          <div className="iw-foot">
            {needAck && !blocked && !expired && (
              <label className={`check iw-ack${strong ? ' strong' : ''}`}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  <b>{t(strong ? 'wizard.ackStrong' : 'wizard.ack')}</b>
                  <span className="iw-ack-why">{reasons.join(' · ')}</span>
                </span>
              </label>
            )}
            {why && (
              <p className={`iw-why${blocked || expired ? ' bad' : ''}`}>
                <Icon name={blocked || expired ? 'err' : 'info'} size={14} /> <span>{why}</span>
              </p>
            )}
          </div>
          <ModalAction kind="dark" onClick={onBack ?? onClose} disabled={apply.isPending}>
            {t(onBack ? 'wizard.backToTables' : 'wizard.cancel')}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            loading={apply.isPending}
            disabled={expired || blocked || invalidForm || recheck.isPending || (needAck && !ack)}
            title={why ?? (needAck && !ack ? t('wizard.ackFirst') : undefined)}
            onClick={() => {
              setApplyErr(null);
              apply.mutate();
            }}
          >
            {t(isNew ? 'wizard.create' : 'wizard.apply')}
          </ModalAction>
        </>
      }
    >
      {/* ---------- özet ---------- */}
      <section className={`iw-head ${head.status}`} aria-live="polite" data-autofocus tabIndex={-1}>
        <span className="iw-head-ic" aria-hidden="true">
          {recheck.isPending ? <Icon name="spin" className="spin" size={22} /> : <Icon name={icon} size={22} />}
        </span>
        <div className="grow">
          <h3 className="iw-head-t">{head.title}</h3>
          {head.lines.length > 0 && (
            <ul className="iw-head-l">
              {head.lines.slice(0, 3).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {knownFixes.length > 0 && (
        <div className="iw-fixes">
          {knownFixes.map((f) => (
            <label key={`${f.id}:${f.value ?? ''}`} className={`check iw-fix${fixOn(f) ? ' on' : ''}`}>
              <input type="checkbox" checked={fixOn(f)} disabled={recheck.isPending} onChange={(e) => toggleFix(f, e.target.checked)} />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      )}

      {expired && (
        <div className="notif err mt12" role="alert">
          <Icon name="err" />
          <span>
            <b>{t('wizard.why.expired')}</b> {t('wizard.expiredNote')}
          </span>
        </div>
      )}
      {applyErr && (
        <div className="notif err mt12" role="alert">
          <Icon name="err" />
          <span>{applyErr}</span>
        </div>
      )}
      {dirty && !isNew && <p className="iw-note">{t('wizard.dirtyNote')}</p>}

      {/* ---------- yapay zekâ: yalnız sorun varken öne çıkar ---------- */}
      {aiOffered && head.status !== 'ok' && ai.s === 'idle' && (
        <div className="iw-ai-ask">
          <button type="button" className="btn btn-secondary btn-sm" onClick={runAi}>
            <Icon name="spark" /> {t('wizard.aiAsk')}
          </button>
          <span className="iw-ai-why">{t('wizard.aiAskWhy')}</span>
        </div>
      )}
      <AiPanel ai={ai} stale={ai.s === 'done' && !aiCurrent} onRun={runAi} onStop={stopAi} onUseName={isNew ? (v) => edit('name', v) : undefined} />

      {/* ---------- yeni tarife bilgileri / belgedeki bilgiler ---------- */}
      {isNew ? (
        <NewTariffFields
          form={form}
          edit={edit}
          nameErr={nameErr}
          onNameTouched={() => setNameTouched(true)}
          divBad={divBad}
          fuelBad={fuelBad}
          discountBad={discountBad}
          tariffCur={tariffCur}
          curBusy={recheck.isPending}
          onCurrency={(c) => changeOpts({ ...opts, currency: c })}
        />
      ) : (
        (docFuel != null || docFrom || docService) && (
          <DocInfoRow current={current} docService={docService} docFuel={docFuel} docFrom={docFrom} take={take} setTake={setTake} />
        )
      )}

      {/* ---------- ayrıntılar: hepsi kapalı ---------- */}
      <div className="iw-details">
        <h3 className="iw-sec-h">{t('wizard.details')}</h3>
        <ChecksDetail open={head.status === 'error'} errors={errors} warnings={warnings} infos={infos} />

        <PricePreview draft={draft} unit={unit} priceCur={priceCur} />

        {!isNew && draft.comparison && draft.comparison.length > 0 && (
          <ComparisonDetail comparison={draft.comparison} outliers={outliers.length} currentCurrency={current.currency} priceCur={priceCur} />
        )}

        {draft.kind === 'pdf' && <PdfSourceDetail draft={draft} />}

        {aiOffered && head.status === 'ok' && ai.s === 'idle' && (
          <p className="iw-ai-quiet">
            <Trans t={t} i18nKey="wizard.aiQuiet" components={{ a: <button type="button" className="link-btn" onClick={runAi} /> }} />
          </p>
        )}
      </div>
    </Modal>
  );
}
