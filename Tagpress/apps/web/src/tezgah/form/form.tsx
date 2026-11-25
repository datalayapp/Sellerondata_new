import {
  Children,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../cx.ts";
import { Kbd } from "../dugme/Button.tsx";
import { arrowTarget } from "../dugme/gezin.ts";
import { Icon } from "../ikon/Icon.tsx";
import type { CommandId } from "../kisayol/kayit.ts";
import "./form.css";

/** Alanlar 30 px, köşe 6 (maket .fi). Değer denetimli: `value` + `onChange(yeniDeğer)`. */
type InputBase = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size">;

export interface TextFieldProps extends InputBase {
  value: string;
  onChange(v: string): void;
  invalid?: boolean;
  /** Sağda birim ("mm", "pt"). */
  unit?: string;
  /** Alanın içinde, solda (maket `.dock .fi`: mor kıvılcım ikonu). Süstür; adı `aria-label`'da olmalı. */
  leading?: ReactNode;
  /** Alanın içinde, sağ uçta (kısayol rozeti, "ücretsiz" gibi soluk not). Birimden sonra gelir. */
  trailing?: ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}

export function TextField({ value, onChange, invalid, unit, leading, trailing, className, ...rest }: TextFieldProps) {
  return (
    <span className={cx("tz-fi", invalid && "is-invalid", className)}>
      {leading && <span className="tz-fi-ld">{leading}</span>}
      <input className="tz-fi-in" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} {...rest} />
      {unit && <span className="tz-fi-u">{unit}</span>}
      {trailing && <span className="tz-fi-tr">{trailing}</span>}
    </span>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onChange(v: string): void;
  invalid?: boolean;
  /** İçeriğe göre uzar. */
  autoGrow?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function TextArea({ value, onChange, invalid, autoGrow, className, ref, ...rest }: TextAreaProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = own.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, autoGrow]);
  return (
    <textarea
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
      }}
      className={cx("tz-fi", "tz-fi--ta", autoGrow && "tz-fi--grow", invalid && "is-invalid", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      rows={autoGrow ? 1 : rest.rows}
      {...rest}
    />
  );
}

export interface SearchFieldProps extends InputBase {
  value: string;
  onChange(v: string): void;
  /** Odak kısayolu (rozet olarak görünür; odaklamayı ekran `useCommands` ile yapar). */
  command?: CommandId;
  ref?: React.Ref<HTMLInputElement>;
}

export function SearchField({ value, onChange, command, className, ...rest }: SearchFieldProps) {
  return (
    <span className={cx("tz-fi", "tz-fi--search", className)}>
      <Icon name="search" size={15} className="tz-fi-ic" />
      <input type="search" className="tz-fi-in" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
      {command && !value && <Kbd command={command} />}
    </span>
  );
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  value: T;
  options: { value: NoInfer<T>; label: string }[];
  onChange(v: NoInfer<T>): void;
  /** Hatalı değer (kırmızı çerçeve, `aria-invalid`); `Field` `error` verilince kendiliğinden. */
  invalid?: boolean;
  ref?: React.Ref<HTMLSelectElement>;
}

export function Select<T extends string>({ value, options, onChange, invalid, className, ...rest }: SelectProps<T>) {
  return (
    <span className={cx("tz-fi", "tz-fi--sel", invalid && "is-invalid", className)}>
      <select className="tz-fi-in" value={value} onChange={(e) => onChange(e.target.value as T)} aria-invalid={invalid || undefined} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export interface NumberStepperProps {
  value: number;
  step: number;
  min?: number;
  max?: number;
  /** Görünen değer ("3,8 cm", "12 pt"). */
  format(v: number): string;
  onChange(v: number): void;
  /** Erişilebilir ad (düğmeler "−" ve "+" ile birlikte okunur). */
  "aria-label"?: string;
  decreaseLabel?: string;
  increaseLabel?: string;
  disabled?: boolean;
  /**
   * Değer elle yazılabilir (büyük kopya sayıları gibi): Enter ya da odak kaybında uygulanır, sınıra çekilir;
   * geçersiz yazıda eski değere döner, Esc vazgeçer. ↑ ↓ (PageUp, PageDown) yine adım atar.
   */
  editable?: boolean;
  /** Yazıyı sayıya çevirir (varsayılan: "1.250", "3,8", "12 pt" gibi biçimleri okur); okunamazsa null. */
  parse?(text: string): number | null;
}

/** Varsayılan okuma: boşluk ve birim atılır; hem nokta hem virgül varsa nokta binlik ayırıcıdır, tek virgül ondalık. */
export function parseNumberText(text: string): number | null {
  let t = text.trim().replace(/\s+/g, "").replace(/[^\d.,+-]/g, "");
  if (!t) return null;
  if (t.includes(".") && t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function NumberStepper({ value, step, min = -Infinity, max = Infinity, format, onChange, disabled, editable, parse = parseNumberText, ...p }: NumberStepperProps) {
  const { t } = useTranslation("frame");
  const [draft, setDraft] = useState<string | null>(null);
  const set = (v: number) => onChange(Math.max(min, Math.min(max, Math.round(v * 1000) / 1000)));
  const commit = () => {
    if (draft === null) return;
    const n = parse(draft);
    setDraft(null);
    if (n !== null && n !== value) set(n);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    // Yazı alanında ← → ve Home/End imleci taşır; adım ↑ ↓ ve sayfa tuşlarıyla.
    const typing = editable;
    if (e.key === "ArrowUp" || (!typing && e.key === "ArrowRight")) {
      e.preventDefault();
      setDraft(null);
      set(value + step);
    } else if (e.key === "ArrowDown" || (!typing && e.key === "ArrowLeft")) {
      e.preventDefault();
      setDraft(null);
      set(value - step);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      set(value + step * 10);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      set(value - step * 10);
    } else if (!typing && e.key === "Home" && Number.isFinite(min)) {
      e.preventDefault();
      set(min);
    } else if (!typing && e.key === "End" && Number.isFinite(max)) {
      e.preventDefault();
      set(max);
    } else if (typing && e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (typing && e.key === "Escape" && draft !== null) {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
    }
  };
  const spin = {
    role: "spinbutton",
    "aria-label": p["aria-label"],
    "aria-valuenow": value,
    "aria-valuemin": Number.isFinite(min) ? min : undefined,
    "aria-valuemax": Number.isFinite(max) ? max : undefined,
    "aria-valuetext": format(value),
    "aria-disabled": disabled || undefined,
    onKeyDown: onKey,
  } as const;
  return (
    <span className={cx("tz-st", editable && "is-edit")} {...(editable ? {} : { ...spin, tabIndex: disabled ? -1 : 0 })}>
      <button type="button" tabIndex={-1} aria-label={p.decreaseLabel ?? t("form.decrease")} disabled={disabled || value <= min} onClick={() => set(value - step)}>
        <Icon name="minus" size={15} />
      </button>
      {editable ? (
        <input
          {...spin}
          className="tz-st-in tz-mono"
          inputMode="decimal"
          disabled={disabled}
          value={draft ?? format(value)}
          onFocus={(e) => {
            setDraft(String(value));
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <b className="tz-mono">{format(value)}</b>
      )}
      <button type="button" tabIndex={-1} aria-label={p.increaseLabel ?? t("form.increase")} disabled={disabled || value >= max} onClick={() => set(value + step)}>
        <Icon name="plus" size={15} />
      </button>
    </span>
  );
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: { value: NoInfer<T>; label: string }[];
  onChange(v: NoInfer<T>): void;
  "aria-label"?: string;
  /** Görünür etiketin kimliği (`Field` kendiliğinden verir). */
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  id?: string;
}

/** Tek seçimli düğme grubu (radyo); oklarla gezilir, odak ve seçim birlikte gider. */
export function Segmented<T extends string>({ value, options, onChange, ...p }: SegmentedProps<T>) {
  return (
    <span
      className="tz-seg"
      role="radiogroup"
      id={p.id}
      aria-label={p["aria-label"]}
      aria-labelledby={p["aria-labelledby"]}
      aria-describedby={p["aria-describedby"]}
      onKeyDown={(e) => {
        const to = arrowTarget(e, "[role=radio]", "both");
        if (!to) return;
        to.items[to.index]?.focus();
        const next = options[to.index];
        if (next) onChange(next.value);
      }}
    >
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} className={cx(o.value === value && "is-on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange(v: boolean): void;
  /** Erişilebilir ad (görünür etiket varsa `aria-labelledby` önce gelir). */
  label: string;
  disabled?: boolean;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** `label` anahtarın sağında görünür yazı olarak da çizilir (13 px; yazıya tıklamak anahtarı çevirir). */
  showLabel?: boolean;
}

export function Switch({ checked, onChange, label, disabled, id, showLabel, ...a }: SwitchProps) {
  const autoId = useId();
  const swId = id ?? (showLabel ? autoId : undefined);
  const sw = (
    <button
      type="button"
      role="switch"
      id={swId}
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={a["aria-labelledby"]}
      aria-describedby={a["aria-describedby"]}
      disabled={disabled}
      className={cx("tz-sw", checked && "is-on")}
      onClick={() => onChange(!checked)}
    />
  );
  if (!showLabel) return sw;
  return (
    <span className={cx("tz-swl", disabled && "is-off")}>
      {sw}
      <label htmlFor={swId}>{label}</label>
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  id,
  ...a
}: {
  checked: boolean | "mixed";
  onChange(v: boolean): void;
  label: string;
  disabled?: boolean;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={a["aria-labelledby"]}
      aria-describedby={a["aria-describedby"]}
      disabled={disabled}
      className={cx("tz-cbx", checked === true && "is-on", checked === "mixed" && "is-mixed")}
      onClick={() => onChange(checked !== true)}
    >
      {checked === true && <Icon name="check" size={12} />}
      {checked === "mixed" && <Icon name="minus" size={12} />}
    </button>
  );
}

/** Üstte etiketli alan (Ayarlar, pencereler). Tek çocuk denetime `id` ve `aria-describedby` verilir. */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-h`;
  const errId = `${id}-e`;
  const described = [hint && hintId, error && errId].filter(Boolean).join(" ") || undefined;
  const labelId = `${id}-l`;
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  // `invalid` yalnız metin alanlarına ve seçime gider (diğer denetimlere ve DOM öğelerine verilirse bilinmeyen öznitelik olur).
  const takesInvalid = only !== null && (only.type === TextField || only.type === TextArea || only.type === Select);
  // Düğme biçimli denetimler (anahtar, segment, onay kutusu) etiketi `aria-labelledby` ile alır; segment `<label for>` ile bağlanamaz.
  const byLabel = only !== null && (only.type === Switch || only.type === Segmented || only.type === Checkbox);
  const labelable = only !== null && only.type !== Segmented;
  const controlId = only ? ((only.props.id as string | undefined) ?? id) : undefined;
  const control = only
    ? cloneElement(only, {
        id: controlId,
        "aria-describedby": described,
        ...(byLabel ? { "aria-labelledby": (only.props["aria-labelledby"] as string | undefined) ?? labelId } : {}),
        ...(takesInvalid ? { invalid: only.props.invalid ?? (error ? true : undefined) } : {}),
      })
    : children;
  return (
    <div className={cx("tz-field", error && "is-invalid")}>
      <label className="tz-field-l" id={labelId} htmlFor={labelable ? controlId : undefined}>
        {label}
      </label>
      {control}
      {hint && !error && (
        <p className="tz-field-h" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="tz-field-e" id={errId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
