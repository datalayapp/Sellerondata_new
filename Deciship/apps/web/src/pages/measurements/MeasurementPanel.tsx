import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { measurements } from '../../api/endpoints';
import { usePermission, useProductMe } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { PhotoStrip } from '../../components/Photos';
import { toast } from '../../components/Toast';
import { Button, DiffTags, ErrorState, Modal, ModalAction, SidePanel, Skel, StatusTag, Tag } from '../../components/ui';
import { fmtDateTime, fmtDims, fmtKg, fmtMoneySigned, fmtNum, desiOf } from '../../lib/format';
import { DIM_METHOD_LABEL } from '../../lib/labels';
import { packagingName, packagingOf } from '../../lib/packaging';
import { usePackagingCarrier } from './FormParts';
import { EditMeasurementModal } from './MeasurementModals';
import { panelActions } from './panelActions';
import { PurgeBlockedNote, PurgeMeasurementButton } from './PurgeMeasurement';
import { MethodPill, invalidateAfterMeasurementChange, restoreMeasurement } from './shared';

export function MeasurementPanel({ id, onClose, onNewVersion }: { id: string; onClose: () => void; onNewVersion: (id: string) => void }) {
  const { t } = useTranslation('measurements');
  const qc = useQueryClient();
  const me = useProductMe();
  const canManage = usePermission('deciship.measurements.manage');
  const showPrices = usePermission('deciship.prices.view');
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const q = useQuery({ queryKey: ['measurement', id], queryFn: () => measurements.get(id) });
  const del = useMutation({
    mutationFn: () => measurements.remove(id),
    onSuccess: () => {
      toast.ok(t('toast.deleted'), t('toast.recompare'), {
        action: { label: t('toast.undo'), onClick: () => void restoreMeasurement(qc, id) },
      });
      invalidateAfterMeasurementChange(qc);
      onClose();
    },
  });
  const m = q.data;
  const divisor = me.company.settings.desiDivisor || 3000;
  const isDeleted = Boolean(m && (m.deleted || m.deletedAt));
  const [restoring, setRestoring] = useState(false);
  const mode = panelActions(canManage, m);
  const packCarrier = usePackagingCarrier();

  return (
    <SidePanel
      meta={m ? t('panel.meta', { method: DIM_METHOD_LABEL[m.dimMethod], n: m.version }) : t('panel.metaFallback')}
      title={m ? <span className="mono">{m.trackingNo}</span> : <Skel w={200} h={24} />}
      onClose={onClose}
      actions={
        !m || mode === 'none' ? undefined : mode === 'restore' ? (
          <>
            {/* Kalıcı silme: ikincil çöp kutusu, korumada devre dışı (neden gövdede); tek birincil eylem Geri yükle. */}
            <PurgeMeasurementButton m={m} onPurged={onClose} />
            <button
              type="button"
              className="pa prim"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                await restoreMeasurement(qc, m.id);
                setRestoring(false);
              }}
            >
              <span>{t('row.restore')}</span>
              {restoring ? <Icon name="spin" className="spin" /> : <Icon name="back" />}
            </button>
          </>
        ) : (
          <>
            {/* Silme doğrudan görünür (eskiden tek öğeli ⋯ menüsündeydi); aynı onay penceresini açar. */}
            <Button
              kind="secondary"
              icon="trash"
              className="pn-del"
              aria-label={t('panel.deleteAria')}
              title={t('panel.deleteAria')}
              onClick={() => setConfirmDel(true)}
            />
            <button type="button" className="pa prim" onClick={() => setEditing(true)}>
              <span>{t('panel.edit')}</span>
              <Icon name="edit" />
            </button>
          </>
        )
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !m ? (
        <div className="col">
          <Skel h={66} />
          <Skel />
          <Skel w="70%" />
        </div>
      ) : (
        <>
          {isDeleted ? (
            <>
              <div className="notif err pn-note">
                <Icon name="trash" />
                <span>
                  <Trans
                    ns="measurements"
                    i18nKey={m.deletedAt ? 'panel.deletedAt' : 'panel.deleted'}
                    values={{ when: m.deletedAt ? fmtDateTime(m.deletedAt) : '' }}
                    components={{ b: <b /> }}
                  />
                </span>
              </div>
              <PurgeBlockedNote m={m} />
            </>
          ) : (
            m.canEdit === false && (
              <div className="notif info pn-note">
                <Icon name="info" />
                {/* Sebebe göre: eski sürüm mü, yoksa yetki mi (Muhasebe gibi roller ölçüm düzenleyemez)? */}
                <span>{t(m.superseded ? 'panel.readOnly' : 'panel.noPermission')}</span>
              </div>
            )
          )}
          <div className="sec">{t('panel.secDims')}</div>
          <div className="cmp m-facts">
            <div>
              <div className="s12 muted">{t('col.dims')}</div>
              <div className="v">{fmtDims(m.lengthCm, m.widthCm, m.heightCm)}</div>
            </div>
            <div>
              <div className="s12 muted">{t('form.actualWeight')}</div>
              <div className="v">{fmtKg(m.weightKg)}</div>
            </div>
            <div>
              <div className="s12 muted">{t('form.desi', { divisor: fmtNum(divisor) })}</div>
              <div className="v">{fmtNum(m.desi ?? desiOf(m.lengthCm, m.widthCm, m.heightCm, divisor), 0, 2)}</div>
            </div>
            <div>
              <div className="s12 muted">{t('form.volumetric')}</div>
              <div className="v">{fmtKg(m.volumetricKg5000)}</div>
            </div>
          </div>
          <div className="kvs mt16">
            <span className="k">{t('panel.rawBarcode')}</span>
            <span className="mono ellipsis">{m.trackingRaw}</span>
            <span className="k">{t('panel.dimMethod')}</span>
            <span className="row center-y" style={{ gap: 6, flexWrap: 'wrap' }}>
              <MethodPill method={m.dimMethod} />
              {m.dimConfidence != null && <span className="muted"> · {t('panel.confidence', { n: fmtNum(m.dimConfidence * 100, 0, 0) })}</span>}
            </span>
            <span className="k">{t('form.packaging')}</span>
            <span>{packagingName(packagingOf(m.packaging), packCarrier)}</span>
            <span className="k">{t('panel.weight')}</span>
            <span>
              {m.weightMethod === 'OCR' ? t('panel.weightOcr') : t('panel.weightManual')}
              {m.ocrWeightKg != null && m.weightMethod === 'OCR' && <span className="muted"> · {t('panel.ocrRead', { kg: fmtKg(m.ocrWeightKg) })}</span>}
            </span>
            <span className="k">{t('col.measuredByOnly')}</span>
            <span>{m.measuredBy?.name}</span>
            <span className="k">{t('panel.time')}</span>
            <span>{fmtDateTime(m.measuredAt)}</span>
            {m.note && (
              <>
                <span className="k">{t('panel.note')}</span>
                <span>{m.note}</span>
              </>
            )}
          </div>

          <div className="sec">{t('panel.secPhotos')}</div>
          <PhotoStrip photos={m.photos ?? []} />
          <div className="sec">{t('panel.secInvoiceLine')}</div>
          {m.invoiceLines && m.invoiceLines.length > 0 ? (
            <div className="col" style={{ gap: 8 }}>
              {m.invoiceLines.map((l) => (
                <Link
                  key={l.id}
                  to={`/invoices/${l.invoiceId}?tab=ALL&q=${encodeURIComponent(m.trackingNo)}&line=${l.id}`}
                  className="row center-y"
                  style={{ gap: 8, color: 'inherit' }}
                >
                  <StatusTag status={l.status} />
                  <span className="mono blue">{l.invoiceNo ?? t('col.invoice')}</span>
                  {l.diffTypes && <DiffTags types={l.diffTypes} />}
                  {showPrices && l.diffAmount != null && l.status === 'DIFF' && (
                    <span className="red num" style={{ marginLeft: 'auto' }}>
                      {fmtMoneySigned(l.diffAmount, l.currency)}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted s12">{t('panel.notSeen')}</p>
          )}

          <div className="sec">{t('panel.secHistory')}</div>
          <table className="dt compact m-hist">
            <thead>
              <tr>
                <th>{t('panel.histVersion')}</th>
                <th>{t('col.dims')}</th>
                <th className="r">{t('panel.histKg')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>v{m.version}</b>{' '}
                  <Tag tone="blue" small>
                    {t('panel.current')}
                  </Tag>
                </td>
                <td className="mono num">{fmtDims(m.lengthCm, m.widthCm, m.heightCm)}</td>
                <td className="r num">{fmtKg(m.weightKg)}</td>
              </tr>
              {(m.history ?? []).map((h) => (
                <tr key={h.id}>
                  <td>
                    <span className="muted">v{h.version}</span>
                    <span className="sub">{fmtDateTime(h.createdAt ?? h.measuredAt)}</span>
                  </td>
                  <td className="mono num muted">{fmtDims(h.lengthCm, h.widthCm, h.heightCm)}</td>
                  <td className="r num muted">{fmtKg(h.weightKg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(m.history ?? []).length === 0 && <p className="muted s12 mt8">{t('panel.noHistory')}</p>}
        </>
      )}
      {editing && m && <EditMeasurementModal m={m} onClose={() => setEditing(false)} onSaved={(nm) => nm?.id && nm.id !== id && onNewVersion(nm.id)} />}
      {confirmDel && m && (
        <Modal
          busy={del.isPending}
          label={m.trackingNo}
          title={t('panel.deleteTitle')}
          onClose={() => setConfirmDel(false)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setConfirmDel(false)}>
                {t('actions.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={del.isPending} onClick={() => del.mutate()}>
                {t('actions.delete')}
              </ModalAction>
            </>
          }
        >
          <p>{t('panel.deleteText')}</p>
        </Modal>
      )}
    </SidePanel>
  );
}
