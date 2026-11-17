import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LOCALES, NAME_MAX_LENGTH, type AuthResponse, type EmailResendResponse, type Locale, type MeResponse } from '@sellerondata/contracts';
import { Button, Field, Icon, LOCALE_NAME, ME_QUERY_KEY, Notice, formatPhone, toast, useMe, useSessionActions } from '@sellerondata/shell';
import { apiMessage } from '../../lib/hooks.ts';
import { client } from '../../lib/session.ts';
import { Panel, Row } from './AccountLayout.tsx';

type Editing = 'name' | 'email' | 'phone' | null;

/**
 * Hesabım › Profil (`/account/profile`): kişisel bilgiler ve tercihler (dil). Düzenleme satır içinde açılır, aynı anda biri.
 * Güvenlik (`Security.tsx`) ve Firmalarım (`Firms.tsx`) kendi adreslerinde; çerçeve `AccountLayout.tsx`.
 */
export function ProfilePage() {
  const { me } = useMe();
  const [editing, setEditing] = useState<Editing>(null);
  if (!me) return null;
  const done = () => setEditing(null);
  const editBtn = (key: Exclude<Editing, null>, label: string, tone?: 'mute' | 'danger') =>
    editing === key ? null : (
      <button type="button" className={`acc-act${tone ? ` ${tone}` : ''}`} onClick={() => setEditing(key)}>
        {label}
      </button>
    );
  return (
    <>
      <PersonalCard me={me} editing={editing} editBtn={editBtn} done={done} />
      <PreferencesCard />
    </>
  );
}

function PersonalCard({
  me,
  editing,
  editBtn,
  done,
}: {
  me: MeResponse;
  editing: Editing;
  editBtn: (key: Exclude<Editing, null>, label: string, tone?: 'mute' | 'danger') => ReactNode;
  done: () => void;
}) {
  const { t } = useTranslation();
  const p = me.person;
  const mailOff = me.account?.mailEnabled === false;
  const a = (k: string) => t(`accountArea.profile.${k}`);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  const resend = useMutation({
    mutationFn: () => client.post<EmailResendResponse>('/api/account/me/email/resend', {}),
    onSuccess: async () => {
      await refresh();
      toast.ok(a('resent'));
    },
    onError: (e) => toast.err(apiMessage(e, t('common.unexpected'))),
  });
  const cancel = useMutation({
    mutationFn: () => client.delete('/api/account/me/pending-email'),
    onSuccess: async () => {
      await refresh();
      toast.ok(a('pendingCanceled'));
    },
    onError: (e) => toast.err(apiMessage(e, t('common.unexpected'))),
  });
  const resendBtn = (
    <button type="button" className="acc-act mute" disabled={resend.isPending} onClick={() => resend.mutate()}>
      {a('resend')}
    </button>
  );
  const emailNote = p.pendingEmail ? (
    <small>{t(p.email ? 'accountArea.profile.pending' : 'accountArea.profile.pendingNoCurrent', { email: p.pendingEmail })}</small>
  ) : p.email && !p.emailVerified ? (
    <small>{mailOff ? a('unverifiedMailOff') : a('unverifiedHow')}</small>
  ) : !p.email && me.account?.passwordRecovery === 'none' && editing !== 'email' ? (
    <small className="warn">{a('noRecovery')}</small>
  ) : null;
  const emailActions = (
    <>
      {editBtn('email', p.email ? a('edit') : a('add'))}
      {p.pendingEmail ? (
        <>
          {resendBtn}
          <button type="button" className="acc-act mute" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {a('cancelPending')}
          </button>
        </>
      ) : (
        p.email && !p.emailVerified && !mailOff && resendBtn
      )}
    </>
  );
  return (
    <Panel id="acc-personal" title={a('personal')}>
      <Row label={a('name')} value={p.name} actions={editBtn('name', a('edit'))}>
        {editing === 'name' && <NameEditor initial={p.name} onDone={done} />}
      </Row>
      <Row label={a('email')} value={p.email ?? <span className="acc-muted">{a('noEmail')}</span>} note={emailNote} actions={emailActions}>
        {editing === 'email' && <EmailEditor me={me} onDone={done} />}
      </Row>
      {/* Telefon kendi kendine eklenemez: SMS doğrulaması yok, davet koduyla bağlanır (403 PHONE_CHANGE_NOT_ALLOWED). */}
      <Row
        label={a('phone')}
        value={p.phone ? formatPhone(p.phone) : <span className="acc-muted">{a('noPhone')}</span>}
        note={<small>{a('phoneHelp')}</small>}
        actions={p.phone && p.email && p.emailVerified ? editBtn('phone', a('remove'), 'danger') : null}
      >
        {editing === 'phone' && <RemovePhone onDone={done} />}
      </Row>
    </Panel>
  );
}

/** Yalnız değişen alan gider; kimlik değişimi (e-posta, telefon) mevcut şifreyle onaylanır. */
function useSaveMe(onDone: () => void) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => client.patch<AuthResponse>('/api/account/me', body),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      const pending = r?.me?.person.pendingEmail;
      toast.ok(pending ? t('accountArea.profile.pendingSent', { email: pending }) : t('accountArea.profile.saved'));
      onDone();
    },
  });
}

function EditActions({ pending, disabled, label, danger, onCancel }: { pending: boolean; disabled: boolean; label?: string; danger?: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="acc-form-acts">
      <Button type="submit" kind={danger ? 'danger' : 'primary'} loading={pending} disabled={disabled}>
        {label ?? t('common.save')}
      </Button>
      <Button kind="ghost" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

function NameEditor({ initial, onDone }: { initial: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const save = useSaveMe(onDone);
  const next = name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next && next !== initial) save.mutate({ name: next });
  };
  return (
    <form className="acc-form" onSubmit={submit}>
      <input id="p-name" className="inp" aria-label={t('accountArea.profile.name')} required autoFocus autoComplete="name" maxLength={NAME_MAX_LENGTH} value={name} onChange={(e) => setName(e.target.value)} />
      {save.isError && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
      <EditActions pending={save.isPending} disabled={!next || next === initial} onCancel={onDone} />
    </form>
  );
}

function CurrentPassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t('accountArea.profile.currentPassword')} htmlFor="p-pass" className="req" help={t('accountArea.profile.currentPasswordHelp')}>
      <input id="p-pass" className="inp" type="password" required autoComplete="current-password" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function EmailEditor({ me, onDone }: { me: MeResponse; onDone: () => void }) {
  const { t } = useTranslation();
  const initial = me.person.email ?? '';
  const [email, setEmail] = useState(initial);
  const [password, setPassword] = useState('');
  const save = useSaveMe(onDone);
  const next = email.trim();
  // Girişte e-posta veya telefondan biri gerekir.
  const noContact = !next && !me.person.phone;
  const ready = next !== initial && !noContact && !!password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) save.mutate({ email: next || null, currentPassword: password });
  };
  return (
    <form className="acc-form" onSubmit={submit}>
      <input id="p-email" className="inp" type="email" aria-label={t('accountArea.profile.email')} autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      {noContact && <Notice tone="warn">{t('accountArea.profile.needContact')}</Notice>}
      <CurrentPassword value={password} onChange={setPassword} />
      {save.isError && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
      <EditActions pending={save.isPending} disabled={!ready} onCancel={onDone} />
    </form>
  );
}

function RemovePhone({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const save = useSaveMe(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) save.mutate({ phone: null, currentPassword: password });
  };
  return (
    <form className="acc-form" onSubmit={submit}>
      <p className="acc-form-note">{t('accountArea.profile.removePhoneBody')}</p>
      <CurrentPassword value={password} onChange={setPassword} />
      {save.isError && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
      <EditActions pending={save.isPending} disabled={!password} danger label={t('accountArea.profile.removePhone')} onCancel={onDone} />
    </form>
  );
}

/** Tercihler › Dil: hesaba yazılır (`PATCH /me`) ve ekran hemen değişir. "Değiştir" iki seçeneği satırın altında açar. */
function PreferencesCard() {
  const { t, i18n } = useTranslation();
  const { changeLocale } = useSessionActions();
  const [open, setOpen] = useState(false);
  const current: Locale = i18n.language === 'en' ? 'en' : 'tr';
  const title = t('accountArea.language.title');
  return (
    <Panel id="acc-prefs" title={t('accountArea.profile.preferences')}>
      <Row
        label={
          <>
            <Icon name="globe" />
            {title}
          </>
        }
        value={<span lang={current}>{LOCALE_NAME[current]}</span>}
        actions={
          <button type="button" className="acc-act" aria-expanded={open} aria-controls="acc-langs" onClick={() => setOpen((v) => !v)}>
            {t('accountArea.language.change')}
            <Icon name="chev" size={14} />
          </button>
        }
      >
        {open && (
          <div role="radiogroup" id="acc-langs" aria-label={title} className="acc-langs">
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={l === current}
                lang={l}
                className="acc-lang-opt"
                onClick={() => {
                  setOpen(false);
                  if (l !== current) void changeLocale(l);
                }}
              >
                <span>{LOCALE_NAME[l]}</span>
                {l === current && <Icon name="check" />}
              </button>
            ))}
          </div>
        )}
      </Row>
    </Panel>
  );
}
