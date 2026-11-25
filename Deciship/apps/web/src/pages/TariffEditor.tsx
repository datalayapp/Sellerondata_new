import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageTitle } from '../components/Brand';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { carriers, tariffs } from '../api/endpoints';
import type { Tariff, TariffBody, TariffImportApplyResult, TariffSaveResult, TariffVersion } from '../api/types';
import { ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import { useAuth, usePermission } from '../auth/AuthContext';
import { firmCurrency } from '../lib/currency';
import { toast } from '../components/Toast';
import { ErrorState, Field, PageHeader, Skel, Tag, errorMessage } from '../components/ui';
import { hasSavedNotice } from './tariff-editor/noticeInvoices';
import i18next from 'i18next';
import { fmtNum, getFormatLocale, parseTrNumber } from '../lib/format';
import { useLeaveGuard } from '../components/LeaveGuard';
import { useReturnTo } from '../lib/returnTo';
import { ReturnBar } from '../components/ReturnBar';
import { RecordNotFound, isRecordId, isRecordMissing } from '../components/RecordNotFound';
import { defaultFuelVariable, withCarrier } from './tariff-editor/draft';
import { GeneralSection, PricingSection, WeightSection } from './tariff-editor/BasicSections';
import { fromTariff, incomingTariff, newDraft, relocalizeDraft, toBody, type AfterImportCheck, type CreatedState, type Draft, type Notice } from './tariff-editor/draft';
import { ImportBox } from './tariff-editor/ImportBox';
import { ErrorList, ImportNotice, RestoreConfirm, SaveBar, StaleNotice } from './tariff-editor/PageParts';
import { QuoteBox } from './tariff-editor/QuoteBox';
import { RateGrid } from './tariff-editor/RateGrid';
import { PackagingRatesSection } from './tariff-editor/PackagingRates';
import { VersionsSection } from './tariff-editor/VersionsSection';
import { SurchargesSection, ZonesSection } from './tariff-editor/ZonesSurcharges';
import { CountryAdjustmentsSection } from './tariff-editor/CountryAdjustments';
import { TariffReadOnly } from './tariff-editor/Sec';
import { BulkBand } from './invoice-detail/BulkBand';
import { useRecalcFlow } from './invoice-detail/RecalcDialog';

export function TariffEditorPage() {
  const { t: tr } = useTranslation('tariffEditor');
  const { id } = useParams();
  const isNew = !id;
  const canEdit = usePermission('deciship.tariffs.edit');
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  const createdState = (loc.state as CreatedState | null)?.created;
  // kurulum sihirbazı: ?donus= kayıttan sonra da korunur, ?elle=1 elle girişi açık getirir
  const ret = useReturnTo();
  const [manual, setManual] = useState(sp.get('elle') === '1');
  const qc = useQueryClient();
  const cs = useQuery({ queryKey: ['carriers'], queryFn: carriers.list });
  const validId = isNew || isRecordId(id);
  const tq = useQuery({ queryKey: ['tariff', id], queryFn: () => tariffs.get(id!), enabled: !isNew && validId });
  usePageTitle(tq.data?.name);
  const { me } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [showErrors, setShowErrors] = useState(false);
  // 10-B17: taslağın dayandığı sunucu hâli (kayıtta `expectedUpdatedAt`) ve taslak açıkken başka yerde kaydedilen hâl
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | undefined>(undefined);
  const [remote, setRemote] = useState<Tariff | null>(null);
  const staleRef = useRef<HTMLDivElement>(null);
  const loadTariff = (t: Tariff) => {
    const d = fromTariff(t);
    setDraft(d);
    setBaseline(JSON.stringify(d));
    setBaseUpdatedAt(t.updatedAt);
    setRemote(null);
  };

  useEffect(() => {
    if (isNew && !draft) {
      const d = newDraft(sp.get('carrierId') ?? '', firmCurrency(me));
      setDraft(d);
      setBaseline(JSON.stringify(d));
    }
  }, [isNew, draft, sp, me]);
  // K36: arayüz dili değişince ekrandaki taslak (ve dokunulmamışlık tabanı) anlamını korur ("1,500" Türkçe 1,5 kg kalır)
  useEffect(() => {
    let prev = getFormatLocale();
    const onLang = () => {
      const next = getFormatLocale();
      if (next === prev) return;
      const from = prev;
      prev = next;
      setDraft((d) => (d ? relocalizeDraft(d, from, next) : d));
      setBaseline((b) => (b ? JSON.stringify(relocalizeDraft(JSON.parse(b) as Draft, from, next)) : b));
    };
    i18next.on('languageChanged', onLang);
    return () => i18next.off('languageChanged', onLang);
  }, []);
  // 19-B15: karşılaştırma yalnız taslak ya da taban değişince (her çizimde değil)
  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== baseline, [draft, baseline]);
  // Sunucudaki hâl yeniden okununca (yeniden bağlanma, başka sayfanın geçersizlemesi, 409 sonrası) kaydedilmemiş taslak ezilmez.
  useEffect(() => {
    if (!tq.data) return;
    const next = incomingTariff({ dirty, baseUpdatedAt }, tq.data);
    if (next === 'load') loadTariff(tq.data);
    else if (next === 'remote') setRemote(tq.data);
    // yalnız yeni sunucu verisinde karar verilir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tq.data]);
  useEffect(() => {
    // yeni tarife: taşıyıcı (adresteki ya da ilk) ve onun kapsamının bölen + yakıtı (KALANLAR 1.1), taşıyıcılar yüklenince bir kez
    if (isNew && draft && draft.scope === undefined && cs.data?.length) {
      const carrier = cs.data.find((c) => c.id === draft.carrierId) ?? cs.data[0];
      const d = withCarrier(draft, carrier);
      setDraft(d);
      // otomatik seçilen taşıyıcı kullanıcı değişikliği sayılmaz (dokunulmamış taslak temiz kalır)
      if (JSON.stringify(draft) === baseline) setBaseline(JSON.stringify(d));
    }
  }, [isNew, draft, cs.data, baseline]);

  // değişiklikler geri alındıysa kaybolacak bir şey yok: güncel hâl yüklenir
  useEffect(() => {
    if (remote && !dirty) loadTariff(remote);
  }, [remote, dirty]);
  useEffect(() => {
    if (remote) setTimeout(() => staleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  }, [remote]);
  const { body, errors } = useMemo(() => (draft ? toBody(draft) : { body: null, errors: [] }), [draft]);

  const { dialog: leaveDialog, release: allowNav } = useLeaveGuard(dirty, {
    label: tr('leave.label'),
    title: tr('leave.title'),
    body: tr('leave.body'),
    stay: tr('leave.stay'),
    leave: tr('leave.leave'),
  });

  const save = useMutation({
    // expected: taslağın dayandığı sunucu anı ("Yine de kaydet"te bilerek görülen son hâlin anı)
    mutationFn: async ({ body: b, expected }: { body: TariffBody; expected?: string }): Promise<TariffSaveResult> =>
      isNew ? { tariff: await tariffs.create(b), affectedInvoices: 0, otherInvoices: 0 } : tariffs.replace(id!, b, expected),
    onSuccess: ({ tariff: t, affectedInvoices, otherInvoices }) => {
      toast.ok(tr('page.saved'), tr('page.savedBody'));
      qc.invalidateQueries({ queryKey: ['tariffs'] });
      qc.invalidateQueries({ queryKey: ['tariff-versions', t.id] });
      loadTariff(t);
      qc.setQueryData(['tariff', t.id], t);
      setShowErrors(false);
      // Bu tarifeyle fiyatlanan fatura eski fiyatta kaldı: öneri; başka tarifeyle fiyatlanan varsa onu değiştirmediği söylenir. İkisi de yoksa toast yeter.
      if (hasSavedNotice({ affectedInvoices, otherInvoices })) {
        setNotice({ kind: 'saved', versionId: null, affected: affectedInvoices, other: otherInvoices });
        // Kayıt çoğu zaman sayfanın aşağısından yapılır; "N fatura eski tarifeyle duruyor" sorusu üstte görünmeden kalmasın
        if (!isNew) setTimeout(() => noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
      }
      if (isNew) {
        allowNav();
        nav(ret.keep(`/tariffs/${t.id}`), { replace: true });
      }
    },
    onError: (e) => {
      // 409 STALE: tarife siz bakarken değişti. Güncel hâl okunur; taslak durur, bant ne yapılacağını sorar.
      if (e instanceof ApiError && e.code === 'STALE') void qc.invalidateQueries({ queryKey: ['tariff', id] });
    },
  });

  // ---- import / restore: the server keeps the previous state as a version ----
  const [notice, setNotice] = useState<Notice | null>(() =>
    createdState ? { kind: 'created', versionId: null, affected: createdState.affected, other: createdState.other, fileName: createdState.fileName } : null,
  );
  // "created" notice comes via history state (yeni → :id reuses this component, so read it on every navigation),
  // then drop it so a reload does not show it again
  useEffect(() => {
    if (!createdState) return;
    setNotice({ kind: 'created', versionId: null, affected: createdState.affected, other: createdState.other, fileName: createdState.fileName });
    setManual(false);
    nav(loc.pathname + loc.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.key]);
  const [confirmV, setConfirmV] = useState<TariffVersion | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onReplaced = (r: TariffImportApplyResult, kind: 'import' | 'restore', undo = false, check?: AfterImportCheck) => {
    loadTariff(r.tariff);
    qc.setQueryData(['tariff', id], r.tariff);
    qc.invalidateQueries({ queryKey: ['tariffs'] });
    qc.invalidateQueries({ queryKey: ['tariff-versions', id] });
    setShowErrors(false);
    setNotice({ kind, versionId: r.versionId, affected: r.affectedInvoices, other: r.otherInvoices, check });
    const vid = r.versionId;
    toast.ok(
      tr(undo ? 'page.undone' : kind === 'import' ? 'page.imported' : 'page.restored'),
      tr(vid ? 'page.rateRowsKept' : 'page.rateRows', { count: r.tariff.rates.length, formatted: fmtNum(r.tariff.rates.length) }),
      vid ? { action: { label: tr('notice.undo'), onClick: () => restore.mutate({ versionId: vid, undo: true }) } } : undefined,
    );
    setTimeout(() => noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };
  const restore = useMutation({
    mutationFn: (v: { versionId: string; undo?: boolean }) => tariffs.restoreVersion(id!, v.versionId),
    onSuccess: (r, v) => {
      setConfirmV(null);
      onReplaced(r, 'restore', v.undo);
    },
    onError: (e) => toast.err(tr('page.restoreFailed'), errorMessage(e)),
  });
  // Mesaj 4: eski faturalar hesaplandığı günkü tarifeyle durur; geçirmek toplu önce/sonra penceresiyle (onaydan sonra yazılır)
  const recalc = useRecalcFlow({
    onApplied: (r) => {
      if (r.kind === 'bulk') setNotice((n) => (n ? { ...n, recompared: r.result } : n));
    },
  });

  const onImported = (r: TariffImportApplyResult, ctx: { fileName: string; check?: AfterImportCheck }) => {
    if (isNew) {
      // new-tariff page: open the tariff that was just created
      qc.invalidateQueries({ queryKey: ['tariffs'] });
      qc.setQueryData(['tariff', r.tariff.id], r.tariff);
      allowNav();
      const st: CreatedState = { created: { fileName: ctx.fileName, affected: r.affectedInvoices, other: r.otherInvoices } };
      nav(ret.keep(`/tariffs/${r.tariff.id}`), { state: st });
      return;
    }
    onReplaced(r, 'import', false, ctx.check);
  };

  const submit = (expected = baseUpdatedAt) => {
    setShowErrors(true);
    if (body) save.mutate({ body, expected });
    else {
      toast.err(tr('page.saveFailed'), errors[0]);
      // bring the error list into view (it renders on this state change)
      setTimeout(() => {
        errBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        errBoxRef.current?.focus({ preventScroll: true });
      }, 0);
    }
  };
  const errBoxRef = useRef<HTMLDivElement>(null);

  if (!validId || (!isNew && tq.isError)) {
    return (
      <>
        <PageHeader title={tr('page.titleSingle')} crumbs={<Link to="/tariffs">{tr('page.crumb')}</Link>} />
        <div className="content">
          {!validId || isRecordMissing(tq.error) ? <RecordNotFound backTo="/tariffs" backLabel={tr('page.backToList')} /> : <ErrorState error={tq.error} onRetry={() => tq.refetch()} />}
        </div>
      </>
    );
  }

  const carrierName = cs.data?.find((c) => c.id === draft?.carrierId)?.name;
  const set = (patch: Partial<Draft>) => draft && setDraft({ ...draft, ...patch });
  const backTo = draft?.carrierId ? `/tariffs?carrier=${draft.carrierId}` : '/tariffs';
  const errCount = showErrors ? errors.length : 0;

  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to={backTo}>{tr('page.crumb')}</Link>
            <span className="sep">/</span>
            <span>{carrierName ?? '…'}</span>
          </>
        }
        title={
          isNew ? (
            tr('page.newTitle')
          ) : draft ? (
            <>
              <span>{draft.name || tr('page.untitled')}</span>
              <span className="tags te-title-tags">
                {draft.active ? <Tag tone="green">{tr('page.active')}</Tag> : <Tag tone="gray">{tr('page.inactive')}</Tag>}
                {draft.isDefault && <Tag tone="blue">{tr('general.default')}</Tag>}
                {!canEdit && <Tag tone="gray">{tr('page.readOnly')}</Tag>}
              </span>
            </>
          ) : (
            <Skel w={280} h={32} />
          )
        }
        sub={tr(isNew ? 'page.subNew' : canEdit ? 'page.subEdit' : 'page.subView')}
      />
      <div className="content te">
        <ReturnBar hint={tr('page.returnHint')} />
        {!draft ? (
          <div className="col">
            <Skel h={160} />
            <Skel h={320} />
          </div>
        ) : (
          <>
            {isNew && (
              <>
                <ImportBox
                  variant="create"
                  carrierId={draft.carrierId}
                  carrierPicker={
                    <Field label={tr('general.carrier')} htmlFor="cr-car" className="req imp-car">
                      <select
                        id="cr-car"
                        className="sel w-lg"
                        value={draft.carrierId}
                        onChange={(e) => {
                          // bütün taşıyıcı değişimleri kapsamdan geçer (bölen + yakıt; elle değiştirilen korunur, KALANLAR 1.1)
                          const c = cs.data?.find((x) => x.id === e.target.value);
                          const n = c ? withCarrier(draft, c) : { ...draft, carrierId: e.target.value };
                          setDraft(n);
                          if (!dirty) setBaseline(JSON.stringify(n));
                        }}
                      >
                        {!draft.carrierId && <option value="">{tr('general.select')}</option>}
                        {(cs.data ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  }
                  dirty={false}
                  current={{ name: '', service: null, validFrom: null, validTo: null, currency: draft.currency }}
                  onApplied={onImported}
                />
                <div className="te-or">
                  <span className="te-or-line" aria-hidden="true" />
                  <button type="button" className="te-or-btn" aria-expanded={manual} onClick={() => setManual(!manual)}>
                    {tr(manual ? 'page.hideManual' : 'page.orManual')} <Icon name={manual ? 'up' : 'down'} size={14} />
                  </button>
                  <span className="te-or-line" aria-hidden="true" />
                </div>
              </>
            )}
            {(!isNew || manual) && (
            <>
            <TariffReadOnly.Provider value={!canEdit}>
            <div className={`editor-layout lift${canEdit ? '' : ' te-view'}`}>
              <div className="te-main">
                {!isNew && (
                  <BulkBand
                    refType="Tariff"
                    refId={id}
                    ns="tariffEditor"
                    onStale={(r) => id && recalc.showStale({ kind: 'tariff', tariffId: id, tariffName: draft.name }, r)}
                  />
                )}
                {remote && canEdit && (
                  <StaleNotice boxRef={staleRef} saving={save.isPending} onReload={() => loadTariff(remote)} onOverwrite={() => submit(remote.updatedAt)} />
                )}
                {notice && (
                  <ImportNotice
                    notice={notice}
                    noticeRef={noticeRef}
                    recomparing={recalc.busy}
                    onRecompare={() => id && recalc.start({ kind: 'tariff', tariffId: id, tariffName: draft.name })}
                    undoing={restore.isPending}
                    onUndo={(versionId) => restore.mutate({ versionId, undo: true })}
                    onClose={() => setNotice(null)}
                  />
                )}
                {showErrors && errors.length > 0 && <ErrorList errors={errors} boxRef={errBoxRef} />}
                <fieldset className={`ds-ro te-main${canEdit ? '' : ' te-ro'}`} disabled={!canEdit}>
                <GeneralSection d={draft} set={set} carriers={cs.data ?? []} isNew={isNew} />
                <WeightSection d={draft} set={set} />
                <PricingSection d={draft} set={set} fuelDefault={defaultFuelVariable(cs.data?.find((c) => c.id === draft.carrierId))} />
                <RateGrid d={draft} setDraft={setDraft} />
                <PackagingRatesSection d={draft} set={set} carrier={cs.data?.find((c) => c.id === draft.carrierId)?.code} />
                <ZonesSection d={draft} set={set} />
                <SurchargesSection d={draft} set={set} />
                <CountryAdjustmentsSection d={draft} set={set} />
                </fieldset>
                {!isNew && id && <VersionsSection tariffId={id} busyId={restore.isPending ? restore.variables?.versionId : undefined} onRestore={setConfirmV} />}
              </div>
              <aside className="te-side sticky-side" aria-label={tr('page.tools')}>
                <QuoteBox tariffId={id} dirty={dirty} currency={draft.currency} />
                {canEdit && !isNew && (
                  <ImportBox
                    variant="side"
                    tariffId={id}
                    carrierId={draft.carrierId}
                    dirty={dirty}
                    current={{
                      name: draft.name,
                      service: draft.service.trim() || null,
                      validFrom: draft.validFrom || null,
                      validTo: draft.validTo || null,
                      currency: draft.currency,
                      fuelPct: parseTrNumber(draft.fuelPct) ?? 0,
                      divisor: parseTrNumber(draft.divisor) ?? undefined,
                    }}
                    onApplied={onImported}
                  />
                )}
              </aside>
            </div>
            </TariffReadOnly.Provider>
            {/* Kayıtlı tarifede değişiklik yokken çubuk gizli (Ayarlar ile aynı kural); yeni tarifede, değişiklikte ve hatada görünür. */}
            {canEdit && (isNew || dirty || errCount > 0) && <SaveBar dirty={dirty} isNew={isNew} errCount={errCount} backTo={backTo} saving={save.isPending} canSave={Boolean(draft) && (isNew || dirty)} onSave={() => submit()} />}
            </>
            )}
          </>
        )}
      </div>
      {confirmV && (
        <RestoreConfirm
          version={confirmV}
          dirty={dirty}
          loading={restore.isPending}
          onCancel={() => setConfirmV(null)}
          onConfirm={() => restore.mutate({ versionId: confirmV.id })}
        />
      )}
      {recalc.dialog}
      {leaveDialog}
    </>
  );
}
