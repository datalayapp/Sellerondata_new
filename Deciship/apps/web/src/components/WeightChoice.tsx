import { Trans, useTranslation } from 'react-i18next';
import { weightAs, type WeightFormat } from '@deciship/core';
import { weightChoice, weightChoiceLabel, weightChoiceLabelOf, weightChoiceText, type WeightPick, type WeightReadings } from '../lib/weightChoice';

/**
 * K36: tarife ve fatura ağırlık alanının altında "1,5 kg mı, 1.500 kg mı?" seçimi. Metin iki türlü okunmuyorsa hiçbir şey
 * çizmez. Seçim alana iki türlü okunmayan metni yazar ("1,5" / "1500"); seçilene dek kayıt ya da içe aktarma kapalıdır
 * (kuralı çağıran tutar: düzenleyicide `toBody`, PDF adımında `pdfCellInvalid`).
 */
/** `readings` verilirse (sunucunun PDF denetiminden; metin "1,5" gibi tek okunuyor olabilir) metinden okunmaz. */
export function WeightChoice({ value, readings, onPick }: { value: string; readings?: WeightReadings; onPick: (text: string, pick: WeightPick) => void }) {
  const { t } = useTranslation();
  const r = readings ?? weightChoice(value);
  if (!r) return null;
  const option = (pick: WeightPick) => (
    <button key={pick} type="button" className="link-btn" onClick={() => onPick(weightChoiceText(r, pick), pick)}>
      {weightChoiceLabel(r, pick)}
    </button>
  );
  const values = { decimal: weightChoiceLabel(r, 'decimal'), thousands: weightChoiceLabel(r, 'thousands') };
  return (
    <div className="weight-choice" role="group" aria-label={t('weightChoice.aria', { value: value.trim() })} data-testid="weight-choice">
      <Trans t={t} i18nKey="weightChoice.ask" values={values} components={{ a: option('decimal'), b: option('thousands') }} />
    </div>
  );
}

/**
 * K36: tablo için tek soru, seçenekler yazım biçimidir (Türkçe / İngilizce yazım): her seçenek örneklerin o biçimdeki
 * değerini gösterir ("“1.500” = 1,5 kg, “1,500” = 1.500 kg"). Hücreler kendi ayırıcısına göre okunur.
 */
export function WeightFormatChoice({ samples, onPick }: { samples: { text: string; readings: WeightReadings; sep: '.' | ',' }[]; onPick: (fmt: WeightFormat) => void }) {
  const { t } = useTranslation();
  if (!samples.length) return null;
  // ilk örneğin ondalık okuması önce (tek örnekte eski "1,5 kg mı, 1.500 kg mı?" sırası)
  const order: WeightFormat[] = samples[0]!.sep === '.' ? ['en', 'tr'] : ['tr', 'en'];
  const label = (fmt: WeightFormat) =>
    samples.map((s) => t('weightChoice.item', { text: s.text, value: weightChoiceLabelOf(weightAs(s.readings, s.sep, fmt)) })).join(', ');
  return (
    <div className="weight-choice" role="group" aria-label={t('weightChoice.which')} data-testid="weight-format-choice">
      <span>{t('weightChoice.which')}</span>
      {order.map((fmt) => (
        <button key={fmt} type="button" className="link-btn" onClick={() => onPick(fmt)}>
          {label(fmt)}
        </button>
      ))}
    </div>
  );
}
