import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import type { OperatorStepUpResponse } from '@sellerondata/contracts';
import { ApiError, Field, Modal, ModalAction, Notice } from '@sellerondata/shell';
import { requestStepUp } from '../../api/ai.ts';
import { apiMessage } from '../../lib/hooks.ts';

/** Kişi şifre penceresini kapattı: işlem yapılmadı, hata iletisi gösterilmez. */
export class StepUpCancelled extends Error {
  constructor() {
    super('step-up cancelled');
    this.name = 'StepUpCancelled';
  }
}

/** Jeton bitimine bu kadar kala yenisi istenir: istek yoldayken süresi dolmasın. */
const MARGIN_MS = 15_000;

/**
 * Adım artırma: değiştiren yönetici işlemleri önce şifre ister (Hesap `POST /operator/step-up`, 5 dk geçerli jeton). Jeton yalnız
 * bellekte durur (sayfa yenilenince yeniden sorulur). Sunucu `403 STEP_UP_REQUIRED` derse jeton düşer ve şifre bir kez daha sorulur.
 */
export function useStepUp(): { run: <T>(fn: (token: string) => Promise<T>) => Promise<T>; modal: ReactNode } {
  const token = useRef<OperatorStepUpResponse | null>(null);
  const [asking, setAsking] = useState<{ resolve: (t: string) => void; reject: (e: Error) => void } | null>(null);

  const get = useCallback(
    () =>
      token.current && Date.parse(token.current.expiresAt) - Date.now() > MARGIN_MS
        ? Promise.resolve(token.current.token)
        : new Promise<string>((resolve, reject) => setAsking({ resolve, reject })),
    [],
  );

  const run = useCallback(
    async <T,>(fn: (t: string) => Promise<T>): Promise<T> => {
      try {
        return await fn(await get());
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'STEP_UP_REQUIRED')) throw e;
        token.current = null;
        return fn(await get());
      }
    },
    [get],
  );

  const modal = asking ? (
    <StepUpDialog
      onDone={(r) => {
        token.current = r;
        asking.resolve(r.token);
        setAsking(null);
      }}
      onCancel={() => {
        asking.reject(new StepUpCancelled());
        setAsking(null);
      }}
    />
  ) : null;
  return { run, modal };
}

function StepUpDialog({ onDone, onCancel }: { onDone: (r: OperatorStepUpResponse) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const go = useMutation({ mutationFn: () => requestStepUp(password), onSuccess: onDone });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (password && !go.isPending) go.mutate();
  };
  return (
    <Modal
      title={t('platform.stepUp.title')}
      onClose={onCancel}
      busy={go.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onCancel}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="prim" loading={go.isPending} disabled={!password} onClick={() => submit()}>
            {t('platform.stepUp.confirm')}
          </ModalAction>
        </>
      }
    >
      <form className="form-stack" onSubmit={submit}>
        <p>{t('platform.stepUp.body')}</p>
        <Field label={t('platform.stepUp.password')} htmlFor="step-up-pw">
          <input
            id="step-up-pw"
            className="inp"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {go.isError && <Notice tone="err">{apiMessage(go.error, t('common.unexpected'))}</Notice>}
      </form>
    </Modal>
  );
}
