import { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../src/auth/AuthContext';
import { fetchMembers, fetchOrgRoles, inviteByPhone } from '../../../src/hub/api';
import { ORG_ROLE_LABEL, PRODUCTS, type OrgRolesResponse, type ProductKey } from '../../../src/hub/contracts';
import { useHub } from '../../../src/hub/HubContext';
import { defaultInviteRole, initialInviteForm, inviteBody, inviteError, inviteTools, NAME_MAX_LENGTH, resolveInviteRoles, validateInvite, type InviteError, type InviteFieldError, type InviteForm, type InviteRoleOption, type InviteRoleSource } from '../../../src/hub/invite';
import { WEB_ROUTES } from '../../../src/hub/links';
import { BottomSheet, hub, HubPage, InkButton, SectionError, Skel, StaleNote, useAgo, WebLink } from '../../../src/hub/ui';
import { useHubResource } from '../../../src/hub/useHubResource';
import { teamView, type TeamRow } from '../../../src/hub/views';
import { Badge, Banner, Button, EmptyState, TextField } from '../../../src/ui/components';
import { useToast } from '../../../src/ui/Toast';
import { colors, font, hubColors, radius, type as typo } from '../../../src/ui/theme';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase())
    .join('');

function Person({ row, first }: { row: TeamRow; first: boolean }) {
  const { t } = useTranslation('hub');
  const agoText = useAgo();
  const seen = row.lastActiveAt ? t('team.lastActive', { when: agoText(row.lastActiveAt) }) : t('team.neverActive');
  return (
    <View style={[st.person, !first && hub.hair, row.suspended && { backgroundColor: colors.surface2 }]}>
      <View style={[st.av, row.suspended && st.avOff]} accessible={false}>
        <Text style={[st.avTxt, row.suspended && { color: colors.text2 }]}>{initials(row.name)}</Text>
      </View>
      <View style={st.main}>
        <Text style={[st.name, row.suspended && { color: colors.text2 }]} numberOfLines={2}>
          {row.name}
        </Text>
        <Text style={st.seen}>{seen}</Text>
        {row.tools.length ? (
          <Text style={st.tool}>
            {row.tools.map((tool, i) => (
              <Text key={tool.key}>
                {i > 0 ? ' · ' : ''}
                {tool.name}: <Text style={tool.role ? st.toolRole : st.toolNone}>{tool.role ?? t('team.noAccess')}</Text>
              </Text>
            ))}
          </Text>
        ) : null}
      </View>
      <View style={st.tags}>
        <Text style={st.role} numberOfLines={1}>
          {row.orgRole}
        </Text>
        {row.suspended ? <Badge kind="warning" label={t('team.suspended')} /> : null}
      </View>
    </View>
  );
}

/** Araç rolü seçimi: yalnız telefondan verilebilen roller (firmanın rol listesinden, yoksa katalogdan; yönetici rolü yok). Seçili rolün açıklaması altta. */
function RoleChips({ tool, options, value, onChange }: { tool: ProductKey; options: readonly InviteRoleOption[]; value: string | null; onChange: (role: string) => void }) {
  const { t } = useTranslation('hub');
  const label = t('team.add.toolRole', { tool: PRODUCTS[tool].name });
  const picked = options.find((o) => o.key === value);
  return (
    <View style={{ gap: 6 }}>
      <Text style={st.fieldLabel}>{label}</Text>
      <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.key)}
              style={({ pressed }) => [st.chip, on && st.chipOn, pressed && !on && { backgroundColor: colors.surface2 }]}
            >
              <Text style={[st.chipTxt, on && st.chipTxtOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {picked ? <Text style={typo.small}>{picked.description}</Text> : null}
    </View>
  );
}

function errorText(e: InviteError, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (e.key) {
    case 'limitIn':
      return t('team.add.limitIn', { minutes: e.minutes });
    case 'limit':
      return t('team.add.limit');
    case 'phoneInvalid':
      return t('team.add.phoneInvalid');
    case 'alreadyMember':
      return t('team.add.alreadyMember');
    case 'forbidden':
      return t('team.add.forbidden');
    case 'network':
      return t('error.network');
    default:
      return e.message ?? t('error.server');
  }
}

type Sheet = { step: 'form' } | { step: 'code'; code: string; name: string } | null;

/**
 * Çalışan ekleme: ad, telefon ve araç rolü; firma rolü hep çalışan. "Kod üret" web'in telefon + kod davetiyle aynı ucu çağırır.
 * Kod yalnız bir kez gösterilir; "Mesajı paylaş" telefonun paylaşma ekranını açar (WhatsApp vb.).
 */
function AddPerson({ sheet, setSheet, roles }: { sheet: Sheet; setSheet: (s: Sheet) => void; roles: OrgRolesResponse | null }) {
  const { t } = useTranslation('hub');
  const { me } = useAuth();
  const { webUrl, lng } = useHub();
  const toast = useToast();
  const tools = inviteTools(me);
  const locale = lng === 'en' ? 'en' : 'tr';
  // Rol listesi sonradan gelebilir: seçenekler her çizimde çözülür, seçim listede yoksa varsayılana döner.
  const source: InviteRoleSource = resolveInviteRoles(roles, tools, me?.activeOrg?.orgRole, locale);
  const [form, setForm] = useState<InviteForm>(() => initialInviteForm(tools, source));
  const valueOf = (k: ProductKey) => {
    const v = form.roles[k];
    return v && source[k]?.some((o) => o.key === v) ? v : defaultInviteRole(k, source);
  };
  const [fieldErr, setFieldErr] = useState<InviteFieldError>({});
  const [failure, setFailure] = useState<InviteError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const check = validateInvite(form);
    setFieldErr(check);
    setFailure(null);
    if (check.name || check.phone) return;
    setBusy(true);
    try {
      const r = await inviteByPhone(inviteBody({ ...form, roles: Object.fromEntries(tools.map((k) => [k, valueOf(k)])) }, tools, source));
      if (!r?.code) {
        setFailure({ key: 'server', message: null });
        return;
      }
      setSheet({ step: 'code', code: r.code, name: form.name.trim() });
      setForm(initialInviteForm(tools, source));
      setFieldErr({});
    } catch (e) {
      // Form silinmez: kişi düzeltir ya da biraz sonra yeniden dener (web gibi).
      const err = inviteError(e);
      if (err.key === 'phoneInvalid') setFieldErr({ phone: 'invalid' });
      else setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const share = (code: string) => {
    const message = t('team.add.message', { org: me?.activeOrg?.name ?? '', url: webUrl(WEB_ROUTES.join), code });
    Share.share({ message }).catch(() => toast.show({ text: t('team.add.shareFailed'), kind: 'error' }));
  };

  const nameErr = fieldErr.name === 'required' ? t('team.add.nameRequired') : fieldErr.name === 'tooLong' ? t('team.add.nameTooLong', { max: NAME_MAX_LENGTH }) : undefined;
  const phoneErr = fieldErr.phone === 'required' ? t('team.add.phoneRequired') : fieldErr.phone === 'invalid' ? t('team.add.phoneInvalid') : undefined;

  return (
    <>
      <BottomSheet visible={sheet?.step === 'form'} title={t('team.add.title')} onClose={() => setSheet(null)} locked={busy}>
        <Text style={typo.small}>{t('team.add.help')}</Text>
        <TextField
          label={t('team.add.name')}
          value={form.name}
          onChangeText={(name) => setForm((f) => ({ ...f, name }))}
          autoCapitalize="words"
          autoComplete="off"
          maxLength={NAME_MAX_LENGTH}
          returnKeyType="next"
          error={nameErr}
        />
        <TextField
          label={t('team.add.phone')}
          value={form.phone}
          onChangeText={(phone) => setForm((f) => ({ ...f, phone }))}
          keyboardType="phone-pad"
          autoComplete="off"
          maxLength={40}
          placeholder={t('team.add.phonePlaceholder')}
          error={phoneErr}
        />
        {tools.map((k) => (
          <RoleChips key={k} tool={k} options={source[k] ?? []} value={valueOf(k)} onChange={(role) => setForm((f) => ({ ...f, roles: { ...f.roles, [k]: role } }))} />
        ))}
        <Text style={typo.small}>{t('team.add.orgRole', { role: ORG_ROLE_LABEL.MEMBER[locale] })}</Text>
        {failure ? <Banner kind="error" title={t('team.add.failed')} text={errorText(failure, t)} /> : null}
        <InkButton label={t('team.add.submit')} onPress={() => void submit()} loading={busy} />
        <Button kind="ghost" label={t('team.add.cancel')} disabled={busy} onPress={() => setSheet(null)} />
      </BottomSheet>

      {/* Kod bir kez gösterilir: dışına dokunmak ve geri tuşu kapatmaz, yalnız "Kapat". */}
      <BottomSheet visible={sheet?.step === 'code'} title={sheet?.step === 'code' ? t('team.add.codeTitle', { name: sheet.name }) : ''} onClose={() => setSheet(null)} locked>
        {sheet?.step === 'code' ? (
          <>
            <Text style={st.code} selectable accessibilityLabel={`${t('team.add.codeA11y')}: ${sheet.code.split('').join(' ')}`}>
              {sheet.code}
            </Text>
            <Banner kind="warn" text={t('team.add.codeOnce')} />
            <Text style={typo.small}>{t('team.add.codeHow', { url: webUrl(WEB_ROUTES.join) })}</Text>
            <InkButton label={t('team.add.share')} onPress={() => share(sheet.code)} />
            <Text style={[typo.small, { textAlign: 'center' }]}>{t('team.add.copyHint')}</Text>
            <Button kind="secondary" label={t('team.add.close')} onPress={() => setSheet(null)} />
          </>
        ) : null}
      </BottomSheet>
    </>
  );
}

/**
 * Ekip: kişiler ve rolleri, en üstte tek birincil eylem "Çalışan ekle" (yalnız firma sahibi ve yöneticisi: web Ekip sayfası ve
 * sunucu `requireManager` ile aynı kural). Rol değiştirme, davet iptali ve yönetici daveti bilerek burada yok: web'de.
 */
export default function Team() {
  const { t } = useTranslation('hub');
  const { scope, lng, canTeam } = useHub();
  const { me } = useAuth();
  const [sheet, setSheet] = useState<Sheet>(null);
  const res = useHubResource(canTeam ? `${scope}:team` : null, fetchMembers);
  // Davet formunun rol listesi (bir kez; eski sunucuda ya da hata olursa null: katalog listesi).
  const roles = useHubResource(canTeam ? `${scope}:orgRoles` : null, fetchOrgRoles);
  if (!canTeam || res.status === 'forbidden') return <Redirect href="/hub" />;
  const view = res.data ? teamView(res.data, lng, me, t('customRole')) : null;

  return (
    <HubPage onRefresh={res.refresh}>
      <InkButton icon="plus" label={t('team.add.action')} onPress={() => setSheet({ step: 'form' })} />
      <StaleNote failed={res.failed} at={res.at} onRetry={() => void res.refresh()} />
      {res.status === 'loading' ? (
        <View style={[hub.sheet, hub.sheetPad, { gap: 16 }]} accessibilityState={{ busy: true }}>
          <Skel w="60%" />
          <Skel w="75%" />
          <Skel w="50%" />
        </View>
      ) : null}
      {res.status === 'error' ? <SectionError title={t('team.error')} kind={res.failed} onRetry={() => void res.refresh()} /> : null}
      {view && view.rows.length === 0 ? <EmptyState icon="user" title={t('team.emptyTitle')} text={t('team.emptyBody')} /> : null}
      {view && view.rows.length > 0 ? (
        <>
          <Text style={st.summary}>{t('team.summary', { active: view.active, suspended: view.suspended })}</Text>
          <View style={hub.sheet}>
            {view.rows.map((row, i) => (
              <Person key={row.id} row={row} first={i === 0} />
            ))}
          </View>
        </>
      ) : null}
      <WebLink label={t('team.web')} path={WEB_ROUTES.team} />
      <AddPerson sheet={sheet} setSheet={setSheet} roles={roles.data ?? null} />
    </HubPage>
  );
}

const st = StyleSheet.create({
  summary: { fontSize: 14, lineHeight: 20, color: colors.text, ...font.medium },
  person: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, minHeight: 56 },
  av: { width: 36, height: 36, borderRadius: 6, backgroundColor: hubColors.inkSoft, alignItems: 'center', justifyContent: 'center' },
  avOff: { backgroundColor: '#efede8' },
  avTxt: { fontSize: 13, lineHeight: 18, color: hubColors.ink, ...font.semibold },
  main: { flex: 1, minWidth: 0, gap: 1 },
  name: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
  tags: { alignItems: 'flex-end', gap: 4, maxWidth: '36%' },
  role: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  tool: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  toolRole: { color: colors.text, ...font.medium },
  toolNone: { color: colors.text3 },
  seen: { ...typo.small },

  fieldLabel: { ...typo.label },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  chipOn: { backgroundColor: hubColors.inkSoft, borderColor: hubColors.ink },
  chipTxt: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.medium },
  chipTxtOn: { color: hubColors.ink, ...font.semibold },
  code: { textAlign: 'center', fontSize: 30, lineHeight: 38, letterSpacing: 4, color: hubColors.ink, ...font.monoSemibold, paddingVertical: 14, borderRadius: radius.card, backgroundColor: colors.surface2 },
});
