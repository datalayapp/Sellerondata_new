import * as SecureStore from 'expo-secure-store';
import { isBelowMinimum } from '@sellerondata/contracts';
import { APP_VERSION, VERSION_KNOWN } from './client';

/**
 * "Bu sürüm artık desteklenmiyor" durumu (Mesaj 13 §3.3, §3.5).
 *
 * Kaynaklar: (1) herhangi bir yanıtın `426 UPGRADE_REQUIRED` olması (`api/client.ts`), (2) açılışta ve öne gelişte
 * `GET /api/account/client-policy` denetimi (`checkPolicy`). Durum telefonda `sod_upgrade_required` olarak saklanır,
 * böylece uygulama çevrimdışı açılsa da kuyruk boşuna gönderim denemez.
 *
 * Kurallar:
 * - Ağ hatası, zaman aşımı, başarısız ya da bozuk yanıt durumu hiçbir zaman açmaz ve değiştirmez.
 * - Bayrak, uygulamanın sürümü değişince (güncelleme kuruldu) ya da sunucu "gerek yok" deyince kalkar.
 * - Kendi sürümünü okuyamayan uygulama politika yüzünden kendini kilitlemez.
 */

export type UpgradeState = { required: false } | { required: true; minVersion: string | null; updateUrl: string | null };

export const K_UPGRADE = 'sod_upgrade_required';
/** Politika ucunun zaman aşımı. Yanıt gelmezse uygulama beklemeden açılır. */
export const POLICY_TIMEOUT_MS = 5000;

type Stored = { minVersion: string | null; updateUrl: string | null; forVersion: string };

const NOT_REQUIRED: UpgradeState = { required: false };

let state: UpgradeState = NOT_REQUIRED;
/** Her durum değişiminde artar: açılış okuması sürerken gelen 426 sonucu, okuma bitince ezilmesin. */
let generation = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<(s: UpgradeState) => void>();

function emit(next: UpgradeState): void {
  const same =
    next.required === state.required &&
    (!next.required || (state.required && next.minVersion === state.minVersion && next.updateUrl === state.updateUrl));
  generation++;
  if (same) return; // Aynı durum: nesne değişmez (React `useSyncExternalStore` anlık görüntüsü kararlı kalsın).
  state = next;
  listeners.forEach((fn) => fn(state));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Yalnız http(s) bağlantı açılır; `intent:`, `javascript:` gibi şemalar atılır. */
function safeUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\/\S+$/i.test(s) ? s : null;
}

function writeStored(value: Stored | null): Promise<void> {
  const op = value ? SecureStore.setItemAsync(K_UPGRADE, JSON.stringify(value)) : SecureStore.deleteItemAsync(K_UPGRADE);
  return op.catch((e) => console.warn('upgrade flag', e));
}

export function getUpgradeState(): UpgradeState {
  return state;
}

export function isUpgradeRequired(): boolean {
  return state.required;
}

export function onUpgradeChange(fn: (s: UpgradeState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Sunucu bu sürümü reddetti. `details` 426 gövdesindeki `error.details` (`{ minVersion, updateUrl }`); eksik ya da bozuk olabilir.
 * Yeni değer boşsa eldeki bilinen değer korunur: DeciShip API'nin 426'sı bağlantı taşımaz, "indir" düğmesi kaybolmasın.
 * Durum bellekte hemen değişir; kalıcı kayıt arkadan yazılır (dönen söz beklenebilir).
 */
export function setUpgradeRequired(details: unknown): Promise<void> {
  const d = (details && typeof details === 'object' ? details : {}) as { minVersion?: unknown; updateUrl?: unknown };
  const known = state.required ? state : null;
  const minVersion = str(d.minVersion) ?? known?.minVersion ?? null;
  const updateUrl = safeUrl(d.updateUrl) ?? known?.updateUrl ?? null;
  emit({ required: true, minVersion, updateUrl });
  return writeStored({ minVersion, updateUrl, forVersion: APP_VERSION });
}

/** Sunucu "gerek yok" dedi: bayrak kalkar, kayıt silinir. */
export function clearUpgradeRequired(): Promise<void> {
  emit(NOT_REQUIRED);
  return writeStored(null);
}

/**
 * Açılışta kayıtlı bayrağı bir kez okur (sonraki çağrılar aynı sözü bekler).
 * Kayıt başka bir sürüme aitse (güncelleme kuruldu) ya da bozuksa silinir.
 */
export function loadUpgradeFlag(): Promise<void> {
  if (!loading) {
    const startedAt = generation;
    loading = (async () => {
      let raw: string | null = null;
      try {
        raw = await SecureStore.getItemAsync(K_UPGRADE);
      } catch {
        return; // Okunamadı: engelleme yok.
      }
      if (raw === null) return;
      let stored: Partial<Stored> | null = null;
      try {
        stored = JSON.parse(raw) as Partial<Stored> | null;
      } catch {
        stored = null;
      }
      const valid = !!stored && typeof stored === 'object' && stored.forVersion === APP_VERSION;
      // Bu arada 426 ya da politika sonucu geldiyse o geçerlidir (kaydı da o yazdı ya da sildi).
      if (generation !== startedAt) return;
      if (!valid) {
        await writeStored(null);
        return;
      }
      emit({ required: true, minVersion: str(stored!.minVersion), updateUrl: safeUrl(stored!.updateUrl) });
    })();
  }
  return loading;
}

/**
 * En düşük sürüm politikasını sunucudan okur ve durumu günceller. `fetchPolicy` `api/client.ts` `fetchClientPolicy`
 * (oturumsuz, `POLICY_TIMEOUT_MS`). Ağ hatası ya da geçersiz yanıtta durum olduğu gibi kalır.
 */
export async function checkPolicy(fetchPolicy: () => Promise<Response>): Promise<UpgradeState> {
  await loadUpgradeFlag();
  // Yanıt beklenirken durum değişirse (arada 426 geldi) o daha yenidir: "gerek yok" onu silmez.
  const startedAt = generation;
  let body: unknown;
  try {
    const res = await fetchPolicy();
    if (res.status !== 200) return state;
    body = await res.json();
  } catch {
    return state;
  }
  const mobile = (body as { mobile?: unknown } | null)?.mobile;
  if (!mobile || typeof mobile !== 'object') return state;
  const m = mobile as { minVersion?: unknown; updateUrl?: unknown };
  const minVersion = str(m.minVersion);
  if (VERSION_KNOWN && minVersion && isBelowMinimum(APP_VERSION, minVersion)) {
    await setUpgradeRequired({ minVersion, updateUrl: m.updateUrl });
  } else if (generation === startedAt) {
    // "Gerek yok": en düşük sürüm yok, bozuk ya da bu sürüm yeterli. Kendi sürümünü bilmeyen uygulama da kilitlenmez.
    await clearUpgradeRequired();
  }
  return state;
}
