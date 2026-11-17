import { useRef, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../../src/auth/AuthContext';
import { useDraft } from '../../../src/draft/DraftContext';
import { draftAfterSave, saveDraftToQueue } from '../../../src/draft/persist';
import { useQueue } from '../../../src/queue/QueueContext';
import { Badge, Banner, Button, Card, Footer, Header, Screen, TextField } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/Icon';
import { LiveCalc } from '../../../src/ui/LiveCalc';
import { colors, font, radius } from '../../../src/ui/theme';
import { useToast } from '../../../src/ui/Toast';
import { dimMethodLabel, kindLabel, fmtDims, fmtNum } from '../../../src/lib/format';
import { usePlausibilityCheck } from '../../../src/ui/PlausibilityCheck';
import { friendlyError } from '../../../src/api/errors';

export default function Summary() {
  const { t } = useTranslation('measure');
  const { me, settings } = useAuth();
  const { draft, ready, update, reset } = useDraft();
  const { enqueue, editLocal, getLocal, online } = useQueue();
  const toast = useToast();
  const [saving, setSaving] = useState<'new' | 'home' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const boxCount = draft.photos.filter((p) => p.kind === 'PHOTO_BOX').length;
  const problems: string[] = [];
  if (!draft.trackingRaw) problems.push(t('summary.noTracking'));
  if (!draft.weightKg) problems.push(t('summary.noWeight'));
  if (!draft.lengthCm || !draft.widthCm || !draft.heightCm) problems.push(t('summary.noDims'));
  if (boxCount < settings.requiredBoxPhotos) problems.push(t('summary.noBoxPhotos', { boxCount, required: settings.requiredBoxPhotos }));

  // Akla aykırı değer: kayıttan önce kişi "Değerler doğru" der. Ölçü ya da ağırlık değişince onay düşer. Eşikler firma ayarı.
  const check = usePlausibilityCheck({ l: draft.lengthCm, w: draft.widthCm, h: draft.heightCm, kg: draft.weightKg, settings });
  const needsConfirm = check.needsConfirm;
  const blocked = problems.length > 0 || needsConfirm;

  // Aynı karede iki dokunuş: durum güncellenmeden ikinci kayıt başlamasın.
  const savingRef = useRef(false);

  const save = async (then: 'new' | 'home') => {
    if (!ready || blocked || !me || savingRef.current) return;
    savingRef.current = true;
    setSaving(then);
    setErr(null);
    try {
      // Kayıt kimliği taslağın kimliğidir. Önceki deneme yarıda kaldıysa kuyruktaki satır güncel değerlerle güncellenir.
      const outcome = await saveDraftToQueue(draft, new Date(), { getLocal, enqueue, editLocal });
      if (draftAfterSave(outcome) === 'keep') {
        // Şu an gönderiliyor, sonuç belli değil: taslak silinmez, ekran kalır. Gönderim başarısız olursa satır kuyrukta
        // bekler; kişi yeniden Kaydet'e basınca taslaktaki son değerler satıra yazılır.
        Alert.alert(t('summary.sending'), t('summary.sendingText'));
        setSaving(null);
        return;
      }
      if (outcome === 'alreadySent') {
        // Bu kimlikle kayıt gönderilmiş: ikinci kayıt açılmaz, taslak düşer.
        reset(true);
        Alert.alert(t('summary.alreadySent'), t('summary.alreadySentText'));
        router.dismissTo('/deciship/today');
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      const tracking = draft.trackingRaw;
      reset(true);
      if (then === 'new') {
        // Yeni okutma ekranına geçilirken kaydın alındığı kısa bir bildirimle söylenir.
        toast.show({ text: t('summary.savedToast', { tracking }), kind: 'success', icon: 'check', durationMs: 2500 });
        router.dismissTo('/deciship/today');
        router.push('/deciship/scan');
      } else {
        router.dismissTo({ pathname: '/deciship/today', params: { saved: tracking } });
      }
    } catch (e) {
      setErr(friendlyError(e, 'save').text);
      setSaving(null);
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('summary.title')} subtitle={draft.trackingRaw} back step={5} />
      <Screen>
        {/* Yalnızca çevrimdışıyken bilgi verilir; "Çevrimiçi" rozeti sunucu kapalıyken de yanıltıcıydı. */}
        {!online ? <Banner kind="warn" icon="cloudoff" text={t('summary.offlineBadge')} /> : null}
        <Card style={{ paddingVertical: 0 }}>
          <Row label={t('summary.tracking')} onEdit={() => router.dismissTo('/deciship/scan')}>
            <Text style={st.trk} numberOfLines={1}>
              {draft.trackingRaw}
            </Text>
          </Row>
          <View style={st.div} />
          <Row label={t('summary.weight')} onEdit={() => router.dismissTo('/deciship/weight')}>
            <View style={st.inline}>
              <Text style={st.v}>
                {fmtNum(draft.weightKg, 2)}
                <Text style={st.u}> kg</Text>
              </Text>
              <Badge label={draft.weightMethod === 'OCR' ? t('summary.fromPhoto') : t('summary.manual')} kind={draft.weightMethod === 'OCR' ? 'info' : 'neutral'} dot={false} />
            </View>
          </Row>
          <View style={st.div} />
          <Row label={t('summary.dims')} onEdit={() => router.dismissTo('/deciship/dims')}>
            <View style={st.inline}>
              <Text style={st.v} numberOfLines={1}>
                {draft.lengthCm && draft.widthCm && draft.heightCm ? fmtDims(draft.lengthCm, draft.widthCm, draft.heightCm) : '–'}
              </Text>
              <Badge label={dimMethodLabel(draft.dimMethod)} kind="info" dot={false} />
            </View>
          </Row>
        </Card>
        <LiveCalc l={draft.lengthCm} w={draft.widthCm} h={draft.heightCm} kg={draft.weightKg} desiDivisor={settings.desiDivisor} barem />
        <Card>
          <Row label={t('summary.photos', { n: draft.photos.length })} onEdit={() => router.dismissTo('/deciship/photos')} flush>
            {draft.photos.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {draft.photos.map((p) => (
                  <View key={p.id}>
                    <Image source={{ uri: p.uri }} style={st.thumb} />
                    <Text style={st.cap}>{kindLabel(p.kind)}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={st.none}>{t('summary.noPhotos')}</Text>
            )}
          </Row>
        </Card>
        <TextField
          label={t('summary.note')}
          value={draft.note}
          onChangeText={(t) => update({ note: t })}
          placeholder={t('summary.notePlaceholder')}
          maxLength={500}
        />
        {problems.length ? <Banner kind="error" title={t('summary.fixFirst')} text={problems.join(' · ')} /> : null}
        {err ? <Banner kind="error" title={t('summary.saveFailed')} text={t('summary.saveFailedText', { error: err })} /> : null}
      </Screen>
      <Footer>
        {/* Kaydet düğmeleri bu onay olmadan kapalı: neden düğmelerin hemen üstünde görünür. */}
        {!problems.length ? check.banner : null}
        <Button
          label={t('summary.saveNew')}
          icon="scan"
          onPress={() => save('new')}
          loading={saving === 'new'}
          disabled={blocked || saving !== null}
          large
        />
        <Button
          label={t('summary.saveFinish')}
          kind="ghost"
          icon="check"
          onPress={() => save('home')}
          loading={saving === 'home'}
          disabled={blocked || saving !== null}
        />
      </Footer>
    </View>
  );
}

function Row({ label, children, onEdit, flush }: { label: string; children: React.ReactNode; onEdit: () => void; flush?: boolean }) {
  const { t } = useTranslation('measure');
  return (
    <View style={!flush && st.row}>
      <View style={st.rowHd}>
        <Text style={st.lbl}>{label}</Text>
        <Pressable
          onPress={onEdit}
          hitSlop={8}
          style={({ pressed }) => [st.edit, pressed && { backgroundColor: colors.primarySoft }]}
          accessibilityRole="button"
          accessibilityLabel={t('summary.editLabel', { label })}
        >
          <Icon name="edit" size={14} color={colors.primary} strokeWidth={2} />
          <Text style={st.editTxt}>{t('common.edit')}</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
}

const st = StyleSheet.create({
  row: { paddingVertical: 6 },
  div: { height: 1, backgroundColor: colors.borderSoft, marginHorizontal: -10 },
  rowHd: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lbl: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  edit: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: 8, marginRight: -8, marginVertical: -8, borderRadius: radius.control },
  editTxt: { color: colors.primary, fontSize: 13, ...font.medium },
  trk: { fontSize: 16, lineHeight: 22, color: colors.text, ...font.monoSemibold },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  v: { fontSize: 16, lineHeight: 22, color: colors.text, flexShrink: 1, ...font.semibold, fontVariant: ['tabular-nums'] },
  u: { fontSize: 12, color: colors.text2, ...font.regular },
  thumb: { width: 56, height: 56, borderRadius: radius.control, backgroundColor: '#1b2433', borderWidth: 1, borderColor: colors.border, marginTop: 4 },
  cap: { fontSize: 11, color: colors.text2, marginTop: 2, ...font.medium },
  none: { fontSize: 13, color: colors.text2, marginTop: 4, ...font.regular },
});
