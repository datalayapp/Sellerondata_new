import { createContext, type ReactNode, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScreenLayoutContext } from "../cerceve/duzen.ts";
import { IconButton } from "../dugme/Button.tsx";
import { focusables, pushDialog, useTopDialog } from "./ortak.ts";
import "./WorkDialog.css";

export interface WorkDialogProps {
  title: string;
  /** Başlığın yanında soluk bağlam ("№ 10482 · V2 · Ayşe & Mehmet"); sığmazsa üç noktayla kısalır. */
  subtitle?: string;
  /**
   * Kapatma isteği: X, Esc (içerikteki bir kısayol Esc'i işlemediyse) ve tarayıcının kapatma isteği. Pencereyi çağıran
   * kapatır; kaydedilmemiş değişikliği sormak içeriğin işidir (pencerenin sarı onay şeridi yok).
   */
  onRequestClose(): void;
  /** Altta sabit şerit (durum notu, Vazgeç, Kaydet); içerik isterse kendisi `WorkDialogFooter` ile de çizebilir. */
  footer?: ReactNode;
  children: ReactNode;
}

const ActiveContext = createContext(false);

/**
 * Pencerenin içindeki içerik şu an en üstteki pencerede mi (üstünde onay ya da `?` listesi açık değil)? Pencere içi
 * kısayollar `useCommands(…, { modal: true, enabled: useWorkDialogActive() })` ile bağlanır: alttaki ekranın
 * kısayolları kapalı kalır, üstte açılan onay penceresi de kendi tuşlarını alır.
 */
export function useWorkDialogActive(): boolean {
  return useContext(ActiveContext);
}

/**
 * Büyük iş penceresi: bir çalışma yüzeyini (ray, paneller, tuval) bulunduğu ekranın üstünde, kenarlardan biraz içeride
 * açar. Tarayıcının modal `<dialog>`'u (arka plan etkisiz, Tab pencerede döner); bildirimler, açılır kutular ve onaylar
 * pencerenin içinde görünür. Açılınca odak `data-autofocus` öğesine ya da gövdedeki ilk öğeye (içerik kendisi odak
 * verirse o kalır), kapanınca açan öğeye döner. İçerik ekran yerleşiminden bağımsızdır (çekmece ve sütun kuralı yok).
 */
export function WorkDialog({ title, subtitle, onRequestClose, footer, children }: WorkDialogProps) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const close = useRef(onRequestClose);
  close.current = onRequestClose;
  const requestClose = useCallback(() => close.current(), []);
  const top = useTopDialog();
  const [el, setEl] = useState<HTMLDialogElement | null>(null);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      if (typeof d.showModal === "function") d.showModal();
      if (!d.hasAttribute("open")) d.setAttribute("open", "");
    }
    setEl(d);
    const target = d.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(d.querySelector(".tz-wd-b") ?? d)[0] ?? focusables(d)[0];
    target?.focus({ preventScroll: true });
    const drop = pushDialog(d);
    return () => {
      drop();
      if (d.open && typeof d.close === "function") d.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    const d = e.currentTarget;
    const list = focusables(d);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const at = document.activeElement;
    const outside = !at || !d.contains(at) || at === d;
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
      className="tz-wd"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="tz-wd-h">
        <h2 id={titleId}>{title}</h2>
        {subtitle && <span className="tz-wd-sub">{subtitle}</span>}
        <span className="tz-sp" />
        <IconButton icon="x" label={t("actions.close")} size={32} onClick={requestClose} />
      </div>
      <ActiveContext.Provider value={!!el && top === el}>
        <ScreenLayoutContext.Provider value={null}>
          <div className="tz-wd-b">{children}</div>
        </ScreenLayoutContext.Provider>
      </ActiveContext.Provider>
      {footer && <WorkDialogFooter>{footer}</WorkDialogFooter>}
    </dialog>
  );
}

/** Pencerenin alt şeridi (solda durum notu, sağa yaslı düğmeler için araya `<span className="tz-sp" />`). */
export function WorkDialogFooter({ children }: { children: ReactNode }) {
  return <div className="tz-wd-f">{children}</div>;
}
