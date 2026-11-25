import { API } from "@tagpress/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { path, withQuery } from "../../lib/api.ts";

/**
 * Font örneği: fontun kendi yazısıyla bir satır (beyaz kâğıtta). Önce tasarım dilinin klasörü, olmazsa ortak yedek
 * fontlar denenir. Sunucuda yazı motoru bağlı değilse (501) sessizce "örnek yok" der.
 */
export function Yazi({ languageId, file, text, height = 40, className }: { languageId: string; file: string | null | undefined; text: string; height?: number; className?: string }) {
  const { t } = useTranslation("designLanguage");
  const [scope, setScope] = useState<"language" | "shared">("language");
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  useEffect(() => {
    setScope("language");
    setState("loading");
  }, [languageId, file, text]);
  const style = { height, minWidth: 96 };
  if (!file || state === "failed") {
    return (
      <span className={`td-yazi is-yok ${className ?? ""}`} style={style}>
        {file ? t("specimen.none") : t("specimen.noFile")}
      </span>
    );
  }
  const src = withQuery(path(API.fontSpecimen, { lang: languageId, file }), { scope, text });
  return (
    <span className={`td-yazi ${className ?? ""}`} style={style}>
      <img
        key={src}
        src={src}
        alt={t("specimen.alt", { file, text })}
        draggable={false}
        onLoad={() => setState("ok")}
        onError={() => (scope === "language" ? setScope("shared") : setState("failed"))}
      />
    </span>
  );
}
