import { createContext, type ReactNode, useContext } from "react";

/**
 * Bildirim (toast) ve onay penceresi bağlamları: nötr dosya. Tezgâh sağlayıcıları (`tezgah/katman`) doldurur;
 * `useToast` / `useConfirm` kullanan veri katmanı (`ekranlar/uretim/mantik/data.ts`,
 * `ekranlar/baski/mantik/useSessionEditor.ts` gibi) arayüz bileşenlerine bağlanmadan bunu kullanır.
 */
export interface ToastInput {
  message: ReactNode;
  tone?: "default" | "error" | "success";
  /** "Geri al" gibi tek eylem. */
  action?: { label: string; run: () => void | Promise<void> };
  /** ms; varsayılan 6000, eylemli bildirimde 10000. */
  duration?: number;
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "default" | "danger";
}

export type ToastFn = (t: ToastInput) => void;
export type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

export const ToastContext = createContext<ToastFn>(() => {});
export const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
