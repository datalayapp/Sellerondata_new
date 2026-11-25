import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSessionActions } from '@sellerondata/shell';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { toast } from './Toast';
import { Button, Empty } from './ui';

/** Sunucunun ürettiği kimliklere benzemeyen adres istek atmadan "kayıt yok" sayılır. */
export const isRecordId = (id: string | undefined): id is string => !!id && /^[\w-]{1,64}$/.test(id);

/** 404 ya da bozuk kimlik (400): kayıt bu firmada yok. Sunucu ve yetki hataları buraya girmez. */
export const isRecordMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);

/** Kayıt bu firmada yok: bağlantı başka firmadan gelmiş olabilir, firması varsa aynı adresle oraya geçilir. */
export function RecordNotFound({ backTo, backLabel }: { backTo: string; backLabel: string }) {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  const { switchOrg } = useSessionActions();
  const [busy, setBusy] = useState<string | null>(null);
  const others = (person?.orgs ?? []).filter((o) => o.status === 'ACTIVE' && o.id !== person?.activeOrg?.id);
  const open = async (id: string) => {
    setBusy(id);
    try {
      await switchOrg(id, window.location.pathname + window.location.search);
    } catch {
      toast.err(t('org.switchFailed'));
      setBusy(null);
    }
  };
  return (
    <Empty
      icon="doc"
      title={t('record.title')}
      actions={
        <Link className="btn btn-primary" to={backTo}>
          {backLabel}
        </Link>
      }
    >
      {t('record.body')}
      {others.length > 0 && (
        <div className="ds-record-orgs">
          <p>{t('record.otherOrgs')}</p>
          <ul className="ds-access-orgs">
            {others.map((o) => (
              <li key={o.id}>
                <Button kind="secondary" small loading={busy === o.id} disabled={busy != null} onClick={() => open(o.id)}>
                  {o.name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Empty>
  );
}
