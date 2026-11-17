import { looksLikePhone } from '../auth/errors';
import { NAME_MAX_LENGTH, PRODUCTS, PRODUCT_KEYS, isRolePermissionsLocked, ownerOnlyPermissionsIn, pickInviteRole, type Locale, type MeResponse, type OrgRolesResponse, type ProductKey } from './contracts';

/**
 * Telefondan çalışan ekleme: telefon + tek seferlik kod (web Merkez `Team.tsx` `InvitePanel`, `kind: PHONE_CODE`).
 * Uç `POST /api/account/org/members/invite`; yalnız firma sahibi ve yöneticisi (sunucu `requireManager`, web `isOrgAdmin`).
 * Firma rolü her zaman çalışan (MEMBER). Yönetici rolü ve e-posta daveti web'de. Saf: RN bilmez, test edilir.
 */

export { NAME_MAX_LENGTH };

/** Ekip ekranının araçları (web `teamProducts`): bu firmada açık, aboneliği olan ve rol tanımı olan araçlar, kayıt sırasıyla. */
export function inviteTools(me: MeResponse | null | undefined): ProductKey[] {
  return PRODUCT_KEYS.filter((k) => {
    const p = me?.products.find((x) => x.key === k);
    return !!p && p.available && !!p.subscription && PRODUCTS[k].roles.length > 0;
  });
}

export type InviteRoleOption = { key: string; label: string; description: string };

/**
 * Telefondan verilebilen araç rolleri: katalogdaki roller, tam yetkili sahip rolü (`ownerRole`, DeciShip'te Yönetici) hariç.
 * Sıra en az yetkiliden çoğa (DeciShip: Ölçüm, Muhasebe, Denetleyici). Etiket ve açıklama katalogdan.
 */
export function inviteRoleOptions(product: ProductKey, locale: Locale): InviteRoleOption[] {
  const def = PRODUCTS[product];
  return def.roles
    .filter((r) => !isRolePermissionsLocked(product, r.key))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.permissions.length - b.r.permissions.length || a.i - b.i)
    .map(({ r }) => ({ key: r.key, label: r.label[locale], description: r.description[locale] }));
}

/** Araç başına davet seçenekleri (sunucudan ya da katalogdan çözülmüş). Verilmeyen araç katalogdan. */
export type InviteRoleSource = Partial<Record<ProductKey, readonly InviteRoleOption[]>>;

/**
 * Sunucu rol listesinden (`GET /org/roles`) davet seçenekleri: firmada görünen roller, sunucu sırasıyla. Hazır ve özel roller ayrımı yok.
 * Çıkanlar: izinleri kilitli roller (sahip rolü), sahibe özel izin taşıyan roller (yalnız OWNER davet edebilir).
 * `res` yoksa (eski sunucu 404, hata) ya da araç listede yoksa `null`: çağıran katalog listesine düşer.
 */
export function inviteRoleOptionsFromServer(res: OrgRolesResponse | null | undefined, product: ProductKey, orgRole: string | null | undefined): InviteRoleOption[] | null {
  const entry = res?.products?.find((p) => p.key === product);
  if (!entry || !Array.isArray(entry.roles)) return null;
  return entry.roles
    .filter((r) => !r.permissionsLocked && !isRolePermissionsLocked(product, r.key))
    .filter((r) => orgRole === 'OWNER' || ownerOnlyPermissionsIn(product, r.permissions).length === 0)
    .map((r) => ({ key: r.key, label: r.name, description: r.description ?? '' }));
}

/** Tüm araçlar için seçenekler: sunucu yanıtı varsa ondan, yoksa katalogdan. */
export function resolveInviteRoles(res: OrgRolesResponse | null | undefined, tools: readonly ProductKey[], orgRole: string | null | undefined, locale: Locale): InviteRoleSource {
  return Object.fromEntries(tools.map((k) => [k, inviteRoleOptionsFromServer(res, k, orgRole) ?? inviteRoleOptions(k, locale)]));
}

/** Varsayılan rol: `pickInviteRole` (katalogdaki davet rolü görünüyorsa o, yoksa ilk seçenek). Seçenekler verilmezse katalogdan. */
export function defaultInviteRole(product: ProductKey, source?: InviteRoleSource): string | null {
  const options = source?.[product] ?? inviteRoleOptions(product, 'tr');
  return pickInviteRole(product, options.map((o) => o.key));
}

export type InviteForm = { name: string; phone: string; roles: Partial<Record<ProductKey, string | null>> };

export function initialInviteForm(tools: readonly ProductKey[], source?: InviteRoleSource): InviteForm {
  return { name: '', phone: '', roles: Object.fromEntries(tools.map((k) => [k, defaultInviteRole(k, source)])) };
}

export type InviteFieldError = { name?: 'required' | 'tooLong'; phone?: 'required' | 'invalid' };

/** Gönderimden önce kaba denetim; telefonun asıl denetimi sunucuda (ülke kuralı). */
export function validateInvite(form: Pick<InviteForm, 'name' | 'phone'>): InviteFieldError {
  const out: InviteFieldError = {};
  const name = form.name.trim();
  if (!name) out.name = 'required';
  else if (name.length > NAME_MAX_LENGTH) out.name = 'tooLong';
  const phone = form.phone.trim();
  if (!phone) out.phone = 'required';
  else if (!looksLikePhone(phone)) out.phone = 'invalid';
  return out;
}

export type InviteBody = { kind: 'PHONE_CODE'; name: string; phone: string; orgRole: 'MEMBER'; productRoles: Partial<Record<ProductKey, string | null>> };

/**
 * İstek gövdesi. Her araç için rol yazılır (web gibi). Telefondan verilemeyen rol (yönetici) gönderilmez, `null` olur:
 * yönetici rolü yalnız web'de.
 */
export function inviteBody(form: InviteForm, tools: readonly ProductKey[], source?: InviteRoleSource): InviteBody {
  const productRoles: InviteBody['productRoles'] = {};
  for (const k of tools) {
    // Seçim yoksa (form araç listesi gelmeden kurulduysa) varsayılan davet rolü: kişi rolsüz eklenmesin.
    const picked = form.roles[k] === undefined ? defaultInviteRole(k, source) : form.roles[k];
    const options = source?.[k] ?? inviteRoleOptions(k, 'tr');
    productRoles[k] = picked && options.some((o) => o.key === picked) ? picked : null;
  }
  return { kind: 'PHONE_CODE', name: form.name.trim(), phone: form.phone.trim(), orgRole: 'MEMBER', productRoles };
}

/** Sunucu yanıtı: telefon davetinde `code` döner (yalnız bir kez). */
export type InviteResult = { code?: string; link?: string; invitation?: { id: string } };

export type InviteError =
  | { key: 'limitIn'; minutes: number }
  | { key: 'limit' }
  | { key: 'phoneInvalid' }
  | { key: 'alreadyMember' }
  | { key: 'forbidden' }
  | { key: 'network' }
  | { key: 'server'; message: string | null };

/**
 * Hata → ekran metni anahtarı (web `inviteError` ile aynı anlam). Davet sınırında kaç dakika sonra deneneceği `retry-after`ten.
 * Bilinmeyen hata sunucunun yerelleşmiş metniyle (`contracts/errors.ts`), o da yoksa genel sunucu metniyle gösterilir.
 */
export function inviteError(e: unknown): InviteError {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown; details?: unknown; retryAfterMs?: unknown };
  const status = typeof err.status === 'number' ? err.status : -1;
  const code = typeof err.code === 'string' ? err.code : '';
  if (status === 0 || code === 'NETWORK' || code === 'TIMEOUT') return { key: 'network' };
  if (code === 'TOO_MANY_ATTEMPTS') {
    const ms = typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0 ? err.retryAfterMs : null;
    return ms ? { key: 'limitIn', minutes: Math.max(1, Math.ceil(ms / 60_000)) } : { key: 'limit' };
  }
  if (code === 'ALREADY_MEMBER') return { key: 'alreadyMember' };
  if (code === 'VALIDATION') {
    const first = Array.isArray(err.details) ? (err.details[0] as { path?: unknown; code?: unknown; message?: unknown } | undefined) : undefined;
    const path = Array.isArray(first?.path) ? first.path.join('.') : first?.path;
    if (first?.code === 'invalid_phone' || path === 'phone') return { key: 'phoneInvalid' };
    // Başka alan (ör. adda bağlantı): hangi alanın neden reddedildiğini sunucunun metni söyler (web `apiMessage`).
    if (typeof first?.message === 'string' && first.message.trim()) return { key: 'server', message: first.message };
  }
  if (status === 403) return { key: 'forbidden' };
  // Yalnız sunucudan gelen metin gösterilir; uygulama içi beklenmeyen hatanın metni kişiye gösterilmez.
  const message = status > 0 && typeof err.message === 'string' && err.message.trim() && code !== 'UNKNOWN' ? err.message : null;
  return { key: 'server', message };
}
