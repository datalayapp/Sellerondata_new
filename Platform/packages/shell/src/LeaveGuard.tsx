import { useEffect, useRef, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { useTranslation } from 'react-i18next';
import { holdUnload, shouldBlockLeave } from './leaveRules.ts';
import { Modal, ModalAction } from './primitives.tsx';

export type LeaveTexts = { label?: string; title?: string; body?: string; stay?: string; leave?: string };

/** Kaydedilmemiş değişiklik varken sekme kapanır / yenilenirken tarayıcı uyarısı. */
export function useUnsavedChangesPrompt(dirty: boolean) {
  useEffect(() => (dirty ? holdUnload() : undefined), [dirty]);
}

/**
 * Sayfadan çıkış koruması: sekme kapanınca tarayıcı uyarısı, uygulama içi gezintide "Değişiklikler kaydedilmedi" penceresi.
 * `release()` çağrıldıktan sonraki gezinti sorulmaz (kayıt başarılı, sayfa kendisi yönlendiriyor); `dirty` yeniden doğru olunca sıfırlanır.
 * `useBlocker` ister: uygulama veri yönlendiricisiyle (`createBrowserRouter` + `RouterProvider`) kurulmuş olmalı.
 */
export function useLeaveGuard(dirty: boolean, texts?: LeaveTexts): { dialog: ReactNode; release: () => void } {
  const released = useRef(false);
  useEffect(() => {
    if (dirty) released.current = false;
  }, [dirty]);
  useUnsavedChangesPrompt(dirty);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    shouldBlockLeave({ dirty, released: released.current, from: currentLocation.pathname, to: nextLocation.pathname }),
  );
  const dialog =
    blocker.state === 'blocked' ? <LeaveConfirm texts={texts} onStay={() => blocker.reset()} onLeave={() => blocker.proceed()} /> : null;
  return {
    dialog,
    release: () => {
      released.current = true;
    },
  };
}

export function LeaveConfirm({ texts, onStay, onLeave }: { texts?: LeaveTexts; onStay: () => void; onLeave: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <Modal
      label={texts?.label ?? t('leave.label')}
      title={texts?.title ?? t('leave.title')}
      onClose={onStay}
      actions={
        <>
          <ModalAction kind="dark" onClick={onStay}>
            {texts?.stay ?? t('leave.stay')}
          </ModalAction>
          <ModalAction kind="danger" onClick={onLeave}>
            {texts?.leave ?? t('leave.leave')}
          </ModalAction>
        </>
      }
    >
      <p>{texts?.body ?? t('leave.body')}</p>
    </Modal>
  );
}
