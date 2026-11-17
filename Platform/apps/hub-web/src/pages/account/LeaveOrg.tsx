import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Field, Modal, ModalAction, Notice, useSessionActions } from '@sellerondata/shell';
import { apiMessage } from '../../lib/hooks.ts';

/**
 * Etkin firmadan ayrılma onayı (Profil › Firmalarım). Sahip ayrılamaz; sunucu da reddeder (LAST_OWNER).
 * E-postasız kişide şifre istenir ve kurtarma yolunun kapanacağı önce söylenir (§5, passwordRecovery).
 */
export function LeaveDialog({ orgName, requiresPassword, riskyRecovery, onClose }: { orgName: string; requiresPassword: boolean; riskyRecovery: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { leaveOrg } = useSessionActions();
  const [password, setPassword] = useState('');
  const leave = useMutation({ mutationFn: () => leaveOrg(requiresPassword ? { password } : {}) });
  return (
    <Modal
      title={t('leave.confirmTitle', { org: orgName })}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="danger" loading={leave.isPending} disabled={requiresPassword && !password} onClick={() => leave.mutate()}>
            {t('leave.action')}
          </ModalAction>
        </>
      }
    >
      <div className="form-stack">
        <p>{t('leave.body', { org: orgName })}</p>
        <p>{t('leave.confirmBody')}</p>
        {riskyRecovery && <Notice tone="warn">{t('leave.recoveryWarn')}</Notice>}
        {requiresPassword && (
          <Field label={t('leave.password')} htmlFor="leave-pw" help={t('leave.passwordHelp')}>
            <input id="leave-pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {leave.isError && <Notice tone="err">{apiMessage(leave.error, t('common.unexpected'))}</Notice>}
      </div>
    </Modal>
  );
}
