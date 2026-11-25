import { cloneElement, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NAME_MAX_LENGTH, SUPPORT_EMAIL, supportMailto, currencyForCountry, PASSWORD_MIN_LENGTH, type VerificationRequiredResponse, type VerifyEmailResponse, LOCALES, ORG_ROLE_LABEL, PRODUCTS, PRODUCT_KEYS, type AuthResponse, type JoinPreview, type Locale } from '@sellerondata/contracts';
import { ApiError, Button, Empty, Icon, LOCALE_NAME, ME_QUERY_KEY, beginSession, useSessionActions, Notice, ProductMark, SellerOnDataMark, Skel, currentLocale, setShellLocale, useMe } from '@sellerondata/shell';
import type { InvitePreview } from '../../api/types.ts';
import { COUNTRIES } from '../account/Company.tsx';
import { apiMessage, useCatalog } from '../../lib/hooks.ts';
import { isHubPath, safeNext } from '../../lib/nav.ts';
import { client } from '../../lib/session.ts';
import { useLogoutAction } from '../../lib/logout.ts';
import { siteHref } from '../../lib/site.ts';

/* Stil: styles/auth.css. */

/** Ürün adları marka adıdır, çevrilmez. Kayıttan: sitede sayfası olan araçlar, kayıt sırasıyla. İşaretler sitenin dosyaları (koyu zemin için çerçeveli); `mark` yoksa tek harfli işaret. */
const BRAND_PRODUCTS = PRODUCT_KEYS.filter((k) => PRODUCTS[k].site !== undefined).map((key) => ({ key, name: PRODUCTS[key].name, mark: PRODUCTS[key].mark }));

/** Sitenin adresi tek yerden (VITE_SITE_URL, `lib/site.ts`). */
const siteUrl = (page: 'home' | 'terms' | 'privacy', lang: string) => siteHref(page, lang === 'en' ? 'en' : 'tr');

/**
 * Deneme sınırına takılınca kalan saniye (Retry-After'dan; saniyede bir azalır). 0'a inince `onDone` çağrılır
 * (hata kaldırılır, düğme yeniden açılır). Kullanıcı isteği 2026-11-13: bekleme süresi geri sayım olarak görünsün.
 */
function useRetryWait(error: unknown, onDone: () => void): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const until = error instanceof ApiError && error.code === 'TOO_MANY_ATTEMPTS' && error.retryAfterSeconds ? Date.now() + error.retryAfterSeconds * 1000 : 0;
    if (!until) {
      setLeft(0);
      return;
    }
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(id);
        onDone();
      }
    };
    // `tick` ilk kez bu atamadan sonra çağrılır: `id` o anda tanımlıdır.
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
    // Yalnız hata nesnesi değişince yeniden kurulur; onDone her çizimde yeni olabilir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  return left;
}

/** "Çok fazla deneme yapıldı. Yeniden deneyebilirsiniz: 4:32". Uyarı rolü bir kez okunur; saniyeler canlı okunmaz. */
function WaitNotice({ seconds }: { seconds: number }) {
  const { t } = useTranslation();
  const m = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <div role="alert">
      <Notice tone="warn">
        {t('auth.login.waitCountdown')} <b className="mono">{`${m}:${ss}`}</b>
      </Notice>
    </div>
  );
}

/**
 * Dil menüsü (kullanıcı isteği 2026-11-13): dünya simgeli düğme, tıklayınca diller listelenir (ad kendi dilinde, seçilide ✓).
 * İlk dil yine kural sırasıyla gelir (siteden ?lang → çerez → tarayıcı → İngilizce; `detectLocale`). Esc ve dışarı tıklama kapatır.
 */
function LangSwitch() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const cur = (i18n.language === 'tr' ? 'tr' : 'en') as Locale;
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="auth-lang" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="auth-lang-btn"
        aria-label={`${t('auth.language')}: ${LOCALE_NAME[cur]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="globe" />
        <span lang={cur}>{cur.toUpperCase()}</span>
        <Icon name="chev" className="auth-lang-chev" />
      </button>
      {open && (
        <div className="auth-lang-menu" id={id} role="menu" aria-label={t('auth.language')}>
          {LOCALES.map((l: Locale) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={l === cur}
              lang={l}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                if (l !== cur) setShellLocale(l);
              }}
            >
              <span>{LOCALE_NAME[l]}</span>
              {l === cur && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AuthFrame({ title, sub, children, foot }: { title: string; sub?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.title = `${title} · SellerOnData`;
  }, [title]);
  const home = siteUrl('home', i18n.language);
  return (
    <div className="auth">
      <aside className="auth-side">
        <a className="auth-brand" href={home} aria-label={t('auth.siteHome')}>
          <SellerOnDataMark size={40} variant="reverse" />
          <span>SellerOnData</span>
        </a>
        <div>
          <p className="auth-pitch">{t('auth.pitch')}</p>
          <ul className="auth-prods" aria-label={t('auth.products')}>
            {BRAND_PRODUCTS.map((p) => (
              <li key={p.key}>
                {p.mark ? <img src={`/brand/${p.mark}`} width={40} height={40} alt="" /> : <ProductMark product={p.key} size={40} />}
                <span>{p.name}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="auth-copy">{t('auth.copyright', { year: new Date().getFullYear() })}</p>
      </aside>
      <main className="auth-main">
        {/* Masaüstünde yalnız dil seçici; 900 px altında lacivert üst çubuk (marka + dil). */}
        <div className="auth-top">
          <a className="auth-brand auth-brand-m" href={home} aria-label={t('auth.siteHome')}>
            <SellerOnDataMark size={32} variant="reverse" />
            <span>SellerOnData</span>
          </a>
          <LangSwitch />
        </div>
        <div className="auth-center">
          <div className="auth-card">
            <h1>{title}</h1>
            {sub && <p className="auth-sub">{sub}</p>}
            <div className="auth-body">{children}</div>
            {foot && <div className="auth-links">{foot}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}

type Describable = { 'aria-describedby'?: string; 'aria-invalid'?: boolean };

/** Etiket, alan, ipucu ya da hata. Not alana `aria-describedby` ile bağlanır; hata varken alan `aria-invalid`. */
function AuthField({ id, label, help, helpId, error, alert, children }: { id: string; label: ReactNode; help?: ReactNode; helpId?: string; error?: string | null; alert?: boolean; children: ReactElement<Describable> }) {
  const noteId = error ? `${id}-err` : help ? (helpId ?? `${id}-hint`) : undefined;
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { 'aria-describedby': noteId, 'aria-invalid': error ? true : children.props['aria-invalid'] })}
      {error ? (
        <p className="err" id={noteId} role={alert ? 'alert' : undefined}>
          {error}
        </p>
      ) : help ? (
        <p className="help" id={noteId}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, ...aria }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string } & Describable) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <div className="auth-pw">
      <input id={id} className="inp" type={show ? 'text' : 'password'} required autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={aria['aria-invalid'] || undefined} aria-describedby={aria['aria-describedby']} />
      <button type="button" className="auth-eye" aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')} aria-pressed={show} onClick={() => setShow((v) => !v)}>
        <Icon name={show ? 'eyeoff' : 'eye'} size={20} />
      </button>
    </div>
  );
}

/** Oturum açıldıktan sonra: kabuk önbelleği temizlenir, kişi kaldığı yere döner. */
function useAfterAuth() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return async (to: string) => {
    // Önceki oturumun izi silinir; çıkış yapılmış sekmenin geç gelen eski /me yanıtı yeni kişinin bilgisine dokunmaz.
    beginSession(client);
    // Merkez'in olmayan yol başka uygulamadır (`/deciship/*`): router değil tam sayfa.
    if (!isHubPath(to)) {
      window.location.replace(to);
      return;
    }
    await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    nav(to, { replace: true });
  };
}

/** Oturum zaten açık, `next` Merkez'in dışında: tam sayfa geçiş. */
function LeaveHub({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return null;
}

/** Sunucu şemasıyla aynı (`emailField`). */
const EMAIL_MAX = 254;

/** `EMAIL_VERIFICATION_REQUIRED` açıkken kayıt ve davet kabulü 202 döner: hesap açıldı, oturum e-posta doğrulanınca. */
const needsVerification = (r: unknown): r is VerificationRequiredResponse => (r as VerificationRequiredResponse | undefined)?.verificationRequired === true;

/**
 * Doğrulama bağlantısını yeniden ister; sunucu `{ ok: true }` döner (adres var mı yok mu belli etmez). Adres başına sınır doluysa
 * `429 TOO_MANY_ATTEMPTS` (Y39): ekran "gönderildi" yerine sunucunun "biraz sonra yeniden deneyin" metnini gösterir.
 */
function useResendVerification() {
  return useMutation({
    mutationFn: (email: string) => client.post('/api/account/auth/resend-verification', { email }, { noRefresh: true }),
  });
}

function VerificationSent({ email }: { email: string }) {
  const { t } = useTranslation();
  const resend = useResendVerification();
  return (
    <AuthFrame title={t('auth.verifySent.title')} sub={email}>
      <p className="auth-text">{t('auth.verifySent.body')}</p>
      {resend.isSuccess && <Notice tone="ok">{t('auth.verifySent.resent')}</Notice>}
      {resend.isError && <Notice tone="err">{apiMessage(resend.error, t('common.unexpected'))}</Notice>}
      {email && (
        <Button kind="ghost" loading={resend.isPending} onClick={() => resend.mutate(email)}>
          {t('auth.verifySent.resend')}
        </Button>
      )}
      <Link className="btn btn-primary auth-submit" to="/login">
        {t('auth.login.submit')}
      </Link>
    </AuthFrame>
  );
}

/** Giriş ekranında açık oturum: kim olduğu, "bu hesapla devam et" (birincil) ve "başka hesapla giriş yap" (çıkış + form). */
function SignedIn({ name, sub, onContinue, join }: { name: string; sub: string; onContinue: () => void; join?: boolean }) {
  const { t } = useTranslation();
  const logoutToLogin = useLogoutAction();
  const { logout: endSession } = useSessionActions();
  const [leaving, setLeaving] = useState(false);
  // Kodla katılmada: çıkış yapılır ve aynı sayfada (boş oturumla) kod formu açılır.
  const logout = join
    ? async () => {
        const { serverEnded } = await endSession();
        if (serverEnded) window.location.assign('/join');
        else await logoutToLogin();
      }
    : logoutToLogin;
  return (
    <AuthFrame title={t('auth.login.signedInTitle')} sub={join ? t('auth.join.signedInSub') : t('auth.login.signedInSub')}>
      <div className="auth-signed">
        <span className="auth-signed-av" aria-hidden="true">
          {initialsOf(name)}
        </span>
        <span className="auth-signed-txt">
          <b>{name}</b>
          {sub && <small>{sub}</small>}
        </span>
      </div>
      <div className="form-stack">
        {join ? (
          <>
            {/* Kodla katılmada çoğu zaman kod başka bir kişi içindir: birincil eylem çıkış yapıp katılmak. */}
            <Button
              className="auth-submit"
              loading={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  await logout();
                } finally {
                  setLeaving(false);
                }
              }}
            >
              {t('auth.join.logoutAndJoin')}
            </Button>
            <Button kind="secondary" onClick={onContinue}>
              {t('auth.join.linkToThis', { name })}
            </Button>
          </>
        ) : (
          <>
            <Button className="auth-submit" onClick={onContinue}>
              {t('auth.login.continueAs', { name })}
            </Button>
            <Button
              kind="secondary"
              loading={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  await logout();
                } finally {
                  setLeaving(false);
                }
              }}
            >
              {t('auth.login.switchAccount')}
            </Button>
          </>
        )}
      </div>
    </AuthFrame>
  );
}

/** "Selin Sahip" → "SS" (kabuktaki avatar gibi; iki harf). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const pick = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts.slice(0, 1);
  return pick.map((p) => Array.from(p)[0]!.toLocaleUpperCase('tr')).join('') || '?';
}

export function Login() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { me, isPending, isPlaceholderData } = useMe();
  const after = useAfterAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [continuing, setContinuing] = useState(false);
  const login = useMutation({
    mutationFn: () => client.post<AuthResponse>('/api/account/auth/login', { identifier: identifier.trim(), password, client: 'web' }, { noRefresh: true }),
    onSuccess: () => after(next),
  });
  // Yanlış bilgi şifre alanının altında (tasarım); başka hata (ör. sınır, bağlantı) genel uyarıda.
  const loginWait = useRetryWait(login.error, () => login.reset());
  const badCredentials = login.error instanceof ApiError && login.error.code === 'INVALID_CREDENTIALS';
  const notVerified = login.error instanceof ApiError && login.error.code === 'EMAIL_NOT_VERIFIED';
  const resend = useResendVerification();
  const canResend = identifier.includes('@');
  // Önbellekteki kişiye bakılmaz: oturum düşmüşse iki uygulama arasında yönlendirme döngüsü olur.
  // Bir uygulama girişe yönlendirdiyse (?next=) açık oturumla doğrudan devam edilir. Kişi girişe kendisi geldiyse
  // (bağlantı, "Giriş yapın") hiç sormadan içeri alınmaz: ortak bilgisayarda başkasının hesabına düşmesin (kullanıcı isteği 2026-11-13).
  if (!isPending && !isPlaceholderData && me) {
    if (params.has('next') || continuing) return isHubPath(next) ? <Navigate to={next} replace /> : <LeaveHub to={next} />;
    return <SignedIn name={me.person.name} sub={me.person.email ?? me.person.phone ?? ''} onContinue={() => setContinuing(true)} />;
  }
  return (
    <AuthFrame
      title={t('auth.login.title')}
      sub={t('auth.login.sub')}
      foot={
        <>
          <p>
            <Link to="/forgot-password">{t('auth.login.forgot')}</Link>
          </p>
          <p>
            {t('auth.login.noAccount')} <Link to="/register">{t('auth.login.register')}</Link>
          </p>
          <p>
            {t('auth.login.haveCode')} <Link to="/join">{t('auth.login.join')}</Link>
          </p>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <AuthField id="id" label={t('auth.identifier')} help={t('auth.identifierHelp')}>
          <input id="id" className="inp" required autoComplete="username" autoFocus value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </AuthField>
        <AuthField id="pw" label={t('auth.password')} error={badCredentials ? apiMessage(login.error, t('common.unexpected')) : null} alert>
          <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="current-password" />
        </AuthField>
        {notVerified && (
          <div role="alert">
            <Notice
              tone="warn"
              action={
                canResend ? (
                  <Button kind="ghost" loading={resend.isPending} onClick={() => resend.mutate(identifier.trim())}>
                    {t('auth.verifySent.resend')}
                  </Button>
                ) : undefined
              }
            >
              {t('auth.login.notVerified')}
            </Notice>
          </div>
        )}
        {notVerified && resend.isSuccess && <Notice tone="ok">{t('auth.verifySent.resent')}</Notice>}
        {notVerified && resend.isError && <Notice tone="err">{apiMessage(resend.error, t('common.unexpected'))}</Notice>}
        {loginWait > 0 ? <WaitNotice seconds={loginWait} /> : login.isError && !badCredentials && !notVerified && <Notice tone="err">{apiMessage(login.error, t('common.unexpected'))}</Notice>}
        <Button type="submit" className="auth-submit" loading={login.isPending} disabled={loginWait > 0}>
          {t('auth.login.submit')}
        </Button>
      </form>
    </AuthFrame>
  );
}

/** Sunucunun alan hatası: `details: [{ path, code, message }]`. Hangi alan olduğu orada söylenir. */
function fieldErrors(e: unknown, t: (key: string) => string): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  if (e.code === 'EMAIL_TAKEN') return { email: e.message };
  if (e.code !== 'VALIDATION' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const i of e.details as { path?: string; code?: string; message?: string }[]) {
    if (i.path && i.message) out[i.path] = i.code === 'weak_password' ? t('auth.weakPassword') : i.message;
  }
  return out;
}

export function Register() {
  const { t, i18n } = useTranslation();
  const { me, isPending: mePending, isPlaceholderData } = useMe();
  const after = useAfterAuth();
  const [orgName, setOrgName] = useState('');
  const [country, setCountry] = useState('TR');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Kayıt daveti (kapalı deneme, SIGNUP_MODE=invite): destek komutunun verdiği `/register?invite=` bağlantısı. Açık kipte gönderilmez.
  const [params] = useSearchParams();
  const signupInvite = params.get('invite')?.trim() || undefined;
  const short = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const reg = useMutation({
    mutationFn: () =>
      client.post<AuthResponse | VerificationRequiredResponse>(
        '/api/account/auth/register',
        { orgName: orgName.trim(), name: name.trim(), email: email.trim(), password, country, locale: i18n.language, ...(signupInvite ? { signupInvite } : {}) },
        { noRefresh: true },
      ),
    onSuccess: (r) => {
      if (needsVerification(r)) setSentTo(email.trim());
      else void after('/home');
    },
  });
  const { registrationClosed, inviteOnly } = useCatalog();
  const closed = registrationClosed || (reg.error instanceof ApiError && reg.error.code === 'REGISTRATION_CLOSED');
  // Davetsiz gelen kişiye form yerine kısa açıklama; davetliye form. Sunucu davetsiz isteği zaten reddeder (SIGNUP_INVITE_REQUIRED).
  const needsInvite = !closed && ((inviteOnly && !signupInvite) || (reg.error instanceof ApiError && reg.error.code === 'SIGNUP_INVITE_REQUIRED'));
  const errors = fieldErrors(reg.error, t);
  /** `maxLength` fazlasını sessizce keser: nasıl girilirse girilsin, alan sınıra dayanınca kişi bilsin. */
  const limitNote = (value: string) => (value.length >= NAME_MAX_LENGTH ? <span role="status">{t('auth.register.clipped', { max: NAME_MAX_LENGTH })}</span> : undefined);
  const countries = new Intl.DisplayNames([i18n.language], { type: 'region' });
  const hasFieldError = Object.keys(errors).length > 0;
  const newTab = <span className="sr-only"> {t('auth.newTab')}</span>;
  // Oturum açıkken kayıt formu yanlış yer: Merkez'e.
  if (!mePending && !isPlaceholderData && me) return <Navigate to="/home" replace />;
  if (sentTo) return <VerificationSent email={sentTo} />;
  return (
    <AuthFrame
      title={t('auth.register.title')}
      sub={t('auth.register.sub')}
      foot={
        <p>
          {t('auth.register.haveAccount')} <Link to="/login">{t('auth.login.link')}</Link>
        </p>
      }
    >
      {closed ? (
        <Notice tone="info">{t('auth.register.closed')}</Notice>
      ) : needsInvite ? (
        <Notice tone="info">
          {t('auth.register.inviteOnly')} <a href={supportMailto([t('auth.register.inviteSubject')])}>{SUPPORT_EMAIL}</a>
        </Notice>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!short) reg.mutate();
          }}
        >
          <div className="auth-grp" role="group" aria-labelledby="grp-person">
            <p className="auth-lg" id="grp-person">
              {t('auth.register.person')}
            </p>
            <AuthField id="name" label={t('auth.register.name')} error={errors.name} alert helpId="name-limit" help={limitNote(name)}>
              <input id="name" className="inp" required autoFocus autoComplete="name" maxLength={NAME_MAX_LENGTH} value={name} onChange={(e) => setName(e.target.value)} />
            </AuthField>
            <AuthField id="email" label={t('auth.register.email')} error={errors.email} alert>
              <input id="email" className="inp" type="email" required autoComplete="email" maxLength={EMAIL_MAX} value={email} onChange={(e) => setEmail(e.target.value)} />
            </AuthField>
            <AuthField
              id="pw"
              label={t('auth.password')}
              error={short ? t('auth.passwordShort', { min: PASSWORD_MIN_LENGTH }) : (errors.password ?? null)}
              alert={!short}
              help={t('auth.passwordHelp', { min: PASSWORD_MIN_LENGTH })}
            >
              <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="new-password" />
            </AuthField>
          </div>
          <div className="auth-grp" role="group" aria-labelledby="grp-company">
            <p className="auth-lg" id="grp-company">
              {t('auth.register.company')}
            </p>
            <AuthField id="org" label={t('auth.register.org')} error={errors.orgName} alert helpId="org-limit" help={limitNote(orgName)}>
              <input id="org" className="inp" required autoComplete="organization" maxLength={NAME_MAX_LENGTH} value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </AuthField>
            {/* Hesap kuralı: ülkeye göre TRY, EUR, GBP ya da USD. Firma ayarlarından değişir. */}
            <AuthField id="org-country" label={t('company.country')} error={errors.country} alert help={country !== 'TR' ? t('auth.register.currencyNote', { currency: currencyForCountry(country) }) : undefined}>
              <select id="org-country" className="sel" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {countries.of(c) ?? c}
                  </option>
                ))}
              </select>
            </AuthField>
          </div>
          {reg.isError && !hasFieldError && <Notice tone="err">{apiMessage(reg.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={reg.isPending} disabled={closed}>
            {t('auth.register.submit')}
          </Button>
          <div className="auth-terms">
            <p>{t('auth.register.terms')}</p>
            <div className="auth-terms-l">
              <a href={siteUrl('terms', i18n.language)} target="_blank" rel="noopener">
                {t('auth.register.termsLink')}
                {newTab}
              </a>
              <a href={siteUrl('privacy', i18n.language)} target="_blank" rel="noopener">
                {t('auth.register.privacyLink')}
                {newTab}
              </a>
            </div>
          </div>
        </form>
      )}
    </AuthFrame>
  );
}

/** Telefon + kodla katılım: yöneticinin verdiği kod. Kişi önce nereye katıldığını görür, sonra şifreyi girer. */
export function Join() {
  const { t } = useTranslation();
  const after = useAfterAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // Tarayıcıda açık oturum varsa kod o hesaba bağlanmak istenir sanılır ("Bu davet başka bir hesap için"): önce sor.
  const { me, isPending: mePending, isPlaceholderData: mePlaceholder } = useMe();
  const [linkHere, setLinkHere] = useState(false);
  const usesCurrentPassword = !!preview && preview.purpose !== 'PASSWORD_RESET' && (preview.personExists || !!preview.linksCurrentAccount);
  const short = !usesCurrentPassword && password.length > 0 && password.length < PASSWORD_MIN_LENGTH;

  const check = useMutation({
    mutationFn: () => client.post<JoinPreview>('/api/account/auth/join/preview', { phone: phone.trim(), code: code.trim(), ...(linkHere ? { linkCurrentAccount: true } : {}) }, { noRefresh: true }),
    onSuccess: (p) => {
      setPreview(p);
      setName(p.name ?? '');
    },
  });
  const accept = useMutation({
    mutationFn: () =>
      client.post<AuthResponse>(
        '/api/account/auth/join/accept',
        { phone: phone.trim(), code: code.trim(), name: name.trim() || undefined, password, client: 'web', ...(linkHere ? { linkCurrentAccount: true } : {}) },
        { noRefresh: true },
      ),
    onSuccess: () => after('/home'),
  });

  const checkWait = useRetryWait(check.error, () => check.reset());
  const acceptWait = useRetryWait(accept.error, () => accept.reset());

  if (!preview && !linkHere && !mePending && !mePlaceholder && me) {
    return <SignedIn join name={me.person.name} sub={me.person.email ?? me.person.phone ?? ''} onContinue={() => setLinkHere(true)} />;
  }

  if (!preview) {
    return (
      <AuthFrame
        title={t('auth.join.title')}
        sub={t('auth.join.sub')}
        foot={
          <p>
            {t('auth.register.haveAccount')} <Link to="/login">{t('auth.login.link')}</Link>
          </p>
        }
      >
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            check.mutate();
          }}
        >
          <AuthField id="phone" label={t('team.phone')} help={t('team.phoneHelp')}>
            <input id="phone" className="inp" type="tel" inputMode="tel" required autoFocus autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </AuthField>
          <AuthField id="code" label={t('auth.join.code')} help={t('auth.join.codeHelp')}>
            <input id="code" className="inp mono hub-code-input" required autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toLocaleUpperCase('en'))} />
          </AuthField>
          {checkWait > 0 ? <WaitNotice seconds={checkWait} /> : check.isError && <Notice tone="err">{apiMessage(check.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={check.isPending} disabled={checkWait > 0}>
            {t('common.continue')}
          </Button>
        </form>
      </AuthFrame>
    );
  }

  const reset = preview.purpose === 'PASSWORD_RESET';
  const existing = usesCurrentPassword;
  const linking = !!preview.linksCurrentAccount && !reset;
  return (
    <AuthFrame title={reset ? t('auth.join.resetTitle') : t('auth.join.confirmTitle', { org: preview.orgName })} sub={reset ? t('auth.join.resetSub', { org: preview.orgName }) : linking ? t('auth.join.linkSub') : existing ? t('auth.join.existingSub') : t('auth.join.newSub')}>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!short) accept.mutate();
        }}
      >
        {!existing && !reset && (
          <AuthField id="name" label={t('auth.register.name')}>
            <input id="name" className="inp" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </AuthField>
        )}
        <AuthField
          id="pw"
          label={existing ? t('auth.join.currentPassword') : t('auth.join.newPassword')}
          error={short ? t('auth.passwordShort', { min: PASSWORD_MIN_LENGTH }) : null}
          help={linking ? t('auth.join.linkPasswordHelp') : existing ? t('auth.join.currentPasswordHelp') : t('auth.passwordHelp', { min: PASSWORD_MIN_LENGTH })}
        >
          <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete={existing ? 'current-password' : 'new-password'} />
        </AuthField>
        {acceptWait > 0 ? <WaitNotice seconds={acceptWait} /> : accept.isError && <Notice tone="err">{apiMessage(accept.error, t('common.unexpected'))}</Notice>}
        <Button type="submit" className="auth-submit" loading={accept.isPending} disabled={acceptWait > 0}>
          {reset ? t('auth.join.resetSubmit') : t('auth.join.accept')}
        </Button>
        <Button kind="ghost" className="auth-back" onClick={() => setPreview(null)}>
          {t('common.back')}
        </Button>
      </form>
    </AuthFrame>
  );
}

/** E-posta davet bağlantısı. Var olan e-postada önce giriş ister (§5). */
export function InviteAccept() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const { token = '' } = useParams();
  const { me } = useMe();
  const after = useAfterAuth();
  const [sent, setSent] = useState(false);
  const q = useQuery({
    queryKey: ['invite', token],
    queryFn: () => client.get<InvitePreview>(`/api/account/invites/${encodeURIComponent(token)}`, { noRefresh: true }),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const short = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const accept = useMutation({
    mutationFn: () => client.post<AuthResponse | VerificationRequiredResponse>(`/api/account/invites/${encodeURIComponent(token)}/accept`, { name: name.trim() || undefined, password: password || undefined, client: 'web' }, { noRefresh: true }),
    onSuccess: (r) => {
      if (needsVerification(r)) setSent(true);
      else void after('/home');
    },
  });

  useEffect(() => {
    if (q.data?.name) setName(q.data.name);
  }, [q.data]);

  if (q.isPending) {
    return (
      <AuthFrame title={t('auth.invite.title')}>
        <div className="auth-stack">
          <Skel h={20} />
          <Skel h={48} />
        </div>
      </AuthFrame>
    );
  }
  if (q.isError || !q.data) {
    return (
      <AuthFrame
        title={t('auth.invite.invalidTitle')}
        foot={
          <p>
            <Link to="/login">{t('auth.login.link')}</Link>
          </p>
        }
      >
        <p className="auth-text">{apiMessage(q.error, t('auth.invite.invalidBody'))}</p>
      </AuthFrame>
    );
  }
  const inv = q.data;
  if (sent) return <VerificationSent email={inv.email ?? ''} />;
  const needsLogin = inv.personExists && !me;
  return (
    <AuthFrame title={t('auth.invite.titleOrg', { org: inv.orgName })} sub={inv.email ?? undefined}>
      <ul className="auth-summary">
        <li>
          <span>{t('team.orgRole')}</span>
          <b>{ORG_ROLE_LABEL[inv.orgRole][locale]}</b>
        </li>
      </ul>
      {needsLogin ? (
        <>
          <Notice tone="info">{t('auth.invite.loginFirst')}</Notice>
          <Link className="btn btn-primary auth-submit" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
            {t('auth.login.submit')}
          </Link>
        </>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!short) accept.mutate();
          }}
        >
          {!inv.personExists && (
            <>
              <AuthField id="name" label={t('auth.register.name')}>
                <input id="name" className="inp" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </AuthField>
              <AuthField id="pw" label={t('auth.join.newPassword')} error={short ? t('auth.passwordShort', { min: PASSWORD_MIN_LENGTH }) : null} help={t('auth.passwordHelp', { min: PASSWORD_MIN_LENGTH })}>
                <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="new-password" />
              </AuthField>
            </>
          )}
          {accept.isError && <Notice tone="err">{apiMessage(accept.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={accept.isPending}>
            {t('auth.join.accept')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ForgotPassword() {
  const { t } = useTranslation();
  const { mailOff } = useCatalog();
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => client.post('/api/account/auth/forgot-password', { identifier: email.trim() }, { noRefresh: true }) });
  return (
    <AuthFrame
      title={t('auth.forgot.title')}
      sub={mailOff ? t('auth.forgot.subMailOff') : t('auth.forgot.sub')}
      foot={
        <>
          {!mailOff && <p>{t('auth.forgot.noEmail')}</p>}
          <p>
            <Link to="/login">{t('auth.backToLogin')}</Link>
          </p>
        </>
      }
    >
      {mailOff ? (
        <Notice tone="info">{t('auth.forgot.mailOff')}</Notice>
      ) : send.isSuccess ? (
        <Notice tone="ok">{t('auth.forgot.sent')}</Notice>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <AuthField id="email" label={t('auth.register.email')}>
            <input id="email" className="inp" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </AuthField>
          {send.isError && <Notice tone="err">{apiMessage(send.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={send.isPending}>
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPassword() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const short = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const reset = useMutation({ mutationFn: () => client.post('/api/account/auth/reset-password', { token, password }, { noRefresh: true }) });
  return (
    <AuthFrame title={t('auth.reset.title')} sub={reset.isSuccess ? undefined : t('auth.reset.sub')}>
      {reset.isSuccess ? (
        <>
          <Notice tone="ok">{t('auth.reset.done')}</Notice>
          <Link className="btn btn-primary auth-submit" to="/login">
            {t('auth.login.submit')}
          </Link>
        </>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!short) reset.mutate();
          }}
        >
          <AuthField id="pw" label={t('auth.join.newPassword')} error={short ? t('auth.passwordShort', { min: PASSWORD_MIN_LENGTH }) : null} help={t('auth.passwordHelp', { min: PASSWORD_MIN_LENGTH })}>
            <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="new-password" />
          </AuthField>
          {reset.isError && <Notice tone="err">{apiMessage(reset.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={reset.isPending}>
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function VerifyEmail() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const { me } = useMe();
  const [password, setPassword] = useState('');
  const q = useQuery({
    queryKey: ['verify', token],
    queryFn: () => client.post<VerifyEmailResponse>('/api/account/auth/verify-email', { token }, { noRefresh: true }),
    retry: false,
  });
  // İlk doğrulamada sunucu şifre ister (jeton harcanmaz); şifreyle yeniden çağrılır.
  const withPassword = useMutation({
    mutationFn: () => client.post<VerifyEmailResponse>('/api/account/auth/verify-email', { token, password }, { noRefresh: true }),
  });
  const needPassword = q.error instanceof ApiError && q.error.code === 'PASSWORD_REQUIRED';
  const wrong = withPassword.error instanceof ApiError && withPassword.error.code === 'INVALID_CREDENTIALS';
  const result = withPassword.data ?? q.data;
  if (needPassword && !withPassword.isSuccess) {
    return (
      <AuthFrame title={t('auth.verify.passwordTitle')}>
        <form
          className="form-stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            withPassword.mutate();
          }}
        >
          <p className="auth-text">{t('auth.verify.passwordText')}</p>
          <AuthField id="vpw" label={t('auth.password')} error={wrong ? t('auth.verify.passwordWrong') : null} alert>
            <PasswordInput id="vpw" value={password} onChange={setPassword} autoComplete="current-password" />
          </AuthField>
          {withPassword.isError && !wrong && <Notice tone="err">{apiMessage(withPassword.error, t('common.unexpected'))}</Notice>}
          <Button type="submit" className="auth-submit" loading={withPassword.isPending}>
            {t('auth.verify.passwordSubmit')}
          </Button>
        </form>
        <p className="auth-text">
          <Link to="/forgot-password">{t('auth.verify.passwordForgot')}</Link>
        </p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={t('auth.verify.title')}>
      {q.isPending && <Skel h={20} />}
      {result && (
        <Empty
          compact
          good
          icon="check"
          title={result.result === 'changed' ? t('auth.verify.changed') : t('auth.verify.done')}
          actions={
            me ? (
              <Link className="btn btn-primary" to="/home">
                {t('tool.backHub')}
              </Link>
            ) : (
              <Link className="btn btn-primary" to="/login">
                {t('auth.login.submit')}
              </Link>
            )
          }
        />
      )}
      {q.isError && !needPassword && <Notice tone="err">{apiMessage(q.error, t('auth.verify.failed'))}</Notice>}
    </AuthFrame>
  );
}
