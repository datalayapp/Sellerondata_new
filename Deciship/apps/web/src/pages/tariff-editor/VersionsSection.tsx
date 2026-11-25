import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { tariffs } from '../../api/endpoints';
import type { TariffVersion } from '../../api/types';
import { Button, Empty, ErrorState, Skel, Tag } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { Sec, useTariffReadOnly } from './Sec';

const REASON_TONE: Record<TariffVersion['reason'], 'blue' | 'gray' | 'purple'> = {
  IMPORT: 'blue',
  EDIT: 'gray',
  RESTORE: 'purple',
};

export function VersionsSection({ tariffId, busyId, onRestore }: { tariffId: string; busyId?: string; onRestore: (v: TariffVersion) => void }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const q = useQuery({ queryKey: ['tariff-versions', tariffId], queryFn: () => tariffs.versions(tariffId) });
  const [all, setAll] = useState(false);
  const items = q.data ?? [];
  const shown = all ? items : items.slice(0, 5);
  return (
    <Sec
      id="te-ver"
      title={t('versions.title')}
      desc={t(readOnly ? 'versions.descView' : 'versions.desc')}
    >
      {q.isLoading ? (
        <div className="col gap8">
          <Skel h={56} />
          <Skel h={56} />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <Empty compact icon="clipboard" title={t('versions.emptyTitle')}>
          {t('versions.emptyBody')}
        </Empty>
      ) : (
        <>
          <ul className="vh-list">
            {shown.map((v) => (
              <li key={v.id} className="vh">
                <div className="vh-main">
                  <div className="vh-top">
                    <span className="vh-when num">{fmtDateTime(v.createdAt)}</span>
                    <Tag tone={REASON_TONE[v.reason]} small>
                      {t(`versions.reason.${v.reason}`)}
                    </Tag>
                  </div>
                  <div className="vh-label">{v.label}</div>
                  <div className="vh-meta num">
                    {v.user?.name ?? t('versions.system')} · {t('units.rates', { count: v.rateCount, formatted: fmtNum(v.rateCount) })} ·{' '}
                    {t('units.zones', { count: v.zoneCount, formatted: fmtNum(v.zoneCount) })} · {t('units.countries', { count: v.countryCount, formatted: fmtNum(v.countryCount) })} · {v.currency}
                  </div>
                </div>
                {!readOnly && (
                  <Button kind="secondary" small icon="back" loading={busyId === v.id} disabled={Boolean(busyId)} onClick={() => onRestore(v)}>
                    {t('versions.restore')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {items.length > 5 && (
            <Button kind="ghost" small icon={all ? 'up' : 'down'} className="mt8" onClick={() => setAll(!all)}>
              {all ? t('versions.showLess') : t('versions.showAll', { formatted: fmtNum(items.length) })}
            </Button>
          )}
        </>
      )}
    </Sec>
  );
}
