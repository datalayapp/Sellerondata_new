import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type AccessNeed, useCan } from "../../lib/access.ts";
import { isPlatform } from "../../lib/platform.ts";
import { cx } from "../cx.ts";
import { Icon, type IconName } from "../ikon/Icon.tsx";
import { Tooltip } from "../katman/Popover.tsx";
import { type CommandId, formatKeys, useCommand } from "../kisayol/kayit.ts";
import "./dugme.css";

/** Kayıt yazımı mı ("mod+enter", "shift+n")? Düz görünen metin ("Enter", "Ctrl S") değildir. */
const SPEC = /^((mod|ctrl|shift|alt)\+)+.+$/;

/**
 * Kısayol rozeti. `command` verilirse tuşu kayıttan; `combo` ile kayıt yazımında ("mod+enter" → Windows "Ctrl Enter",
 * Mac "⌘ Enter"; dizi "a / b" olarak); `keys` ile görünen metin ("Enter"; kayıt yazımı verilirse o da biçimlenir).
 * `on`: zemin (birincil düğme, bant).
 */
export function Kbd({ command, keys, combo, on }: { command?: CommandId; keys?: string; combo?: string | string[]; on?: "primary" | "band" }) {
  const c = useCommand(command ?? "");
  const { t } = useTranslation();
  const fmt = (k: string | string[]) => formatKeys(Array.isArray(k) ? k : [k], (x) => t(x));
  const text = combo !== undefined ? fmt(combo) : keys !== undefined ? (SPEC.test(keys) ? fmt(keys) : keys) : command ? c.keysText : "";
  if (!text) return null;
  return (
    <kbd className={cx("tz-kbd", on && `tz-kbd--${on}`)} aria-hidden="true">
      {text}
    </kbd>
  );
}

/**
 * `link`: bağlantı görünümlü düğme (maket `.lnk`): yalnız mor yazı, 12 px, zemin, çerçeve ve sabit yükseklik yok;
 * basılı (`aria-pressed`) hâlde de aynı görünür. Panel başlığındaki ya da satır altındaki nadir eylemler içindir
 * ("Bütün yazı", "Alan merkezine döndür", "Noktalarla düzenle"); `size` yok sayılır.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "link";
export type ButtonSize = "mini" | "tool" | "page" | "guided";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** mini 28 px, tool 32 px (varsayılan), page 40 px, guided 48 px. */
  size?: ButtonSize;
  icon?: IconName;
  /** Kısayol kaydındaki komut: adı (çocuk yoksa), ipucu ("Onayla · 2") ve `aria-keyshortcuts` oradan. */
  command?: CommandId;
  /** Rozet: varsayılan komutun `badge` işareti; `false` gizler, `true` rozetsiz komutta da gösterir. */
  kbd?: boolean;
  wide?: boolean;
  loading?: boolean;
  /** Sağda ⌄ (açılır seçim/menü düğmesi). */
  chevron?: boolean;
  /**
   * Eylemin gerektirdiği yetki (`lib/access.ts`): yoksa düğme pasif, ipucu "Bu işlem için yetkiniz yok". Yerel kipte
   * yetki hep tamdır. Asıl denetim sunucudadır (403 `FORBIDDEN`).
   */
  need?: AccessNeed;
  ref?: React.Ref<HTMLButtonElement>;
  children?: ReactNode;
}

/** Yetkisi yoksa pasif ve neden ipucunda (`need` verilen düğmeler; kanca yalnız bunlarda çağrılır). */
export function NeedGate({ need, children }: { need: AccessNeed; children: (denied: string | null) => ReactNode }) {
  const ok = useCan(need);
  const { t } = useTranslation("session");
  return <>{children(ok ? null : t("access.denied"))}</>;
}

/**
 * Düğme. İpucu tarayıcının `title`'ı değil, `Tooltip`: `command` verilirse ad + kısayol ("Onayla · 2"), `title`
 * verilirse o metin (komutla birlikte: metin + kısayol). Klavye odağında ve pasif düğmede de görünür.
 */
export function Button({ need, ...props }: ButtonProps) {
  // Yerel kipte yetki hep tam: kanca hiç çağrılmaz (sağlayıcısız testler ve yerel ekranlar aynen).
  if (!need || !isPlatform()) return <PlainButton {...props} />;
  return <NeedGate need={need}>{(denied) => <PlainButton {...props} disabled={props.disabled || !!denied} title={denied ?? props.title} />}</NeedGate>;
}

function PlainButton({ variant = "secondary", size = "tool", icon, command, kbd, wide, loading, chevron, className, children, disabled, title, type, ...rest }: ButtonProps) {
  const c = useCommand(command ?? "");
  const showKbd = command ? (kbd ?? c.showBadge) : false;
  const tip = typeof title === "string" && title ? title : undefined;
  const button = (
    <button
      type={type ?? "button"}
      className={cx("tz-btn", `tz-btn--${variant}`, `tz-btn--${size}`, wide && "tz-btn--wide", loading && "is-loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-keyshortcuts={command ? c.ariaKeyShortcuts || undefined : undefined}
      {...rest}
    >
      {loading ? <span className="tz-btn-spin" aria-hidden="true" /> : icon && <Icon name={icon} size={size === "page" || size === "guided" ? 18 : 15} />}
      {children ?? (command ? c.label : null)}
      {showKbd && <Kbd command={command} on={variant === "primary" ? "primary" : undefined} />}
      {chevron && <Icon name="chev" size={12} className="tz-btn-chev" />}
    </button>
  );
  if (!command && !tip) return button;
  return (
    <Tooltip command={command} content={tip}>
      {button}
    </Tooltip>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** Görünür değil; düğmenin adı. `label` ya da `command` zorunlu. */
  label?: string;
  command?: CommandId;
  size?: 26 | 28 | 32;
  pressed?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/** İkon düğmesi. Ad `aria-label`'da; ipucu (`Tooltip`) ad + kısayol, `title` verilirse o metin. */
export function IconButton({ icon, label, command, size = 32, pressed, className, title, type, ...rest }: IconButtonProps) {
  const c = useCommand(command ?? "");
  const name = label ?? (command ? c.label : "");
  const tip = typeof title === "string" && title ? title : label;
  return (
    <Tooltip command={command} content={tip}>
      <button
      type={type ?? "button"}
      className={cx("tz-ib", `tz-ib--${size}`, pressed && "is-on", className)}
      aria-label={name}
      aria-pressed={pressed}
      aria-keyshortcuts={command ? c.ariaKeyShortcuts || undefined : undefined}
      {...rest}
    >
      <Icon name={icon} size={size === 32 ? 18 : 15} />
      </button>
    </Tooltip>
  );
}
