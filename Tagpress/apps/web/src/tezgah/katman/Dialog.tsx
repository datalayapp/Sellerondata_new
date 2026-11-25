import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { type FeatureOff, goToConnections, recentFeatureOff, recentMissingKey } from "../../lib/api.ts";
import { enableFeature, featureDictId } from "../../lib/features.ts";
import { ConfirmContext, type ConfirmOptions, ToastContext, type ToastInput } from "../../lib/notify.ts";
import { cx } from "../cx.ts";
import { Button, IconButton } from "../dugme/Button.tsx";
import { Icon } from "../ikon/Icon.tsx";
import { focusables, pushDialog, useTopDialog } from "./ortak.ts";
import "./katman.css";

export { useConfirm, useToast } from "../../lib/notify.ts";
export type { ConfirmOptions, ToastInput } from "../../lib/notify.ts";

export interface DialogProps {
  title: string;
  onClose(): void;
  size?: "sm" | "md" | "lg";
  /** Kaydedilmemiş değişiklik var: Esc, X ve dışa tıklama önce sarı onay şeridini açar (platform DESIGN §4b). */
  dirty?: boolean;
  /** İşlem sürüyor: pencere kapanmaz. */
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Pencere: tarayıcının modal `<dialog>`'u (üst katman, arka plan etkisiz). Üstüne:
 * - Odak tuzağı: Tab son öğeden ilkine, Shift Tab ilkinden sona döner (pencerenin içine açılan paneller dahil).
 * - Açılınca odak `data-autofocus` işaretli öğeye, yoksa gövdedeki ilk öğeye, yoksa alttaki ilk düğmeye.
 * - Esc, X ve arka plana tıklama kapatır; `dirty` iken önce sarı onay şeridi (ikinci Esc düzenlemeye döner);
 *   `busy` iken kapanmaz.
 * - Kapanınca odak pencereyi açan öğeye döner.
 */
export function Dialog({ title, onClose, size = "md", dirty, busy, footer, children }: DialogProps) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);
  const titleId = useId();
  const askId = useId();
  // Açan öğe: ilk çizimde (çocukların odak almasından önce) okunur.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      if (!el.hasAttribute("open")) el.setAttribute("open", "");
    }
    const target =
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      focusables(el.querySelector(".tz-dlg-b") ?? el)[0] ??
      focusables(el.querySelector(".tz-dlg-f") ?? el)[0] ??
      focusables(el)[0];
    target?.focus({ preventScroll: true });
    const drop = pushDialog(el);
    return () => {
      drop();
      if (el.open && typeof el.close === "function") el.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useEffect(() => {
    if (!dirty) setAsking(false);
  }, [dirty]);

  // Onay şeridi açılınca odak "Düzenlemeye dön"e; kapanınca pencerenin ilk öğesine.
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) keepRef.current?.focus({ preventScroll: true });
    else if (wasAsking.current && ref.current && !ref.current.contains(document.activeElement)) focusables(ref.current.querySelector(".tz-dlg-b") ?? ref.current)[0]?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) setAsking(true);
    else onClose();
  }, [busy, dirty, onClose]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (asking) setAsking(false);
      else requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    const el = e.currentTarget;
    const list = focusables(el);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const at = document.activeElement;
    const outside = !at || !el.contains(at) || at === el;
    if (e.shiftKey && (at === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || outside)) {
      e.preventDefault();
      first.focus();
    }
    e.stopPropagation();
  };

  return (
    <dialog
      ref={ref}
      className={cx("tz-dlg", `tz-dlg--${size}`)}
      aria-labelledby={titleId}
      aria-modal="true"
      aria-busy={busy || undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (asking) setAsking(false);
        else requestClose();
      }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === ref.current) requestClose();
      }}
    >
      <div className="tz-dlg-h">
        <h2 id={titleId}>{title}</h2>
        <IconButton icon="x" label={busy ? t("dialog.busy") : t("actions.close")} size={28} disabled={busy} onClick={requestClose} />
      </div>
      <div className="tz-dlg-b">{children}</div>
      {asking ? (
        <div className="tz-dlg-f tz-dlg-f--ask" role="alertdialog" aria-labelledby={askId} aria-describedby={`${askId}-b`}>
          <Icon name="warn" size={18} className="tz-dlg-ask-i" />
          <div className="tz-dlg-ask">
            <b id={askId}>{t("dialog.dirtyTitle")}</b>
            <span id={`${askId}-b`}>{t("dialog.dirtyBody")}</span>
          </div>
          <Button variant="secondary" ref={keepRef} onClick={() => setAsking(false)}>
            {t("dialog.keepEditing")}
          </Button>
          <Button variant="danger" onClick={onClose}>
            {t("dialog.discard")}
          </Button>
        </div>
      ) : (
        footer && <div className="tz-dlg-f">{footer}</div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- bildirim (geri al dahil)

interface ToastItem extends ToastInput {
  id: number;
}

/** Varsayılan süreler (ms): düz 6 sn, eylemli ya da hatalı 10 sn. Üzerindeyken ya da odaktayken süre durur. */
const TOAST_MS = 6000;
const TOAST_LONG_MS = 10000;
const TOAST_MAX = 4;

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useTranslation("common");
  const total = item.duration ?? (item.action || item.tone === "error" ? TOAST_LONG_MS : TOAST_MS);
  const left = useRef(total);
  const started = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const hold = useRef(0);

  const run = useCallback(() => {
    window.clearTimeout(timer.current);
    started.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(item.id), Math.max(0, left.current));
  }, [item.id, onDismiss]);
  const pause = () => {
    if (hold.current++ > 0) return;
    window.clearTimeout(timer.current);
    left.current -= Date.now() - started.current;
  };
  const resume = () => {
    if (--hold.current > 0) return;
    hold.current = 0;
    run();
  };

  useEffect(() => {
    run();
    return () => window.clearTimeout(timer.current);
  }, [run]);

  return (
    <div
      className={cx("tz-toast", item.tone && `tz-toast--${item.tone}`)}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
      }}
    >
      <Icon name={item.tone === "error" ? "err" : item.tone === "success" ? "check" : "okc"} size={15} />
      <span className="tz-toast-m">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="tz-toast-a"
          onClick={async () => {
            onDismiss(item.id);
            await item.action?.run();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="tz-toast-x" aria-label={t("actions.close")} title="" onClick={() => onDismiss(item.id)}>
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}

/** Bildirim metni son `feature-off` hatasına mı ait (sunucu cümlesi ya da sözlükteki karşılığı). */
function featureOffFor(message: string): FeatureOff | null {
  const off = recentFeatureOff();
  if (!off) return null;
  return message.includes(off.error) || message.includes(i18n.t("errors:feature-off")) ? off : null;
}

/** "Aç": özelliği açar, bütün sorguları tazeler; reddedilen isteği "Yeniden dene" eylemiyle sunar. */
async function turnOnFeature(off: FeatureOff, qc: QueryClient | undefined, push: (x: ToastInput) => void): Promise<void> {
  const name = i18n.exists(`setup:feat.${featureDictId(off.feature)}.name`) ? i18n.t(`setup:feat.${featureDictId(off.feature)}.name`) : off.feature;
  try {
    await enableFeature(off.feature);
  } catch (e) {
    push({ message: serverText(e), tone: "error" });
    return;
  }
  void qc?.invalidateQueries();
  push({
    message: i18n.t("common:featureOff.turnedOn", { name }),
    tone: "success",
    action: {
      label: i18n.t("common:featureOff.retry"),
      run: async () => {
        try {
          await off.retry();
          void qc?.invalidateQueries();
          push({ message: i18n.t("common:featureOff.retried"), tone: "success" });
        } catch (e) {
          push({ message: serverText(e), tone: "error" });
        }
      },
    },
  });
}

/**
 * Bildirimler: sağ üstte yığın (en çok 4). Hatalar ayrı, kesintili (`assertive`) canlı bölgede; diğerleri kibar
 * (`polite`). "Geri al" gibi tek eylem; tıklanınca bildirim kapanır ve eylem çalışır. Açık bir modal pencere varken
 * yığın en üstteki pencerenin içine konur (üst katmanda görünür, tıklanır, pencerenin Tab döngüsüne girer).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const qc = useContext(QueryClientContext);
  const pushRef = useRef<(x: ToastInput) => void>(() => {});
  const push = useCallback(
    (raw: ToastInput) => {
      // "Anahtar yok" hatası: bildirime Ayarlar → Bağlantılar eylemi eklenir (eski arayüzle aynı).
      const missing = raw.tone === "error" && !raw.action && typeof raw.message === "string" ? recentMissingKey() : null;
      // "Özellik kapalı" hatası: bildirime "Aç" eklenir (özelliği açar, sonra isteği yeniden denemeyi sunar).
      const off = !missing && raw.tone === "error" && !raw.action && typeof raw.message === "string" ? featureOffFor(raw.message) : null;
      const input: ToastInput =
        missing && typeof raw.message === "string" && raw.message.includes(missing)
          ? { ...raw, action: { label: t("actions.goToConnections"), run: goToConnections } }
          : off
            ? { ...raw, action: { label: t("featureOff.turnOn"), run: () => turnOnFeature(off, qc, (x) => pushRef.current(x)) } }
            : raw;
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-(TOAST_MAX - 1)), { ...input, id }]);
    },
    [t, qc],
  );
  pushRef.current = push;
  const errors = items.filter((x) => x.tone === "error");
  const others = items.filter((x) => x.tone !== "error");
  const top = useTopDialog();
  // Kalıcı kap: React portalı hep bu öğeye yazar; pencere açılıp kapanınca yalnız kabın kendisi taşınır
  // (`appendChild`). Portal hedefi değişseydi React eski hedeften `removeChild` yapardı; hedef dışarıdan
  // temizlenmişse (test sonrası `body.innerHTML = ""`, kaldırılan pencere) bu hata verir.
  const [box] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "tz-toasts";
    return el;
  });
  useLayoutEffect(() => {
    if (!box) return;
    const host = top?.isConnected ? top : document.body;
    if (box.parentNode !== host) host.appendChild(box);
  }, [box, top]);
  useLayoutEffect(() => () => box?.remove(), [box]);
  const groups = (
    <>
      <div className="tz-toasts-g" aria-live="assertive" aria-atomic="false">
        {errors.map((x) => (
          <ToastView key={x.id} item={x} onDismiss={dismiss} />
        ))}
      </div>
      <div className="tz-toasts-g" aria-live="polite" aria-atomic="false">
        {others.map((x) => (
          <ToastView key={x.id} item={x} onDismiss={dismiss} />
        ))}
      </div>
    </>
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      {box && createPortal(groups, box)}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- onay penceresi

/**
 * `useConfirm()` sağlayıcısı. Enter onaylar, Esc vazgeçer. Tehlikeli onayda odak "Vazgeç"te başlar (yanlışlıkla
 * Enter silmesin); diğerinde onay düğmesinde. Önceki soru açıkken yenisi gelirse önceki "hayır" sayılır.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void; id: number }) | null>(null);
  const seq = useRef(0);
  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setState((prev) => {
          prev?.resolve(false);
          return { ...o, resolve, id: ++seq.current };
        }),
      ),
    [],
  );
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const danger = state?.tone === "danger";
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state && (
        <Dialog
          key={state.id}
          title={state.title}
          size="sm"
          onClose={() => done(false)}
          footer={
            <>
              <Button variant="quiet" data-autofocus={danger ? "" : undefined} onClick={() => done(false)}>
                {t("actions.cancel")}
              </Button>
              <Button variant={danger ? "danger" : "primary"} data-autofocus={danger ? undefined : ""} onClick={() => done(true)}>
                {state.confirmLabel ?? t("actions.ok")}
              </Button>
            </>
          }
        >
          {typeof state.body === "string" ? <p>{state.body}</p> : state.body}
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}
