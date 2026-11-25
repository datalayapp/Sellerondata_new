import type React from 'react';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, type TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { JoinPreview } from '@sellerondata/contracts';
import { ApiError, getServerUrl } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { authErrorKey, joinCodeComplete, looksLikePhone, PASSWORD_MIN_LENGTH, type ErrorContext } from '../../src/auth/errors';
import { Banner, Button, Card, Footer, Header, Screen, TextField } from '../../src/ui/components';
import { Icon } from '../../src/ui/Icon';
import { colors, font, space } from '../../src/ui/theme';

export default function Join() {
  const { t } = useTranslation('auth');
  const { joinPreview, joinAccept } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const passRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const showError = (e: unknown, context: ErrorContext) => {
    if (e instanceof ApiError) {
      const key = authErrorKey(e, context);
      setError(key ? t(key, { min: PASSWORD_MIN_LENGTH }) : e.message);
    } else setError(t('errors.UNKNOWN'));
  };

  const check = async () => {
    if (!looksLikePhone(phone)) return setError(t('join.phoneInvalid'));
    if (!joinCodeComplete(code)) return setError(t('join.codeIncomplete'));
    setBusy(true);
    setError(null);
    try {
      const p = await joinPreview(getServerUrl(), phone, code);
      setPreview(p);
      setName(p.name ?? '');
      setPassword('');
    } catch (e) {
      showError(e, 'joinCode');
    } finally {
      setBusy(false);
    }
  };

  /** Kişi yeniyse ve şifre kodundaysa yeni şifre; kişi varsa mevcut şifre onayı (kod şifre belirletmez). */
  const needsNewPassword = !preview?.personExists || preview.purpose === 'PASSWORD_RESET';
  const needsName = !preview?.personExists && preview?.purpose !== 'PASSWORD_RESET';

  const accept = async () => {
    if (needsName && !name.trim()) return setError(t('join.nameMissing'));
    if (needsNewPassword && password.length < PASSWORD_MIN_LENGTH) return setError(t('join.passwordShort', { min: PASSWORD_MIN_LENGTH }));
    if (!password) return setError(t('login.missing'));
    setBusy(true);
    setError(null);
    try {
      await joinAccept({ phone, code, ...(needsName ? { name } : {}), password });
    } catch (e) {
      showError(e, 'joinAccept');
      // Kod artık geçersizse şifre sormak anlamsız: koda dön.
      if (e instanceof ApiError && (e.code === 'INVITE_INVALID' || e.code === 'ALREADY_MEMBER')) setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const eye = (
    <Pressable
      onPress={() => setShowPass((v) => !v)}
      style={st.showBtn}
      accessibilityRole="button"
      accessibilityLabel={showPass ? t('login.hidePassword') : t('login.showPassword')}
    >
      <Icon name={showPass ? 'eyeOff' : 'eye'} size={22} color={colors.text3} />
    </Pressable>
  );

  if (!preview) {
    return (
      <View style={{ flex: 1 }}>
        <Header title={t('join.title')} back onBack={() => router.back()} />
        <Screen>
          <Text style={st.lead}>{t('join.lead')}</Text>
          <Card style={{ gap: space.lg, padding: space.lg }}>
            <TextField
              label={t('join.phone')}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="next"
              onSubmitEditing={() => codeRef.current?.focus()}
              placeholder={t('join.phonePlaceholder')}
            />
            <TextField
              ref={codeRef}
              label={t('join.code')}
              value={code}
              onChangeText={setCode}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={12}
              monoValue
              returnKeyType="go"
              onSubmitEditing={check}
              placeholder={t('join.codePlaceholder')}
            />
          </Card>
          {error ? <Banner kind="error" text={error} /> : null}
        </Screen>
        <Footer>
          <Button label={t('join.continue')} iconRight="arrow" onPress={check} loading={busy} large />
        </Footer>
      </View>
    );
  }

  const isReset = preview.purpose === 'PASSWORD_RESET';
  const title = isReset ? t('join.resetTitle') : preview.personExists ? t('join.existingTitle') : t('join.newTitle');
  const lead = isReset ? t('join.resetLead', { org: preview.orgName }) : preview.personExists ? t('join.existingLead') : t('join.newLead');

  return (
    <View style={{ flex: 1 }}>
      <Header
        title={title}
        back
        onBack={() => {
          setPreview(null);
          setError(null);
        }}
      />
      <Screen>
        {!isReset ? <Text style={st.org}>{t('join.joinOrg', { org: preview.orgName })}</Text> : null}
        <Text style={st.lead}>{lead}</Text>
        <Card style={{ gap: space.lg, padding: space.lg }}>
          {needsName ? (
            <TextField
              label={t('join.name')}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoComplete="name"
              returnKeyType="next"
              onSubmitEditing={() => passRef.current?.focus()}
            />
          ) : null}
          <TextField
            ref={passRef}
            label={needsNewPassword ? t('join.newPassword') : t('join.currentPassword')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPass}
            autoCapitalize="none"
            autoComplete={needsNewPassword ? 'new-password' : 'current-password'}
            returnKeyType="go"
            onSubmitEditing={accept}
            placeholder={needsNewPassword ? t('join.newPasswordPlaceholder', { min: PASSWORD_MIN_LENGTH }) : t('login.passwordPlaceholder')}
            right={eye}
          />
        </Card>
        {error ? <Banner kind="error" text={error} /> : null}
      </Screen>
      <Footer>
        <Button label={isReset ? t('join.acceptReset') : t('join.accept')} iconRight="arrow" onPress={accept} loading={busy} large />
      </Footer>
    </View>
  );
}

const st = StyleSheet.create({
  org: { fontSize: 16, lineHeight: 22, color: colors.text, ...font.semibold },
  lead: { fontSize: 13, lineHeight: 18, color: colors.text2, ...font.regular },
  showBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
