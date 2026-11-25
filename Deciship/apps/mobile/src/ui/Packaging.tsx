import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { packagingLabel, PACKAGINGS, volumeCm3 } from '@deciship/core/packaging';
import type { PackagingSettings } from '../lib/packaging';
import {
  carrierLimits,
  limitView,
  packagingCarrier,
  packagingCheckKey,
  packagingWarning,
  type Dims3,
  type Packaging,
  type PackagingCarrier,
  type PackagingLimits,
  type PackagingWarning,
} from '../lib/packaging';
import { fmtDims, fmtNum, getFormatLocale } from '../lib/format';
import { Badge, Banner, Button, Card } from './components';
import { Icon } from './Icon';
import { LiveCalc } from './LiveCalc';
import { colors, font, radius } from './theme';

/** Ambalajın taşıyıcısı, sınırları ve adı (barkoddan ya da firmanın ana taşıyıcısından). */
export function usePackagingContext(trackingRaw: string | null | undefined, settings: { packaging: PackagingSettings }) {
  // Dil değişince adlar yenilensin diye çeviri kancasına bağlı.
  useTranslation('measure');
  const carrier = packagingCarrier(trackingRaw, settings.packaging);
  const limits = carrierLimits(carrier, settings.packaging);
  const locale = getFormatLocale();
  const label = (p: Packaging) => packagingLabel(carrier, p, locale);
  return { carrier, limits, label };
}

export type PackagingContext = ReturnType<typeof usePackagingContext>;

const kgText = (n: number) => fmtNum(n, 2, true);
const volText = (n: number) => fmtNum(n, 0);
/** Kenarlar büyükten küçüğe ("31,7×24,1×2"); zarfın kenar sınırıyla aynı sırada karşılaştırılır. */
const edgesText = (e: readonly number[]) =>
  [...e]
    .sort((a, b) => b - a)
    .map((x) => fmtNum(x, 1, true))
    .join('×');

/** "Ambalaj" kartı: üç seçenekli seçim (kendi ambalajı / poşet / zarf). */
export function PackagingPicker({
  value,
  onChange,
  ctx,
  changed,
}: {
  value: Packaging;
  onChange: (p: Packaging) => void;
  ctx: PackagingContext;
  /** Düzeltme ekranı: kayıttaki değerden farklıysa "Değişti" rozeti. */
  changed?: boolean;
}) {
  const { t } = useTranslation('measure');
  return (
    <Card style={{ gap: 8 }}>
      <View style={st.hd}>
        <Text style={st.secH} accessibilityRole="header">
          {t('packaging.title')}
        </Text>
        {changed ? <Badge label={t('edit.changed')} kind="warning" dot /> : null}
      </View>
      <View style={st.seg} accessibilityRole="radiogroup" accessibilityLabel={t('packaging.title')}>
        {PACKAGINGS.map((p) => {
          const on = p === value;
          return (
            <Pressable
              key={p}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, selected: on }}
              onPress={() => onChange(p)}
              style={({ pressed }) => [st.segItem, on && st.segOn, pressed && !on && st.segPressed]}
            >
              <Text style={[st.segTxt, on && st.segTxtOn]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.85}>
                {ctx.label(p)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

/**
 * Ölçüye göre hesap kutusu. Kendi ambalajında canlı hesap (`fitHint`: paket özel ambalaja sığıyorsa altında kısa bilgi);
 * poşet/zarfta sınır kartı (ağırlık, hacim, desisiz ücretli ağırlık; sınır içindeyse yeşil, aşıyorsa uyarı rengi). Sınırı
 * bilinmeyen ambalajda yalnız kısa bilgi.
 */
export function PackagingCalc({
  packaging,
  l,
  w,
  h,
  kg,
  desiDivisor,
  ctx,
  barem,
  fitHint,
}: Dims3 & { packaging: Packaging; kg: number | null; desiDivisor: number; ctx: PackagingContext; barem?: boolean; fitHint?: boolean }) {
  const { t } = useTranslation('measure');
  if (packaging === 'OWN') {
    const warn = fitHint ? packagingWarning('OWN', kg, { l, w, h }, ctx.limits) : null;
    const hint = warn?.kind === 'suggest' ? fitText(warn.to, ctx, t) : null;
    return (
      <LiveCalc
        l={l}
        w={w}
        h={h}
        kg={kg}
        desiDivisor={desiDivisor}
        barem={barem}
        extra={
          hint ? (
            <View style={st.hint} accessibilityRole="text">
              <Icon name="info" size={14} color={colors.primary} strokeWidth={2} />
              <Text style={st.hintTxt}>{hint}</Text>
            </View>
          ) : null
        }
      />
    );
  }
  const v = limitView(packaging, kg, { l, w, h }, ctx.limits)!;
  const name = ctx.label(packaging);
  if (!v.known) return <Banner kind="info" text={t('packaging.unknownLimit')} />;
  const tone = v.ok === true ? 'ok' : v.ok === false ? 'over' : 'neutral';
  const box = tone === 'ok' ? st.boxOk : tone === 'over' ? st.boxOver : st.boxNeutral;
  const ink = tone === 'ok' ? colors.success : tone === 'over' ? colors.warning : colors.text;
  const title = tone === 'ok' ? t('packaging.within', { name }) : tone === 'over' ? t('packaging.over', { name }) : t('packaging.limit', { name });
  const overW = v.reasons.includes('WEIGHT');
  const overV = v.reasons.includes('VOLUME');
  const overD = v.reasons.includes('DIMENSION');
  const userEdges = l && w && h && l > 0 && w > 0 && h > 0 ? edgesText([l, w, h]) : '–';
  return (
    <View style={[st.box, box]} accessibilityLabel={title}>
      <View style={st.boxHd}>
        {tone !== 'neutral' ? <Icon name={tone === 'ok' ? 'check' : 'warn'} size={16} color={ink} strokeWidth={2.2} /> : null}
        <Text style={[st.boxT, { color: ink }]}>{title}</Text>
      </View>
      <LimitRow label={t('packaging.weight')} value={`${kg !== null && kg > 0 ? fmtNum(kg, 2) : '–'} / ${kgText(v.maxKg!)} kg`} warn={overW} />
      {v.maxVolumeCm3 !== null ? (
        <LimitRow label={t('packaging.volume')} value={`${v.volumeCm3 !== null ? volText(v.volumeCm3) : '–'} / ${volText(v.maxVolumeCm3)} cm³`} warn={overV} />
      ) : null}
      {v.maxEdgesCm !== null ? <LimitRow label={t('packaging.dimension')} value={`${userEdges} / ${edgesText(v.maxEdgesCm)} cm`} warn={overD} /> : null}
      <View style={[st.boxFoot, { borderTopColor: tone === 'ok' ? colors.successLine : tone === 'over' ? colors.border : colors.borderSoft }]}>
        {tone === 'ok' ? (
          <View style={st.limitRow}>
            <Text style={st.limitL}>{t('packaging.chargeableNoDesi')}</Text>
            <Text style={[st.limitV, { color: colors.success }]}>{fmtNum(v.chargeableKg, 1)} kg</Text>
          </View>
        ) : tone === 'over' ? (
          <Text style={[st.limitL, { color: colors.warningInk }]}>{overPricedText(packaging, kg, { l, w, h }, ctx, t)}</Text>
        ) : (
          <Text style={st.limitL}>{t('packaging.enterValues')}</Text>
        )}
      </View>
    </View>
  );
}

function LimitRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={st.limitRow}>
      <Text style={st.limitL}>{label}</Text>
      <Text style={[st.limitV, warn && { color: colors.warning }]}>{value}</Text>
    </View>
  );
}

type T = (key: string, opts?: Record<string, unknown>) => string;

function fitText(p: Exclude<Packaging, 'OWN'>, ctx: PackagingContext, t: T): string {
  const name = ctx.label(p);
  const lim = p === 'PAK' ? ctx.limits.PAK : ctx.limits.ENVELOPE;
  const vol = p === 'PAK' ? (ctx.limits.PAK?.maxVolumeCm3 ?? null) : null;
  const edges = p === 'ENVELOPE' ? (ctx.limits.ENVELOPE?.maxEdgesCm ?? null) : null;
  const kg = kgText(lim?.maxKg ?? 0);
  if (edges) return t('packaging.fitsHintEdges', { name, kg, edges: edgesText(edges) });
  return vol !== null ? t('packaging.fitsHintVolume', { name, kg, volume: volText(vol) }) : t('packaging.fitsHint', { name, kg });
}

function overPricedText(p: Packaging, kg: number | null, dims: Dims3, ctx: PackagingContext, t: T): string {
  const warn = packagingWarning(p, kg, dims, ctx.limits);
  const priced = warn?.kind === 'over' ? warn.priced : 'OWN';
  return priced === 'OWN' ? t('packaging.pricedOwn') : t('packaging.pricedAs', { name: ctx.label(priced) });
}

function carrierName(carrier: PackagingCarrier | null, t: T): string {
  return carrier ? t(`packaging.carrier.${carrier}`) : t('packaging.carrierFallback');
}

/** Uyarının başlığı ve metni (özet ve düzeltme ekranı). */
export function packagingWarningText(warn: PackagingWarning, v: { kg: number; dims: { l: number; w: number; h: number } }, ctx: PackagingContext, t: T) {
  if (warn.kind === 'suggest') {
    const name = ctx.label(warn.to);
    return {
      title: t('packaging.suggestTitle', { name }),
      text: t('packaging.suggestText', { name, kg: fmtNum(v.kg, 2), dims: fmtDims(v.dims.l, v.dims.w, v.dims.h) }),
    };
  }
  const name = ctx.label(warn.from);
  const lim: PackagingLimits = ctx.limits;
  const max = warn.from === 'PAK' ? lim.PAK : lim.ENVELOPE;
  const parts: string[] = [];
  if (warn.reasons.includes('WEIGHT')) parts.push(t('packaging.overWeight', { kg: fmtNum(v.kg, 2), name, max: kgText(max?.maxKg ?? 0) }));
  if (warn.reasons.includes('VOLUME') && warn.from === 'PAK' && lim.PAK?.maxVolumeCm3 != null) {
    const vol = volumeCm3(v.dims);
    parts.push(t('packaging.overVolume', { volume: volText(vol), name, max: volText(lim.PAK.maxVolumeCm3) }));
  }
  const edges = warn.from === 'ENVELOPE' ? lim.ENVELOPE?.maxEdgesCm : null;
  if (warn.reasons.includes('DIMENSION') && edges) {
    parts.push(t('packaging.overDimension', { dims: edgesText([v.dims.l, v.dims.w, v.dims.h]), name, max: edgesText(edges) }));
  }
  const carrier = carrierName(ctx.carrier, t);
  parts.push(warn.priced === 'OWN' ? t('packaging.overOwn', { carrier }) : t('packaging.overAs', { carrier, name: ctx.label(warn.priced) }));
  return { title: t('packaging.over', { name }), text: parts.join(' ') };
}

/**
 * Ambalaj onayı (özet ve düzeltme ekranı), "akla aykırı değer" onayıyla aynı desen: uyarı varsa kişi iki düğmeden birine
 * basmadan kayıt yapılmaz. Biri seçimi değiştirir (`onChange`), öbürü olduğu gibi onaylar. Ambalaj, ağırlık, ölçü ya da
 * sınır değişince onay düşer. `active: false`: sorulmaz.
 */
export function usePackagingCheck(
  v: Dims3 & { packaging: Packaging; kg: number | null; ctx: PackagingContext; onChange: (p: Packaging) => void; active?: boolean },
) {
  const { t } = useTranslation('measure');
  const dims = { l: v.l, w: v.w, h: v.h };
  const warn = v.active === false ? null : packagingWarning(v.packaging, v.kg, dims, v.ctx.limits);
  const checkKey = packagingCheckKey(v.packaging, v.kg, dims, v.ctx.limits);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const needsConfirm = warn !== null && confirmedKey !== checkKey;
  let banner = null;
  if (needsConfirm && warn) {
    const { title, text } = packagingWarningText(warn, { kg: v.kg!, dims: dims as { l: number; w: number; h: number } }, v.ctx, t);
    const change = warn.kind === 'suggest' ? warn.to : 'OWN';
    banner = (
      <Banner
        kind="warn"
        title={title}
        text={text}
        action={
          <>
            <Button
              label={warn.kind === 'suggest' ? t('packaging.suggestUse', { name: v.ctx.label(warn.to) }) : t('packaging.useOwn')}
              small
              onPress={() => v.onChange(change)}
            />
            <Button
              label={warn.kind === 'suggest' ? t('packaging.suggestKeep') : t('packaging.keepAnyway', { name: v.ctx.label(warn.from) })}
              kind="secondary"
              small
              onPress={() => setConfirmedKey(checkKey)}
            />
          </>
        }
      />
    );
  }
  return { needsConfirm, banner };
}

const st = StyleSheet.create({
  hd: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
  secH: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  seg: { flexDirection: 'row', backgroundColor: colors.borderSoft, borderRadius: radius.control, padding: 3, gap: 3 },
  segItem: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 4,
    borderRadius: radius.control - 2,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  segOn: { backgroundColor: colors.surface, borderColor: colors.primaryLine },
  segPressed: { backgroundColor: colors.surface },
  segTxt: { fontSize: 13, lineHeight: 17, color: colors.text2, textAlign: 'center', ...font.medium },
  segTxtOn: { color: colors.primaryHover, ...font.semibold },
  hint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  hintTxt: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  box: { borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 10, gap: 6 },
  boxOk: { backgroundColor: colors.successBg, borderColor: colors.successLine },
  boxOver: { backgroundColor: colors.warningBg, borderColor: colors.border },
  boxNeutral: { backgroundColor: colors.surface, borderColor: colors.border },
  boxHd: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  boxT: { fontSize: 14, lineHeight: 19, ...font.semibold },
  boxFoot: { borderTopWidth: 1, paddingTop: 8 },
  limitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  limitL: { flexShrink: 1, fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  limitV: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold, fontVariant: ['tabular-nums'] },
});
