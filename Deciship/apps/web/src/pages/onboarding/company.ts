/**
 * Firma bilgileri (ad, ülke, para birimi, saat dilimi) yalnız Merkez'de kurulur ve onaylanır; sihirbaz yalnız okur
 * (KARARLAR "Merkez kurulumu ve araç kurulumu"). React'siz: birim testleri düz Node ile içe aktarır.
 */
import { isCompanyConfirmed, type MeResponse } from '@sellerondata/contracts';
import { toFullPath } from '../../lib/base.ts';
import type { OnboardingStatus } from '../../api/types';

type ActiveOrg = MeResponse['activeOrg'];

/** Merkez firma sayfası (ayrı uygulama, tam sayfa gezinti). */
export const HUB_COMPANY_PATH = '/account/company';

export interface CompanyFacts {
  name: string;
  country: string;
  currency: string;
  timeZone: string;
}

/**
 * Onay: Merkez `/me` (taze) varsa ondan, yoksa DeciShip'in olaydan tuttuğu kopyadan. Kopyada alan yoksa (eski sunucu)
 * onaylı sayılır: Hesap'ın geriye dönük doldurmasıyla aynı yön.
 */
export function companyConfirmed(activeOrg: ActiveOrg | undefined, status: Pick<OnboardingStatus, 'company'>): boolean {
  if (activeOrg) return isCompanyConfirmed(activeOrg);
  return status.company.confirmed !== false;
}

/** Gösterilen değerler Merkez `/me`'den; eksik alan sihirbaz yanıtından. */
export function companyFacts(activeOrg: ActiveOrg | undefined, company: OnboardingStatus['company']): CompanyFacts {
  return {
    name: activeOrg?.name || company.name || '',
    country: activeOrg?.country || company.country || '',
    currency: activeOrg?.currency || company.currency || '',
    timeZone: activeOrg?.timeZone || company.timeZone || '',
  };
}

/**
 * "Merkez'de onayla" adresi: onaydan sonra Merkez `next` ile kişiyi sihirbazda kaldığı yere döndürür. `next` aynı kökende
 * göreli tam yoldur (DeciShip `/deciship` altında: router yolu tam yola çevrilir, parametreler korunur).
 */
export function hubConfirmHref(routerPath: string, search = ''): string {
  const q = search && !search.startsWith('?') ? `?${search}` : search;
  return `${HUB_COMPANY_PATH}?next=${encodeURIComponent(toFullPath(routerPath) + q)}`;
}

/** "Europe/Istanbul (GMT+3)": Merkez firma sayfasıyla aynı yazım; IANA adı her dilde aynı. */
export function timeZoneLabel(zone: string): string {
  if (!zone) return '';
  const name = zone.replace(/_/g, ' ');
  if (zone === 'UTC') return name;
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return offset ? `${name} (${offset})` : name;
  } catch {
    return name;
  }
}

/** Ülke adı etkin dilde ("TR" → "Türkiye" / "Türkiye"); bilinmiyorsa kod. */
export function countryLabel(code: string, lang: string): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
