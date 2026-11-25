import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { i18n } from "../../i18n/index.ts";
import { type ConfirmFn, useConfirm } from "../../lib/notify.ts";

/**
 * Gezinme bekçisi: ekran "kaydedilmemiş değişiklik var" der; adres (hash) değişimi onaysız olmaz.
 *
 * Tezgâh'ta bütün gezinme adres değişimidir: üst menü bağlantıları, Alt 1–5 (`go`), ekranın geri düğmesi, tarayıcının
 * geri/ileri tuşu. Bekçi `hashchange`'i herkesten önce dinler (modül yüklenirken kaydolur): etkin bir bekçi varsa
 * olayı durdurur (rota değişmez), adresi geri yazar ve `useConfirm` ile sorar; "Kaydetmeden çık" denirse hedef adrese
 * gider. Sekme kapatma ve yenilemede tarayıcının kendi uyarısı (`beforeunload`) çıkar.
 *
 * Not: `go(…, replace = true)` hashchange üretmez (adresi yerinde değiştirir); ekran içi durum içindir, bekçiye takılmaz.
 */
export interface LeaveGuardOptions {
  /** Onay başlığı; varsayılan "Değişiklikler kaydedilmedi". */
  title?: string;
  body?: ReactNode;
  /** Onay düğmesi; varsayılan "Kaydetmeden çık". */
  confirm?: string;
  /** Bu adrese gitmek serbest mi (aynı ekran içindeki adres değişimi gibi)? `next`: "#/…". */
  allow?(next: string): boolean;
}

export interface LeaveGuard {
  /** Bir sonraki adres değişimi sorulmadan geçer (kaydettikten hemen sonra gitmek için). */
  pass(): void;
}

interface Entry {
  confirm: ConfirmFn;
  opts: { current: LeaveGuardOptions };
}

const guards: Entry[] = [];
let lastHash = typeof window === "undefined" ? "" : window.location.hash;
/** Bu ana kadarki adres değişimleri sorulmadan geçer (onaydan ya da `pass()`'tan hemen sonraki gezinme). */
let bypassUntil = 0;
let asking = false;
const BYPASS_MS = 1000;
/** Geri yazdığımız adres: bazı ortamlar (happy-dom) `replaceState`'te de hashchange yollar; o yankı yok sayılır. */
let reverted: string | null = null;

function blocking(next: string): Entry | undefined {
  for (let i = guards.length - 1; i >= 0; i--) {
    const g = guards[i]!;
    if (!g.opts.current.allow?.(next)) return g;
  }
  return undefined;
}

function onHashChange(e: HashChangeEvent) {
  const next = window.location.hash;
  if (reverted !== null && window.location.href === reverted) {
    reverted = null;
    e.stopImmediatePropagation();
    return;
  }
  reverted = null;
  if (Date.now() < bypassUntil) {
    bypassUntil = 0;
    lastHash = next;
    return;
  }
  const g = blocking(next);
  if (!g) {
    lastHash = next;
    return;
  }
  // Rota dinleyicileri görmesin; adres eski haline dönsün (replaceState olay üretmez).
  e.stopImmediatePropagation();
  // Önceki adres olaydan (`oldURL`); `go(…, replace)` olay üretmeden adres değiştirmiş olabilir.
  history.replaceState(history.state, "", e.oldURL || lastHash || window.location.pathname + window.location.search);
  reverted = window.location.href;
  if (asking) return;
  asking = true;
  const o = g.opts.current;
  void g
    .confirm({
      title: o.title ?? i18n.t("common:dialog.dirtyTitle"),
      body: o.body ?? i18n.t("common:leave.body"),
      confirmLabel: o.confirm ?? i18n.t("common:leave.confirm"),
      tone: "danger",
    })
    .then((ok) => {
      asking = false;
      if (!ok) return;
      bypassUntil = Date.now() + BYPASS_MS;
      window.location.hash = next;
    });
}

/** Onaydan sonra sayfadan bilerek ayrılınıyor (giriş, firma değişimi): tarayıcının uyarısı yeniden çıkmaz. */
let unloadAllowed = false;

/** Ekranlardan birinde kaydedilmemiş değişiklik var mı (etkin bekçi)? */
export function hasUnsavedChanges(): boolean {
  return guards.length > 0;
}

/** Kişi kaydedilmemiş değişikliği bırakmayı onayladı: sonraki sayfa değişimi (`location.assign`) uyarısız. */
export function allowUnload(): void {
  unloadAllowed = true;
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!guards.length || unloadAllowed) return;
  e.preventDefault();
  e.returnValue = "";
}

if (typeof window !== "undefined") {
  // Yakalama evresinde ve ilk kaydolan olarak: rota kancalarının (useAppRoute) dinleyicilerinden önce çalışır.
  window.addEventListener("hashchange", onHashChange, true);
  window.addEventListener("beforeunload", onBeforeUnload);
}

/** `dirty` iken ekrandan çıkmak onay ister. Dönen `pass()` bir sonraki gezinmeyi serbest bırakır. */
export function useLeaveGuard(dirty: boolean, opts: LeaveGuardOptions = {}): LeaveGuard {
  const confirm = useConfirm();
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!dirty) return;
    const entry: Entry = { confirm, opts: ref };
    guards.push(entry);
    return () => {
      const i = guards.indexOf(entry);
      if (i >= 0) guards.splice(i, 1);
    };
  }, [dirty, confirm]);
  return useMemo(
    () => ({
      pass: () => {
        bypassUntil = Date.now() + BYPASS_MS;
      },
    }),
    [],
  );
}

/** Test ve sağlayıcı değişimi için: bekçinin bildiği son adres. */
export function resetLeaveGuard() {
  lastHash = window.location.hash;
  bypassUntil = 0;
  asking = false;
  reverted = null;
  unloadAllowed = false;
}
