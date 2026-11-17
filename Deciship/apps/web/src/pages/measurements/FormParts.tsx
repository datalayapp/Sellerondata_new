import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../i18n';
import { boxPresets } from '../../api/endpoints';
import type { BoxPreset, PhotoKind } from '../../api/types';
import { useProductMe } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { Affix, Button, Field } from '../../components/ui';
import { fmtDims, fmtKg, fmtNum, parseMeasure, volumetric, desiOf } from '../../lib/format';
import { PHOTO_KIND_LABEL } from '../../lib/labels';
import { edgeValid, weightValid } from './dimLimits';

export interface DimForm {
  trackingRaw: string;
  l: string;
  w: string;
  h: string;
  kg: string;
  note: string;
}

/**
 * Kenar 0 < cm ≤ 400, ağırlık 0 < kg < 1000 (mobil ile aynı sınırlar ve aynı sayı okuma).
 * `orig` düzenlemede kaydın özgün değeridir; değişmeyen alan için sınır hatası verilmez.
 */
export function dimErrors(f: DimForm, orig?: DimForm) {
  return {
    trackingRaw: !f.trackingRaw.trim() ? i18n.t('measurements:form.trackingRequired') : null,
    l: edgeValid(f.l, orig?.l) ? null : i18n.t('measurements:form.lengthInvalid'),
    w: edgeValid(f.w, orig?.w) ? null : i18n.t('measurements:form.widthInvalid'),
    h: edgeValid(f.h, orig?.h) ? null : i18n.t('measurements:form.heightInvalid'),
    kg: weightValid(f.kg, orig?.kg) ? null : i18n.t('measurements:form.weightInvalid'),
  };
}

export function DimFields({ f, setF, touched, showTracking, orig }: { f: DimForm; setF: (f: DimForm) => void; touched: boolean; showTracking: boolean; orig?: DimForm }) {
  const { t } = useTranslation('measurements');
  const me = useProductMe();
  const errs = dimErrors(f, orig);
  const set = (k: keyof DimForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const l = parseMeasure(f.l);
  const w = parseMeasure(f.w);
  const h = parseMeasure(f.h);
  const kg = parseMeasure(f.kg);
  const divisor = me.company.settings.desiDivisor || 3000;
  const ok = l && w && h;
  const desi = ok ? desiOf(l, w, h, divisor) : null;
  const vol = ok ? volumetric(l, w, h, 5000) : null;
  return (
    <div className="form-grid m-dims">
      {showTracking && (
        <Field label={t('form.trackingBarcode')} htmlFor="m-trk" className="span-all" error={touched ? errs.trackingRaw : null}>
          <input id="m-trk" className="inp mono w-lg" value={f.trackingRaw} onChange={set('trackingRaw')} placeholder="794812345305" />
        </Field>
      )}
      <div className="span-all m-dim-row">
        <Field label={t('form.length')} htmlFor="m-l" error={touched ? errs.l : null}>
          <Affix sfx="cm">
            <input id="m-l" data-measure className="inp num" inputMode="decimal" value={f.l} onChange={set('l')} />
          </Affix>
        </Field>
        <Field label={t('form.width')} htmlFor="m-w" error={touched ? errs.w : null}>
          <Affix sfx="cm">
            <input id="m-w" data-measure className="inp num" inputMode="decimal" value={f.w} onChange={set('w')} />
          </Affix>
        </Field>
        <Field label={t('form.height')} htmlFor="m-h" error={touched ? errs.h : null}>
          <Affix sfx="cm">
            <input id="m-h" data-measure className="inp num" inputMode="decimal" value={f.h} onChange={set('h')} />
          </Affix>
        </Field>
        <Field label={t('form.actualWeight')} htmlFor="m-kg" error={touched ? errs.kg : null}>
          <Affix sfx="kg">
            <input id="m-kg" data-measure className="inp num" inputMode="decimal" value={f.kg} onChange={set('kg')} />
          </Affix>
        </Field>
      </div>
      <div className="span-all m-calc" aria-live="polite">
        <div>
          <span className="k">{t('form.desi', { divisor: fmtNum(divisor) })}</span>
          <b className="num">{desi != null ? fmtNum(desi, 0, 2) : '—'}</b>
        </div>
        <div>
          <span className="k">{t('form.volumetric')}</span>
          <b className="num">{vol != null ? fmtKg(vol) : '—'}</b>
        </div>
        <div>
          <span className="k">{t('form.billable')}</span>
          <b className="num">{vol != null && kg != null ? fmtKg(Math.max(vol, kg)) : '—'}</b>
        </div>
      </div>
      <Field label={t('form.note')} htmlFor="m-note" className="span-all">
        <textarea id="m-note" className="txt" style={{ minHeight: 60 }} value={f.note} onChange={set('note')} />
      </Field>
    </div>
  );
}

export type NewPhoto = { file: File; kind: PhotoKind };

/** Hazır koli seçimi: seçilince ölçüler dolar. */
export function PresetPicker({ presetId, onPick }: { presetId: string | null; onPick: (p: BoxPreset | null) => void }) {
  const { t } = useTranslation('measurements');
  const presets = useQuery({ queryKey: ['box-presets'], queryFn: boxPresets.list });
  const active = (presets.data ?? []).filter((p) => p.active || p.id === presetId);
  if (!active.length) return null;
  return (
    <div className="m-presets">
      <div className="lbl">{t('form.presetLabel')}</div>
      <div className="seg" role="group" aria-label={t('form.presetAria')}>
        {active.map((p) => (
          <button key={p.id} type="button" className={presetId === p.id ? 'on' : ''} aria-pressed={presetId === p.id} onClick={() => onPick(presetId === p.id ? null : p)}>
            {p.name} · {fmtDims(p.lengthCm, p.widthCm, p.heightCm)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** New photo files with a kind each (JPEG/PNG). */
export function NewPhotos({ photos, setPhotos, label, firstKind = 'PHOTO_BOX' }: { photos: NewPhoto[]; setPhotos: (p: NewPhoto[]) => void; label: string; firstKind?: PhotoKind }) {
  const { t } = useTranslation('measurements');
  return (
    <div className="mt16">
      <div className="lbl">{label}</div>
      <div className="row center-y" style={{ flexWrap: 'wrap', gap: 8 }}>
        {photos.map((p, i) => (
          <span key={i} className="row center-y m-photo-chip">
            <span className="s12 ellipsis" style={{ maxWidth: 160 }}>
              {p.file.name}
            </span>
            <select
              aria-label={t('form.photoType')}
              className="sel sm"
              style={{ width: 110, height: 28 }}
              value={p.kind}
              onChange={(e) => setPhotos(photos.map((x, j) => (j === i ? { ...x, kind: e.target.value as PhotoKind } : x)))}
            >
              {(Object.keys(PHOTO_KIND_LABEL) as PhotoKind[]).map((k) => (
                <option key={k} value={k}>
                  {PHOTO_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <Button kind="plain" small icon="close" aria-label={t('form.removePhoto')} onClick={() => setPhotos(photos.filter((_, j) => j !== i))} />
          </span>
        ))}
        <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          {t('form.addPhoto')} <Icon name="camera" />
          <input
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              setPhotos([...photos, ...files.map((file, i) => ({ file, kind: (photos.length + i === 0 ? firstKind : 'PHOTO_OTHER') as PhotoKind }))]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
