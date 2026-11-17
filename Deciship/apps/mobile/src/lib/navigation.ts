import type { MeResponse } from '@sellerondata/contracts';
import { router } from 'expo-router';
import { afterOrgSwitchHref, type AppBand } from '../auth/access';
import type { MeasurementRowItem } from '../ui/MeasurementRow';

/** Liste öğesini detayda açar: sunucu kaydı id ile, kuyruktaki kayıt clientId + `local=1` ile. */
export function openMeasurement(item: Pick<MeasurementRowItem, 'serverId' | 'clientId' | 'status'>) {
  if (item.status === 'SENT' && item.serverId) router.push({ pathname: '/deciship/measurement/[id]', params: { id: item.serverId } });
  else if (item.clientId) router.push({ pathname: '/deciship/measurement/[id]', params: { id: item.clientId, local: '1' } });
}

/**
 * Hesap ekranında firma değişince gidilecek yere geçer; Hesap ekranı geçmişten çıkar, hedef ikinci kez eklenmez.
 * (`navigate` yığına yeni ekran iter: DeciShip'te Bugün iki kez dururdu, geri tuşu Hesap'a dönerdi; E1-M15.)
 * - DeciShip Hesap'ı DeciShip yığınında: hedef Bugün ise yığın Bugün'e iner (`dismissTo`).
 * - Hedef başka bir uygulamadaysa (Merkez Hesap'ı ayrı sekme ya da DeciShip'ten Merkez'e) Hesap yerini hedefe bırakır (`replace`).
 */
export function goAfterOrgSwitch(me: MeResponse | null | undefined, band: AppBand) {
  const href = afterOrgSwitchHref(me, band);
  if (band === 'deciship' && href === '/deciship/today') router.dismissTo(href);
  else router.replace(href);
}
