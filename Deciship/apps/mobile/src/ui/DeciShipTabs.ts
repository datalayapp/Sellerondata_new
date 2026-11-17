import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { DECISHIP_TABS } from '../auth/access';
import type { BandTabs } from './components';

export type DeciShipTab = (typeof DECISHIP_TABS)[number];

const HREF = { today: '/deciship/today', history: '/deciship/history' } as const;

/**
 * Sekme geçişi DeciShip yığınında: Bugün kökte kalır, Geçmiş onun üstünde tek ekran.
 * Böylece geri tuşu her zaman Bugün'e, oradan önceki uygulamaya (Merkez) döner; yığın derinleşmez.
 */
export function goToDeciShipTab(current: DeciShipTab | null, next: DeciShipTab) {
  if (current === next) return;
  if (next === 'today') router.dismissTo(HREF.today);
  else if (current === 'today' || current === null) router.push(HREF[next]);
  else router.replace(HREF[next]);
}

/** DeciShip'in üst sekmeleri (Bugün · Geçmiş): `Header`'ın `tabs` değeri. */
export function useDeciShipTabs(current: DeciShipTab): BandTabs<DeciShipTab> {
  const { t } = useTranslation('auth');
  return {
    items: DECISHIP_TABS.map((key) => ({ key, label: t(`tabs.${key}`) })),
    value: current,
    onChange: (next) => goToDeciShipTab(current, next),
    label: t('tabs.decishipLabel'),
  };
}
