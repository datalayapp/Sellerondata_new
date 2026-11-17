import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, type TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as SecureStore from 'expo-secure-store';
import { useAuth } from '../../src/auth/AuthContext';
import { authErrorKey, looksLikeIdentifier } from '../../src/auth/errors';
import { ApiError, DEFAULT_SERVER_URL, getServerUrl, K_REMEMBER, SERVER_EDITABLE, setServerUrl } from '../../src/api/client';
import { Banner, Button, Card, Footer, Header, TextField } from '../../src/ui/components';
import { Icon } from '../../src/ui/Icon';
import { LangPicker } from '../../src/hub/ui';
import { OtherSessionsBanner } from '../../src/ui/OtherSessionsBanner';
import { colors, font, radius, space, type } from '../../src/ui/theme';
import { setLocale } from '../../src/i18n';

const K_LAST_IDENTIFIER = 'sod_last_identifier';
/** Girişten önceki dil seçimi cihazda kalır; giriş yapınca kişinin hesabındaki dil geçerlidir. */
const K_LOGIN_LOCALE = 'sod_login_locale';

export default function Login() {
  const { t } = useTranslation('auth');
  const { login, expired } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(true);
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    SecureStore.getItemAsync(K_LAST_IDENTIFIER).then((v) => v && setIdentifier(v));
    SecureStore.getItemAsync(K_REMEMBER).then((v) => v === '0' && setRemember(false));
    SecureStore.getItemAsync(K_LOGIN_LOCALE).then((v) => {
      if (v === 'tr' || v === 'en') void setLocale(v);
    });
    setServer(getServerUrl());
  }, []);

  const submit = async () => {
    if (!identifier.trim() || !pass) {
      setError(t('login.missing'));
      return;
    }
    if (!looksLikeIdentifier(identifier)) {
      setError(t('login.notIdentifier'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await SecureStore.setItemAsync(K_LAST_IDENTIFIER, identifier.trim());
      await SecureStore.setItemAsync(K_REMEMBER, remember ? '1' : '0');
      await login(server || DEFAULT_SERVER_URL, identifier, pass);
    } catch (e) {
      if (e instanceof ApiError) {
        const key = authErrorKey(e, 'login');
        setError(key ? t(key) : e.message);
      } else setError(t('errors.UNKNOWN'));
    } finally {
      setBusy(false);
    }
  };

  // Yazılan sunucu adresi davet akışında da geçerli olsun.
  const openJoin = () => {
    setServerUrl(server).finally(() => router.push('/join'));
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={undefined}>
      <Header title={t('login.title')} subtitle={t('brand.tagline')} subtitleMono={false} />
      <ScrollView contentContainerStyle={st.page} keyboardShouldPersistTaps="handled">
        <Card style={st.form}>
          <TextField
            label={t('login.identifier')}
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            keyboardType="email-address"
            returnKeyType="next"
            onSubmitEditing={() => passRef.current?.focus()}
            placeholder={t('login.identifierPlaceholder')}
          />
          <TextField
            ref={passRef}
            label={t('login.password')}
            value={pass}
            onChangeText={setPass}
            secureTextEntry={!showPass}
            autoCapitalize="none"
            autoComplete="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            placeholder={t('login.passwordPlaceholder')}
            right={
              <Pressable
                onPress={() => setShowPass((v) => !v)}
                style={st.showBtn}
                accessibilityRole="button"
                accessibilityLabel={showPass ? t('login.hidePassword') : t('login.showPassword')}
              >
                <Icon name={showPass ? 'eyeOff' : 'eye'} size={22} color={colors.text3} />
              </Pressable>
            }
          />

          <Pressable style={st.check} onPress={() => setRemember((v) => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: remember }}>
            <View style={[st.box, remember && st.boxOn]}>{remember ? <Icon name="check" color="#fff" size={16} strokeWidth={2.6} /> : null}</View>
            <Text style={st.checkTxt}>{t('login.remember')}</Text>
          </Pressable>
        </Card>

        {error ? <Banner kind="error" text={error} /> : expired ? <Banner kind="info" title={t('login.expiredTitle')} text={t('login.expiredText')} /> : null}

        <Button label={t('login.haveCode')} kind="secondary" onPress={openJoin} disabled={busy} />
        <Text style={st.hint}>{t('login.forgotHint')}</Text>
        <OtherSessionsBanner />

        <LangPicker
          onChange={(locale) => {
            void setLocale(locale);
            void SecureStore.setItemAsync(K_LOGIN_LOCALE, locale);
          }}
        />

        {SERVER_EDITABLE && showServer ? (
          <View style={st.serverBox}>
            <TextField
              label={t('server.label')}
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputStyle={{ fontSize: 15 }}
              monoValue
              hint={t('server.hint', { url: DEFAULT_SERVER_URL })}
            />
          </View>
        ) : null}

        {SERVER_EDITABLE ? (
          <Pressable
            onLongPress={() => setShowServer(true)}
            onPress={() => setShowServer((v) => !v)}
            style={st.serverLink}
            accessibilityRole="button"
            accessibilityLabel={t('server.change')}
          >
            <Icon name="gear" size={16} color={colors.text3} />
            <Text style={st.serverTxt} numberOfLines={1}>
              {server}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <Footer>
        <Button label={t('login.submit')} iconRight="arrow" onPress={submit} loading={busy} large />
      </Footer>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  page: { flexGrow: 1, padding: space.lg, gap: space.md },
  form: { gap: space.lg, padding: space.lg },
  showBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  box: { width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkTxt: { fontSize: 14, lineHeight: 20, color: colors.text, ...font.regular },
  hint: { ...type.small },
  serverBox: { padding: space.lg, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  serverLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 48 },
  serverTxt: { color: colors.text3, fontSize: 12, maxWidth: '80%', ...font.mono },
});
