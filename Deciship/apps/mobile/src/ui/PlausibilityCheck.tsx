import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompanySettings } from '../api/endpoints';
import { plausibilityLimits, plausibilityWarnings, RATIO_WARN, type PlausibilityWarning } from '../lib/plausibility';
import { Banner, Button } from './components';

/**
 * Akla aykırı değer onayı (özet ve düzeltme ekranı, Y44). Uyarı varsa kişi "Değerler doğru" demeden kayıt yapılmaz;
 * ölçü, ağırlık ya da eşik değişince onay düşer. `active: false`: uyarı sorulmaz (ör. düzeltmede ölçü ve ağırlık değişmedi).
 */
export function usePlausibilityCheck(v: {
  l: number | null;
  w: number | null;
  h: number | null;
  kg: number | null;
  settings: Pick<CompanySettings, 'desiDivisor' | 'warnEdgeCm' | 'warnWeightKg'>;
  active?: boolean;
}) {
  const { t } = useTranslation('measure');
  const limits = plausibilityLimits(v.settings);
  const divisor = v.settings.desiDivisor;
  const warnings = v.active === false ? [] : plausibilityWarnings({ l: v.l, w: v.w, h: v.h, kg: v.kg, divisor, limits });
  const checkKey = [v.l, v.w, v.h, v.kg, divisor, limits.edgeCm, limits.weightKg].join('|');
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const needsConfirm = warnings.length > 0 && confirmedKey !== checkKey;
  const warningText = (w: PlausibilityWarning) =>
    w === 'edge' ? t('summary.checkEdge', { max: limits.edgeCm }) : w === 'weight' ? t('summary.checkWeight', { max: limits.weightKg }) : t('summary.checkRatio', { n: RATIO_WARN });
  const banner = needsConfirm ? (
    <Banner
      kind="warn"
      title={t('summary.checkTitle')}
      text={warnings.map(warningText).join('\n')}
      action={<Button label={t('summary.checkConfirm')} kind="secondary" icon="check" small onPress={() => setConfirmedKey(checkKey)} />}
    />
  ) : null;
  return { needsConfirm, banner };
}
