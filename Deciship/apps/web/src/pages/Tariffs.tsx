import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { carriers, tariffs } from '../api/endpoints';
import type { Carrier, CarrierCode, TariffSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { usePermission } from '../auth/AuthContext';
import { toast } from '../components/Toast';
import { Affix, Button, Empty, ErrorState, Field, Modal, ModalAction, PageHeader, Skel, TableSkeleton, Tag, errorMessage, rowProps } from '../components/ui';
import { fmtDate, fmtNum, fmtPct } from '../lib/format';
import { RowMenu } from './tariff-editor/RowMenu';
import { CARRIER_OPTIONS, carrierKind } from '../lib/labels';
import { packagingName } from '../lib/packaging';
import { defaultLimits, limitsForm, limitsFromForm, type LimitsForm } from '../lib/packagingLimits';

export function TariffsPage() {
  const { t: tr, i18n } = useTranslation('tariffs');
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const canEdit = usePermission('deciship.tariffs.edit');
  const canManageCarriers = usePermission('deciship.settings.manage');
  const cs = useQuery({ queryKey: ['carriers'], queryFn: carriers.list });
  const list = cs.data ?? [];
  const carrierId = sp.get('carrier') ?? list[0]?.id ?? '';
  const carrier = list.find((c) => c.id === carrierId) ?? null;
  const ts = useQuery({ queryKey: ['tariffs', carrierId], queryFn: () => tariffs.list(carrierId), enabled: Boolean(carrierId) });
  const [carrierModal, setCarrierModal] = useState<Carrier | 'new' | null>(null);
  const [delTariff, setDelTariff] = useState<TariffSummary | null>(null);
  // silme penceresi açılınca bu tarifeyle hesaplı fatura sayısı okunur; gelmezse (hata, eski sunucu) cümle yine gösterilir
  const pinned = useQuery({ queryKey: ['tariff-pinned', delTariff?.id], queryFn: () => tariffs.pinnedInvoices(delTariff!.id), enabled: Boolean(delTariff), retry: false });
  const [delCarrier, setDelCarrier] = useState<Carrier | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);

  const dup = useMutation({
    mutationFn: (id: string) => tariffs.duplicate(id),
    onSuccess: (t) => {
      toast.ok(tr('toast.duplicated'), t.name);
      qc.invalidateQueries({ queryKey: ['tariffs'] });
      nav(`/tariffs/${t.id}`);
    },
  });
  const mkDefault = useMutation({
    mutationFn: (id: string) => tariffs.setDefault(id),
    onSuccess: (t) => {
      toast.ok(tr('toast.defaultChanged'), tr('toast.defaultChangedBody', { name: t.name }));
      qc.invalidateQueries({ queryKey: ['tariffs'] });
    },
  });
  const delT = useMutation({
    mutationFn: (id: string) => tariffs.remove(id),
    onSuccess: () => {
      toast.ok(tr('toast.deleted'));
      setDelTariff(null);
      qc.invalidateQueries({ queryKey: ['tariffs'] });
    },
  });
  const delC = useMutation({
    mutationFn: (id: string) => carriers.remove(id),
    onSuccess: () => {
      toast.ok(tr('toast.carrierRemoved'), tr('toast.carrierRemovedBody'));
      setDelCarrier(null);
      setSp(new URLSearchParams(), { replace: true });
      qc.invalidateQueries({ queryKey: ['carriers'] });
    },
  });

  return (
    <>
      <PageHeader
        title={tr('page.title')}
        sub={tr('page.sub')}
        actions={
          canEdit && (
            <>
              {carrier && (
                <Link className="btn btn-primary" to={`/tariffs/new?carrierId=${carrier.id}`}>
                  <Icon name="plus" /> {tr('main.newTariff')}
                </Link>
              )}
              <RowMenu
                label={tr('page.more')}
                busy={templateBusy}
                items={[
                  {
                    label: tr('page.downloadTemplate'),
                    icon: 'download',
                    onSelect: async () => {
                      setTemplateBusy(true);
                      try {
                        await tariffs.downloadTemplate();
                      } catch (e) {
                        toast.err(tr('toast.templateFailed'), errorMessage(e));
                      } finally {
                        setTemplateBusy(false);
                      }
                    },
                  },
                ]}
              />
            </>
          )
        }
      />
      <div className="content">
        {cs.isError ? (
          <ErrorState error={cs.error} onRetry={() => cs.refetch()} />
        ) : cs.isLoading ? (
          <div className="split tl">
            <div className="list-nav col tl-pad">
              <Skel />
              <Skel />
            </div>
            <TableSkeleton cols={6} rows={3} />
          </div>
        ) : list.length === 0 ? (
          <Empty
            icon="truck"
            title={tr('empty.noCarriers.title')}
            actions={
              canManageCarriers && (
                <Button icon="plus" onClick={() => setCarrierModal('new')}>
                  {tr('empty.noCarriers.add')}
                </Button>
              )
            }
          >
            {tr(canManageCarriers ? 'empty.noCarriers.body' : 'empty.noCarriers.bodyView')}
          </Empty>
        ) : (
          <div className="split tl">
            <section className="tl-carriers" aria-labelledby="tl-carriers-h">
              <div className="tl-carriers-h">
                <h2 id="tl-carriers-h" className="tl-h2">
                  {tr('carriers.heading')}
                </h2>
              </div>
              <nav className="list-nav" aria-label={tr('carriers.heading')}>
                {list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`it${c.id === carrierId ? ' on' : ''}${c.active === false ? ' off' : ''}`}
                    aria-current={c.id === carrierId ? 'true' : undefined}
                    onClick={() => setSp({ carrier: c.id }, { replace: true })}
                  >
                    <span className="lg" aria-hidden="true">
                      {c.name.charAt(0).toLocaleUpperCase(i18n.language)}
                    </span>
                    <span className="grow it-txt">
                      <span className="it-name ellipsis">{c.name}</span>
                      {(carrierKind(c) || c.active === false) && (
                        <span className="it-sub ellipsis">
                          {[carrierKind(c), c.active === false && tr('carriers.inactiveLower')].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <Icon name="chevr" className="it-chev" />
                  </button>
                ))}
              </nav>
              {canManageCarriers && (
                <Button kind="secondary" icon="plus" className="tl-add-carrier" onClick={() => setCarrierModal('new')}>
                  {tr('carriers.add')}
                </Button>
              )}
            </section>
            {carrier && (
              <section className="card flush tl-main">
                <div className="card-h tl-head">
                  <div className="grow">
                    <h2 className="tt">
                      {tr('main.heading', { name: carrier.name })}
                      {carrier.active === false && <Tag tone="gray">{tr('status.inactive')}</Tag>}
                    </h2>
                  </div>
                  {canManageCarriers && (
                    <RowMenu
                      label={tr('main.moreAria', { name: carrier.name })}
                      items={[
                        { label: tr('main.editCarrier'), icon: 'edit', onSelect: () => setCarrierModal(carrier) },
                        { label: tr('main.removeCarrier'), icon: 'trash', danger: true, onSelect: () => setDelCarrier(carrier) },
                      ]}
                    />
                  )}
                </div>
                {ts.isError ? (
                  <div className="tl-pad">
                    <ErrorState error={ts.error} onRetry={() => ts.refetch()} />
                  </div>
                ) : !ts.data ? (
                  <div className="tl-pad col">
                    <Skel />
                    <Skel />
                    <Skel w="60%" />
                  </div>
                ) : ts.data.length === 0 ? (
                  <Empty
                    compact
                    icon="table"
                    title={tr('empty.noTariffs.title', { name: carrier.name })}
                  >
                    {tr(canEdit ? 'empty.noTariffs.body' : 'empty.noTariffs.bodyView')}
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="dt dt-cards tl-table">
                      <thead>
                        <tr>
                          <th>{tr('table.tariff')}</th>
                          <th className="r">{tr('table.divisor')}</th>
                          <th className="r">{tr('table.discount')}</th>
                          <th className="r">{tr('table.fuel')}</th>
                          <th>{tr('table.validity')}</th>
                          <th>{tr('table.status')}</th>
                          {canEdit && (
                            <th>
                              <span className="sr-only">{tr('table.actions')}</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {ts.data.map((t) => (
                          <tr key={t.id} {...rowProps(() => nav(`/tariffs/${t.id}`), false)}>
                            <td className="card-title">
                              <span className="tl-name">
                                <span className="id">{t.name}</span>
                                {t.isDefault && (
                                  <Tag tone="blue" small>
                                    {tr('status.default')}
                                  </Tag>
                                )}
                              </span>
                              <span className="sub">{[t.service, t.currency, t.zoneCount ? tr('row.zones', { count: t.zoneCount, formatted: fmtNum(t.zoneCount) }) : null].filter(Boolean).join(' · ')}</span>
                            </td>
                            <td data-label={tr('table.divisor')} className="r num">
                              {fmtNum(t.divisor)}
                            </td>
                            <td data-label={tr('table.discount')} className="r num">
                              {t.discountPct != null ? fmtPct(t.discountPct) : '—'}
                            </td>
                            <td data-label={tr('table.fuel')} className="r num">
                              {t.fuelPct != null ? fmtPct(t.fuelPct) : '—'}
                            </td>
                            <td data-label={tr('table.validity')} className="num">
                              {t.validFrom || t.validTo ? `${t.validFrom ? fmtDate(t.validFrom) : '…'} – ${t.validTo ? fmtDate(t.validTo) : '…'}` : <span className="t3">{tr('row.unlimited')}</span>}
                            </td>
                            <td data-label={tr('table.status')}>{t.active ? <Tag tone="green">{tr('status.active')}</Tag> : <Tag tone="gray">{tr('status.inactive')}</Tag>}</td>
                            {canEdit && <td className="actions tl-row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                              <RowMenu
                                label={tr('row.moreAria', { name: t.name })}
                                busy={(dup.isPending && dup.variables === t.id) || (mkDefault.isPending && mkDefault.variables === t.id)}
                                items={[
                                  ...(!t.isDefault && t.active ? [{ label: tr('row.makeDefault'), icon: 'flag' as const, onSelect: () => mkDefault.mutate(t.id) }] : []),
                                  { label: tr('row.duplicate'), icon: 'copy', onSelect: () => dup.mutate(t.id) },
                                  { label: tr('row.delete'), icon: 'trash', danger: true, onSelect: () => setDelTariff(t) },
                                ]}
                              />
                            </td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      {carrierModal && (
        <CarrierModal
          carrier={carrierModal === 'new' ? null : carrierModal}
          onClose={() => setCarrierModal(null)}
          onSaved={(c) => {
            setCarrierModal(null);
            setSp({ carrier: c.id }, { replace: true });
          }}
        />
      )}
      {delTariff && (
        <Modal
          busy={delT.isPending}
          label={tr('delTariff.label')}
          title={tr('delTariff.title', { name: delTariff.name })}
          onClose={() => setDelTariff(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setDelTariff(null)}>
                {tr('actions.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={delT.isPending} onClick={() => delT.mutate(delTariff.id)}>
                {tr('actions.delete')}
              </ModalAction>
            </>
          }
        >
          <p>{tr('delTariff.body')}</p>
          {/* Mesaj 4: faturası olan tarife gerçekten silinir; faturalar sürümdeki fiyatlarla kalır. Sayı bilinmiyorsa da söylenir (doğru cümle). */}
          {(pinned.data ?? 1) > 0 && <p className="t2 mt8">{tr('delTariff.pastInvoices')}</p>}
        </Modal>
      )}
      {delCarrier && (
        <Modal
          busy={delC.isPending}
          label={tr('delCarrier.label')}
          title={tr('delCarrier.title', { name: delCarrier.name })}
          onClose={() => setDelCarrier(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setDelCarrier(null)}>
                {tr('actions.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={delC.isPending} onClick={() => delC.mutate(delCarrier.id)}>
                {tr('actions.remove')}
              </ModalAction>
            </>
          }
        >
          <p>{tr('delCarrier.body')}</p>
        </Modal>
      )}
    </>
  );
}

function CarrierModal({ carrier, onClose, onSaved }: { carrier: Carrier | null; onClose: () => void; onSaved: (c: Carrier) => void }) {
  const { t: tr } = useTranslation('tariffs');
  const qc = useQueryClient();
  const [code, setCode] = useState<CarrierCode>(carrier?.code ?? 'fedex');
  const [name, setName] = useState(carrier?.name ?? 'FedEx');
  const [active, setActive] = useState(carrier?.active ?? true);
  const [touched, setTouched] = useState(false);
  // Poşet / zarf sınırı (yalnız düzenlemede): boş alan = taşıyıcının varsayılanı; değişmediyse gövdeye yazılmaz
  const initLimits = limitsForm(carrier?.packagingLimits);
  const [lim, setLim] = useState<LimitsForm>(initLimits);
  const limRes = limitsFromForm(lim, code);
  const limChanged = Boolean(carrier) && JSON.stringify(limRes.limits) !== JSON.stringify(limitsFromForm(initLimits, code).limits);
  const m = useMutation({
    mutationFn: () =>
      carrier
        ? carriers.update(carrier.id, { name: name.trim(), active, ...(limChanged ? { packagingLimits: limRes.limits } : {}) })
        : carriers.create({ code, name: name.trim() }),
    onSuccess: (c) => {
      toast.ok(tr(carrier ? 'carrierModal.updated' : 'carrierModal.added'), c.name);
      qc.invalidateQueries({ queryKey: ['carriers'] });
      // ambalaj sınırları ve ana taşıyıcı `GET /settings` yanıtında da (ölçüm ekranındaki ad)
      qc.invalidateQueries({ queryKey: ['settings'] });
      onSaved(c);
    },
  });
  return (
    <Modal
      busy={m.isPending}
      label={tr('delCarrier.label')}
      title={tr(carrier ? 'main.editCarrier' : 'carrierModal.addTitle')}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {tr('actions.cancel')}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            loading={m.isPending}
            onClick={() => {
              setTouched(true);
              if (name.trim() && !limRes.error) m.mutate();
            }}
          >
            {tr('actions.save')}
          </ModalAction>
        </>
      }
    >
      <div className="col">
        <Field label={tr('carrierModal.template')} htmlFor="c-code" help={tr('carrierModal.templateHelp')}>
          <select
            id="c-code"
            className="sel"
            value={code}
            disabled={Boolean(carrier)}
            onChange={(e) => {
              const c = e.target.value as CarrierCode;
              setCode(c);
              if (!carrier) setName(CARRIER_OPTIONS.find((o) => o.code === c)?.name.replace(/ \(.*\)$/, '') ?? '');
            }}
          >
            {CARRIER_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr('carrierModal.name')} htmlFor="c-name" error={touched && !name.trim() ? tr('carrierModal.nameRequired') : null}>
          <input id="c-name" className="inp" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {carrier && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {tr('carrierModal.active')}
          </label>
        )}
        {carrier && <PackagingLimitsFields code={code} form={lim} setForm={setLim} error={touched ? limRes.error : null} />}
      </div>
    </Modal>
  );
}

/**
 * Taşıyıcı poşeti / zarfı sınırları (nadir ayar): boşsa taşıyıcının varsayılanı geçerli, yer tutucuda görünür; varsayılanı
 * bilinmeyen taşıyıcıda poşet / zarf gönderisinin sınır içinde olduğu doğrulanamaz ("İncele").
 */
function PackagingLimitsFields({ code, form, setForm, error }: { code: CarrierCode; form: LimitsForm; setForm: (f: LimitsForm) => void; error: string | null }) {
  const { t: tr } = useTranslation('tariffs');
  const def = defaultLimits(code);
  const ph = (n: number | null | undefined, digits = 3) => (n == null ? tr('packLimits.unknown') : fmtNum(n, 0, digits));
  const edges = def.ENVELOPE?.maxEdgesCm;
  const input = (id: string, value: string, placeholder: string, onChange: (v: string) => void, label: string) => (
    <input id={id} aria-label={label} className="inp num" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );
  return (
    <div className="col mt8" role="group" aria-labelledby="pl-h">
      <div className="lbl" id="pl-h">
        {tr('packLimits.title')}
      </div>
      <p className="t3 s12">{tr('packLimits.help')}</p>
      <div className="form-grid c3">
        <Field label={tr('packLimits.pakKg', { pack: packagingName('PAK', code) })} htmlFor="pl-pk">
          <Affix sfx="kg" className="w-sm">
            {input('pl-pk', form.pakKg, ph(def.PAK?.maxKg), (v) => setForm({ ...form, pakKg: v }), tr('packLimits.pakKg', { pack: packagingName('PAK', code) }))}
          </Affix>
        </Field>
        <Field label={tr('packLimits.pakVolume', { pack: packagingName('PAK', code) })} htmlFor="pl-pv">
          <Affix sfx="cm³" className="w-md">
            {input('pl-pv', form.pakVolume, ph(def.PAK?.maxVolumeCm3, 0), (v) => setForm({ ...form, pakVolume: v }), tr('packLimits.pakVolume', { pack: packagingName('PAK', code) }))}
          </Affix>
        </Field>
        <Field label={tr('packLimits.envKg', { pack: packagingName('ENVELOPE', code) })} htmlFor="pl-ek">
          <Affix sfx="kg" className="w-sm">
            {input('pl-ek', form.envKg, ph(def.ENVELOPE?.maxKg), (v) => setForm({ ...form, envKg: v }), tr('packLimits.envKg', { pack: packagingName('ENVELOPE', code) }))}
          </Affix>
        </Field>
      </div>
      <Field label={tr('packLimits.envEdges', { pack: packagingName('ENVELOPE', code) })} htmlFor="pl-e0" help={tr('packLimits.envEdgesHelp')}>
        <div className="row center-y" style={{ gap: 8, flexWrap: 'wrap' }}>
          {[0, 1, 2].map((i) => (
            <Affix key={i} sfx="cm" className="w-sm">
              {input(
                `pl-e${i}`,
                form.envEdges[i]!,
                ph(edges?.[i], 1),
                (v) => setForm({ ...form, envEdges: form.envEdges.map((x, j) => (j === i ? v : x)) as LimitsForm['envEdges'] }),
                tr('packLimits.edgeAria', { n: i + 1 }),
              )}
            </Affix>
          ))}
        </div>
      </Field>
      {error && (
        <div className="notif err" role="alert">
          <Icon name="warn" />
          <span>{tr(`packLimits.error.${error}`)}</span>
        </div>
      )}
    </div>
  );
}
