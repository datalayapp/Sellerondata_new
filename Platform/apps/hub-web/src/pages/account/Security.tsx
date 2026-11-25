import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MIN_LENGTH } from '@sellerondata/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState, Field, Icon, Notice, Tag, formatRelative, toast } from '@sellerondata/shell';
import { asList, type PersonSession } from '../../api/types.ts';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { client } from '../../lib/session.ts';
import { Panel, Row } from './AccountLayout.tsx';

/*
 * Hesabım › Güvenlik (`/account/security`): şifre (satır içinde değişir) ve açık oturumlar (doğrudan görünür).
 */

/** Güvenlik bölümü: Şifre ve Açık oturumlar panelleri. */
export function SecurityPage() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Panel id="acc-pass" title={t('accountArea.security.password')}>
        <Row
          label={t('accountArea.security.password')}
          value={<span aria-hidden="true">••••••••</span>}
          actions={
            editing ? null : (
              <button type="button" className="acc-act" onClick={() => setEditing(true)}>
                {t('accountArea.security.change')}
              </button>
            )
          }
        >
          {editing && <PasswordEditor onDone={() => setEditing(false)} />}
        </Row>
      </Panel>
      <Panel id="acc-sessions-h" title={t('accountArea.security.sessions')} sub={t('accountArea.security.sessionsSub')}>
        <SessionsList id="acc-sessions" />
      </Panel>
    </>
  );
}

/** Kullanıcı aracını okunur ada çevirir: tam metin kimseye bir şey söylemez. */
function deviceName(ua: string | null, fallback: string): string {
  if (!ua) return fallback;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || fallback;
}

/** Şifre değişimi. Sunucu diğer oturumları düşürür; bu oturum açık kalır. */
export function PasswordEditor({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const save = useMutation({
    mutationFn: () => client.post('/api/account/me/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.ok(t('accountArea.security.changed'));
      onDone();
    },
  });
  const short = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = repeat.length > 0 && next !== repeat;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (current && next.length >= PASSWORD_MIN_LENGTH && next === repeat) save.mutate();
  };
  return (
    <form onSubmit={submit} className="acc-form">
      <Field label={t('accountArea.security.currentPassword')} htmlFor="pw-c" className="req">
        <input id="pw-c" className="inp" type="password" required autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <div className="acc-form-grid">
        <Field label={t('accountArea.security.newPassword')} htmlFor="pw-n" className="req" error={short ? t('auth.passwordShort', { min: PASSWORD_MIN_LENGTH }) : null} help={t('auth.passwordHelp', { min: PASSWORD_MIN_LENGTH })}>
          <input id="pw-n" className="inp" type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={short || undefined} />
        </Field>
        <Field label={t('accountArea.security.repeatPassword')} htmlFor="pw-r" className="req" error={mismatch ? t('auth.passwordMismatch') : null}>
          <input id="pw-r" className="inp" type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-invalid={mismatch || undefined} />
        </Field>
      </div>
      <p className="acc-form-note">{t('accountArea.security.note')}</p>
      {save.isError && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
      <div className="acc-form-acts">
        <Button type="submit" loading={save.isPending} disabled={!current || next.length < PASSWORD_MIN_LENGTH || next !== repeat}>
          {t('accountArea.security.submit')}
        </Button>
        <Button kind="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Açık oturumlar. Bu cihaz dışındakiler tek tek kapatılır; "Diğer tüm oturumları kapat" aynı uç üzerinden (toplu uç yok)
 * bu cihaz dışındaki her oturumu sırayla kapatır.
 */
export function SessionsList({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const scope = useScope();
  const qc = useQueryClient();
  const key = [...scope, 'sessions'];
  const sessions = useQuery({ queryKey: key, queryFn: async () => asList<PersonSession>(await client.get('/api/account/me/sessions')) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const failed = (e: unknown) => toast.err(t('accountArea.security.revokeFailed'), apiMessage(e, t('common.unexpected')));
  const revoke = useMutation({
    mutationFn: (sid: string) => client.delete(`/api/account/me/sessions/${encodeURIComponent(sid)}`),
    onSuccess: async () => {
      await refresh();
      toast.ok(t('accountArea.security.revoked'));
    },
    onError: failed,
  });
  const others = (sessions.data ?? []).filter((s) => !s.current);
  const revokeOthers = useMutation({
    mutationFn: async (ids: string[]) => {
      // Sırayla: biri düşerse kalanlar denenmez, liste yenilenince kalanlar görünür.
      for (const sid of ids) await client.delete(`/api/account/me/sessions/${encodeURIComponent(sid)}`);
    },
    onSuccess: () => toast.ok(t('accountArea.security.revokedOthers')),
    onError: failed,
    onSettled: () => refresh(),
  });
  const busy = revoke.isPending || revokeOthers.isPending;

  return (
    <div id={id} className="acc-sessions-wrap">
      {sessions.isPending && (
        <div className="acc-skel" aria-busy="true">
          <span />
          <span />
        </div>
      )}
      {sessions.isError && <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />}
      {sessions.data?.length === 0 && <p className="acc-muted">{t('accountArea.security.noSessions')}</p>}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="acc-sessions">
          {sessions.data.map((s) => (
            <li key={s.id}>
              <span className="acc-dev-ic">
                <Icon name={s.client === 'mobile' ? 'phone' : 'laptop'} size={18} />
              </span>
              <span className="acc-sessions-main">
                <b>
                  {deviceName(s.userAgent, s.client === 'mobile' ? t('accountArea.security.mobile') : t('accountArea.security.web'))}
                  {s.current && (
                    <Tag tone="gray" small>
                      {t('accountArea.security.current')}
                    </Tag>
                  )}
                </b>
                <small>{[s.ip, formatRelative(s.lastUsedAt, i18n.language)].filter(Boolean).join(' · ')}</small>
              </span>
              {!s.current && (
                <Button kind="secondary" small loading={revoke.isPending && revoke.variables === s.id} disabled={busy} onClick={() => revoke.mutate(s.id)}>
                  {t('accountArea.security.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <div className="acc-sessions-end">
          <Button kind="danger-outline" small loading={revokeOthers.isPending} disabled={busy} onClick={() => revokeOthers.mutate(others.map((s) => s.id))}>
            {t('accountArea.security.revokeOthers')}
          </Button>
        </div>
      )}
    </div>
  );
}
