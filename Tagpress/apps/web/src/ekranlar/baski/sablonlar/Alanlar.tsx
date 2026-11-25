import { useState } from "react";
import { formatMm } from "../../../i18n/bicim.ts";
import { HEX_PARTIAL, parseMmText, pickerColor } from "../mantik/sablon/editor.ts";
import { TextField } from "../../../tezgah/index.ts";

/**
 * Ölçü alanı (mm, °, pt): değer elle yazılır, geçerli her yazımda hemen uygulanır (Ctrl S yazarken de güncel değeri
 * kaydeder); odak çıkınca biçimli değer görünür. Çoklu seçimde ortak değer yoksa `value` null ve yer tutucu
 * ("karışık"). `accept` false dönen değer uygulanmaz (ör. sıfır çap).
 */
export function OlcuAlani({
  label,
  value,
  onChange,
  unit = "mm",
  digits = 2,
  accept,
  placeholder,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange(v: number): void;
  unit?: string;
  digits?: number;
  accept?(v: number): boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === null ? "" : formatMm(value, digits));
  return (
    <TextField
      className="bs-num tz-mono"
      value={shown}
      unit={unit}
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={() => setText(value === null ? "" : formatMm(value, digits))}
      onChange={(v) => {
        setText(v);
        const n = parseMmText(v);
        if (n !== null && n !== value && (accept?.(n) ?? true)) onChange(n);
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape" && text !== null) {
          e.stopPropagation();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Renk: tarayıcının renk seçicisi ve hex yazımı ("#E0218A"). */
export function RenkAlani({ label, pickerLabel, value, onChange }: { label: string; pickerLabel: string; value: string; onChange(v: string): void }) {
  return (
    <span className="bs-color">
      <input type="color" className="bs-swatch" aria-label={pickerLabel} value={pickerColor(value)} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <TextField className="tz-mono" value={value} aria-label={label} onChange={(v) => HEX_PARTIAL.test(v) && onChange(v.toUpperCase())} />
    </span>
  );
}
