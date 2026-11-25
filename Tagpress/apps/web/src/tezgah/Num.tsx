import { Children, type ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Num.css";

/**
 * Sayı metni (Tezgâh). `.tz-num` (tabular-nums) noktalamayı da rakam genişliğinde basıp "3 . 8", "01 : 11" gibi aralık
 * bırakabilir; bu yardımcı yalnızca `. , : /` karakterlerini normal genişliğe döndürür, rakamlar tablo hizalı kalır.
 * Metin (ya da sayı) çocuklarını böler; eleman çocuklar olduğu gibi geçer.
 */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("tz-num", className)}>{Children.map(children, (c, i) => (typeof c === "string" || typeof c === "number" ? <Split key={i} text={String(c)} /> : c))}</span>;
}

function Split({ text }: { text: string }) {
  return (
    <>
      {text.split(/([.,:/]+)/).map((p, i) =>
        i % 2 ? (
          <span key={i} className="tz-nn">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
