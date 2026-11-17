import { useTranslation } from 'react-i18next';
import type { MeasurementListItem } from '../../api/types';
import { Button, StatusTag, Tag, rowProps } from '../../components/ui';
import { fmtDateTime, fmtDims, fmtKg, fmtNum } from '../../lib/format';
import { MethodPill } from './shared';

/** Row of the "Silinenler" list: read-only, no panel; the only action is restore. */
export function DeletedRow({
  m,
  busy,
  onRestore,
  compact,
  selected,
  onOpen,
}: {
  m: MeasurementListItem;
  busy: boolean;
  onRestore: () => void;
  compact: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation('measurements');
  return (
    <tr {...rowProps(onOpen, selected)}>
      <td className="card-title">
        <span className="id mono">{m.trackingNo}</span>
        {m.version > 1 && <span className="sub">{t('row.version', { n: m.version })}</span>}
      </td>
      <td data-label={t('col.dims')} className="r num mono">
        {fmtDims(m.lengthCm, m.widthCm, m.heightCm)}
      </td>
      <td data-label={t('col.actualKg')} className="r num">
        {fmtKg(m.weightKg)}
      </td>
      <td data-label={t('col.desi')} className="r num">
        {fmtNum(m.desi, 0, 2)}
      </td>
      {!compact && (
        <td data-label={t('col.volKg')} className="r num m-hide-sm">
          {fmtKg(m.volumetricKg5000)}
        </td>
      )}
      <td data-label={t('col.method')} className="m-c-how">
        <MethodPill method={m.dimMethod} />
      </td>
      {!compact && (
        <td data-label={t('col.measuredByOnly')} className="m-c-who">
          {m.measuredBy?.name}
          <span className="sub">{fmtDateTime(m.measuredAt)}</span>
        </td>
      )}
      {!compact && (
        <td data-label={t('col.photos')} className="r num m-hide-sm">
          {m.photoCount}
        </td>
      )}
      <td data-label={t('col.status')}>
        <span className="m-del">
          <Tag tone="red">{t('row.deleted')}</Tag>
          {m.deletedAt && <span className="sub">{fmtDateTime(m.deletedAt)}</span>}
        </span>
      </td>
      <td className="m-del-act">
        <Button
          kind="secondary"
          small
          icon="back"
          loading={busy}
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('row.restoreAria', { trackingNo: m.trackingNo })}>
          {t('row.restore')}
        </Button>
      </td>
    </tr>
  );
}

export function MeasurementRow({ m, selected, compact, onOpen }: { m: MeasurementListItem; selected: boolean; compact: boolean; onOpen: () => void }) {
  const { t } = useTranslation('measurements');
  return (
    <tr {...rowProps(onOpen, selected)}>
      <td className="card-title">
        <span className="id mono">{m.trackingNo}</span>
        {m.version > 1 && <span className="sub">{t('row.version', { n: m.version })}</span>}
      </td>
      <td data-label={t('col.dims')} className="r num mono">
        {fmtDims(m.lengthCm, m.widthCm, m.heightCm)}
      </td>
      <td data-label={t('col.actualKg')} className="r num">
        {fmtKg(m.weightKg)}
      </td>
      <td data-label={t('col.desi')} className="r num">
        {fmtNum(m.desi, 0, 2)}
      </td>
      {!compact && (
        <td data-label={t('col.volKg')} className="r num m-hide-sm">
          {fmtKg(m.volumetricKg5000)}
        </td>
      )}
      <td data-label={t('col.method')} className="m-c-how">
        <MethodPill method={m.dimMethod} />
      </td>
      {!compact && (
        <td data-label={t('col.measuredByOnly')} className="m-c-who">
          {m.measuredBy?.name}
          <span className="sub">{fmtDateTime(m.measuredAt)}</span>
        </td>
      )}
      {!compact && (
        <td data-label={t('col.photos')} className="r num m-hide-sm">
          {m.photoCount === 0 ? <span className="t3">0</span> : m.photoCount}
        </td>
      )}
      <td data-label={t('col.invoice')}>{m.invoiceStatus ? <StatusTag status={m.invoiceStatus} /> : <Tag tone="gray">{t('row.notOnInvoice')}</Tag>}</td>
    </tr>
  );
}
