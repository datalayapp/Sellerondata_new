import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { boxPresets, measurements } from '../../api/endpoints';
import type { DimMethod, MeasurementDetail, MeasurementPatch } from '../../api/types';
import { toast } from '../../components/Toast';
import { Modal, ModalAction } from '../../components/ui';
import { numToInput, parseMeasure } from '../../lib/format';
import { DIM_METHOD_LABEL, PHOTO_KIND_LABEL } from '../../lib/labels';
import { DimFields, NewPhotos, PresetPicker, dimErrors, type DimForm, type NewPhoto } from './FormParts';
import { MethodPill, invalidateAfterMeasurementChange } from './shared';

export function EditMeasurementModal({ m, onClose, onSaved }: { m: MeasurementDetail; onClose: () => void; onSaved: (m: MeasurementDetail) => void }) {
  const { t } = useTranslation('measurements');
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['box-presets'], queryFn: boxPresets.list });
  const init: DimForm = {
    trackingRaw: m.trackingRaw,
    l: numToInput(m.lengthCm, 1),
    w: numToInput(m.widthCm, 1),
    h: numToInput(m.heightCm, 1),
    kg: numToInput(m.weightKg),
    note: m.note ?? '',
  };
  const [f, setF] = useState<DimForm>(init);
  const [presetId, setPresetId] = useState<string | null>(m.dimMethod === 'PRESET' ? (m.boxPresetId ?? null) : null);
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const num = (s: string) => parseMeasure(s);
  const dimsChanged = num(f.l) !== m.lengthCm || num(f.w) !== m.widthCm || num(f.h) !== m.heightCm;
  // a preset only counts while the dims still equal it; typing other dims turns the record into MANUAL
  const preset = presets.data?.find((p) => p.id === presetId) ?? null;
  const presetHolds = Boolean(preset && num(f.l) === preset.lengthCm && num(f.w) === preset.widthCm && num(f.h) === preset.heightCm);
  const effPreset = presetHolds ? presetId : null;
  const presetDropped = m.dimMethod === 'PRESET' && !effPreset;
  const method: DimMethod = effPreset ? 'PRESET' : dimsChanged || presetDropped ? 'MANUAL' : m.dimMethod;

  const body: MeasurementPatch = {};
  if (f.trackingRaw.trim() !== m.trackingRaw) body.trackingRaw = f.trackingRaw.trim();
  if (dimsChanged || method !== m.dimMethod) {
    body.lengthCm = num(f.l)!;
    body.widthCm = num(f.w)!;
    body.heightCm = num(f.h)!;
  }
  if (effPreset && effPreset !== m.boxPresetId) body.boxPresetId = effPreset;
  if (presetDropped) {
    body.boxPresetId = null;
    body.dimMethod = 'MANUAL';
  }
  if (num(f.kg) !== m.weightKg) body.weightKg = num(f.kg)!;
  if (f.note.trim() !== (m.note ?? '')) body.note = f.note.trim() || null;
  if (removeIds.length) body.removePhotoIds = removeIds;
  if (photos.length) body.photoKinds = photos.map((p) => p.kind);

  const save = useMutation({
    mutationFn: () => measurements.update(m.id, body, photos.map((p) => p.file)),
    onSuccess: (nm) => {
      toast.ok(t('toast.versionSaved'), t('toast.recompare'));
      invalidateAfterMeasurementChange(qc);
      onClose();
      // PATCH writes a new version with a new id (SPEC §10.1): follow it so the panel stays editable
      onSaved(nm);
    },
  });
  const submit = () => {
    setTouched(true);
    if (Object.values(dimErrors(f, init)).some(Boolean)) return;
    if (Object.keys(body).length === 0) return onClose();
    save.mutate();
  };
  return (
    <Modal
      busy={save.isPending}
      label={m.trackingNo}
      title={t('edit.title')}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('actions.cancel')}
          </ModalAction>
          <ModalAction kind="prim" icon="check" loading={save.isPending} onClick={submit}>
            {t('edit.saveVersion')}
          </ModalAction>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 16 }}>
        {t('edit.hint', { n: m.version + 1 })}
      </p>
      <PresetPicker
        presetId={effPreset}
        onPick={(p) => {
          setPresetId(p?.id ?? null);
          if (p) setF({ ...f, l: numToInput(p.lengthCm, 1), w: numToInput(p.widthCm, 1), h: numToInput(p.heightCm, 1) });
        }}
      />
      <DimFields f={f} setF={setF} touched={touched} showTracking orig={init} />
      <div className="m-method" aria-live="polite">
        <span className="k">{t('edit.methodToSave')}</span>
        <MethodPill method={method} />
        {method !== m.dimMethod && <span className="t3 s12">{t('edit.previous', { method: DIM_METHOD_LABEL[m.dimMethod] })}</span>}
      </div>
      {m.photos.length > 0 && (
        <div className="mt16">
          <div className="lbl">{t('edit.existingPhotos')}</div>
          <div className="m-ephotos">
            {m.photos.map((p) => {
              const off = removeIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`m-ephoto${off ? ' off' : ''}`}
                  aria-pressed={off}
                  aria-label={t(off ? 'edit.keepPhotoAria' : 'edit.removePhotoAria', { kind: PHOTO_KIND_LABEL[p.kind] })}
                  onClick={() => setRemoveIds(off ? removeIds.filter((x) => x !== p.id) : [...removeIds, p.id])}
                >
                  <img src={p.url} alt="" loading="lazy" />
                  <span className="cap">{off ? t('edit.toRemove') : PHOTO_KIND_LABEL[p.kind]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <NewPhotos photos={photos} setPhotos={setPhotos} label={t('edit.newPhotos')} firstKind={m.photos.length ? 'PHOTO_OTHER' : 'PHOTO_BOX'} />
    </Modal>
  );
}

export function AddMeasurementModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('measurements');
  const qc = useQueryClient();
  const [f, setF] = useState<DimForm>({ trackingRaw: '', l: '', w: '', h: '', kg: '', note: '' });
  const [presetId, setPresetId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [touched, setTouched] = useState(false);
  const clientId = useMemo(() => crypto.randomUUID(), []);

  const save = useMutation({
    mutationFn: () =>
      measurements.create(
        {
          clientId,
          trackingRaw: f.trackingRaw.trim(),
          lengthCm: parseMeasure(f.l)!,
          widthCm: parseMeasure(f.w)!,
          heightCm: parseMeasure(f.h)!,
          weightKg: parseMeasure(f.kg)!,
          dimMethod: presetId ? 'PRESET' : 'MANUAL',
          weightMethod: 'MANUAL',
          boxPresetId: presetId ?? undefined,
          measuredAt: new Date().toISOString(),
          note: f.note.trim() || undefined,
          photoKinds: photos.map((p) => p.kind),
        },
        photos.map((p) => p.file),
      ),
    onSuccess: () => {
      toast.ok(t('toast.saved'));
      qc.invalidateQueries({ queryKey: ['measurements'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (Object.values(dimErrors(f)).some(Boolean)) return;
    save.mutate();
  };

  return (
    <Modal
      busy={save.isPending}
      label={t('title')}
      title={t('add.title')}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('actions.cancel')}
          </ModalAction>
          <ModalAction kind="prim" icon="check" loading={save.isPending} onClick={submit}>
            {t('actions.save')}
          </ModalAction>
        </>
      }
    >
      <PresetPicker
        presetId={presetId}
        onPick={(p) => {
          setPresetId(p?.id ?? null);
          if (p) setF({ ...f, l: numToInput(p.lengthCm, 1), w: numToInput(p.widthCm, 1), h: numToInput(p.heightCm, 1) });
        }}
      />
      <DimFields f={f} setF={setF} touched={touched} showTracking />
      <NewPhotos photos={photos} setPhotos={setPhotos} label={t('add.photos')} />
    </Modal>
  );
}
