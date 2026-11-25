import { accountFetch, accountJson, productFetch } from '../api/client';
import { withoutClosedOrgs } from '../auth/access';
import { AUDIT_PAGE_SIZE, slimAudit, type AuditPage } from './activity';
import type { HubActivityPage, HubOverview, MeResponse, OrgRolesResponse, ProductKey } from './contracts';
import { query, readJson, toHubError } from './http';
import type { InviteBody, InviteResult } from './invite';
import { asMembers, stripContact, type OrgMember } from './views';

/** Merkez uçları (ARCHITECTURE §6, §7). Mobil ağ erişiminin tamamı bu dosyada. Dil başlığını istemci koyar. */

async function call<T>(run: () => Promise<Response>): Promise<T> {
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    throw toHubError(e);
  }
  return readJson<T>(res);
}

// Kapalı firma mobilde görünmez (`withoutClosedOrgs`).
export const fetchMe = async () => withoutClosedOrgs(await call<MeResponse>(() => accountFetch('/me')));

export const fetchOverview = (product: ProductKey, from: string, to: string) => call<HubOverview>(() => productFetch(product, `/platform/overview${query({ from, to })}`));

/** Salt okunur ekip listesi. İletişim bilgisi cihaza inmez. Yalnız OWNER/ADMIN; sunucu da 403 döner. */
export const fetchMembers = async (): Promise<OrgMember[]> => stripContact(asMembers(await call<unknown>(() => accountFetch('/org/members'))));

/** Aracın etkinlik akışı (web `fetchActivity`); rapor izni ister. */
export const fetchProductActivity = (product: ProductKey, page: number) => call<HubActivityPage>(() => productFetch(product, `/platform/activity${query({ page: String(page) })}`));

/** Hesap denetim izi (web Etkinlik "Hesap" kaynağı); yalnız OWNER/ADMIN. Ekranın okumadığı ayrıntı düşer. */
export const fetchAudit = async (page: number): Promise<AuditPage> => slimAudit(await call<AuditPage>(() => accountFetch(`/org/audit${query({ page: String(page), pageSize: String(AUDIT_PAGE_SIZE) })}`)));

/**
 * Firmada görünen roller (davet formu listesi). Eski sunucuda uç yok (404) ya da istek düşerse `null`: çağıran katalog listesine düşer.
 */
export const fetchOrgRoles = async (): Promise<OrgRolesResponse | null> => {
  try {
    return await call<OrgRolesResponse>(() => accountFetch('/org/roles'));
  } catch {
    return null;
  }
};

/**
 * Telefon + kod daveti (web `InvitePanel`). Hata `ApiError` olarak atılır: `retryAfterMs` ve `details` korunur.
 * POST kendiliğinden tekrarlanmaz (istemci kuralı): çift davet çıkmaz.
 */
export const inviteByPhone = (body: InviteBody) => accountJson<InviteResult>('/org/members/invite', { method: 'POST', json: body });
