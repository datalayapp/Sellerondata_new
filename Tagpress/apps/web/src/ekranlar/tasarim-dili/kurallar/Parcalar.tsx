import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../../i18n/index.ts";
import { Button, Checkbox, IconButton, NumberStepper, TextArea, TextField } from "../../../tezgah/index.ts";
import { num } from "../dil.ts";

/** Kural formunun küçük ortak parçaları (Tezgâh bileşenlerinin üstüne; kendi CSS'i `kurallar.css`). */

export interface Hata {
  path: string;
  message: string;
}

/** Alan altında yerinde hata iletileri (yol küçük yazıyla). */
export function Hatalar({ errors }: { errors: Hata[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="td-hata" role="alert">
      {errors.map((e) => (
        <li key={e.path}>
          {e.message} <code>{e.path}</code>
        </li>
      ))}
    </ul>
  );
}

/** Etiketli onay kutusu (etiket tıklanınca da değişir). */
export function Onay({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="td-onay">
      <Checkbox checked={checked} onChange={onChange} label={label} />
      <span>{label}</span>
    </span>
  );
}

/** Sayı adımlayıcı; görünen metin birimle ("12 pt", "%97"). */
export function Sayi({ value, step, min, max, unit, label, onChange }: { value: number; step: number; min?: number; max?: number; unit?: string; label: string; onChange: (v: number) => void }) {
  return <NumberStepper value={value} step={step} min={min} max={max} aria-label={label} format={(v) => (unit ? `${num(v, 3)} ${unit}` : num(v, 3))} onChange={onChange} />;
}

/** Boş olabilen sayı: boşken "Sınır yok" düğmesi, doluyken adımlayıcı ve kaldırma. */
export function IsteBagliSayi({ value, step, min, max, unit, label, emptyLabel, setLabel, clearLabel, initial, onChange }: {
  value: number | null;
  step: number;
  min?: number;
  max?: number;
  unit?: string;
  label: string;
  emptyLabel: string;
  setLabel: string;
  clearLabel: string;
  initial: number;
  onChange: (v: number | null) => void;
}) {
  if (value === null) {
    return (
      <span className="td-istebagli">
        <span className="td-soluk">{emptyLabel}</span>
        <Button size="mini" icon="plus" onClick={() => onChange(initial)}>
          {setLabel}
        </Button>
      </span>
    );
  }
  return (
    <span className="td-istebagli">
      <Sayi value={value} step={step} min={min} max={max} unit={unit} label={label} onChange={onChange} />
      <IconButton icon="x" size={26} label={clearLabel} onClick={() => onChange(null)} />
    </span>
  );
}

/** Kelime çipleri: Enter ya da virgülle eklenir; her çipin kaldırma düğmesi var. */
export function Cipler({ value, onChange, label, placeholder }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder: string }) {
  const { t } = useTranslation("designLanguage");
  const [text, setText] = useState("");
  const add = () => {
    const parts = text
      .split(",")
      .map((s) => s.trim().toLocaleLowerCase(currentLocale()))
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
  };
  return (
    <div className="td-cipler">
      {value.length > 0 && (
        <ul aria-label={label}>
          {value.map((v) => (
            <li key={v}>
              <span>{v}</span>
              <IconButton icon="x" size={26} label={t("editors.chips.remove", { item: v })} onClick={() => onChange(value.filter((x) => x !== v))} />
            </li>
          ))}
        </ul>
      )}
      <TextField
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={setText}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

/** Satır satır yazılan metin; yazarken boş satırı kaybetmemek için ham metni yerelde tutar. */
export function SatirAlani({ lines, onChange, label, placeholder, rows = 3 }: { lines: string[]; onChange: (l: string[]) => void; label: string; placeholder?: string; rows?: number }) {
  const toLines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const [text, setText] = useState(lines.join("\n"));
  useEffect(() => {
    if (JSON.stringify(toLines(text)) !== JSON.stringify(lines)) setText(lines.join("\n"));
    // yalnız dışarıdan değişince eşitle; yazarken ham metin korunur
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız dışarıdan gelen satırlar değişince eşitlenir; text eklenirse yazarken ham metin ezilir
  }, [lines]);
  return (
    <TextArea
      value={text}
      aria-label={label}
      rows={rows}
      placeholder={placeholder}
      onChange={(v) => {
        setText(v);
        onChange(toLines(v));
      }}
    />
  );
}

/** Başlıklı küçük kutu (liste öğesi). */
export function Kutu({ children, kapali }: { children: ReactNode; kapali?: boolean }) {
  return <li className={`td-kutu${kapali ? " is-kapali" : ""}`}>{children}</li>;
}
