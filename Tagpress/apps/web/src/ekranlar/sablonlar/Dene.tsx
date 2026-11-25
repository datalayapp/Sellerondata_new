import { API, type TemplatePatch, type TemplateTryRequest, type TemplateTryResponse } from "@tagpress/domain";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";
import { issueText, serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { isUnsupported } from "./mantik/endpoints.ts";
import { Button, CanvasDock, IconButton, IssueBox, TextArea } from "../../tezgah/index.ts";
import { unsupportedText } from "./metin.ts";

/** Örnek metnin yerel kaydı (eski düzenleyiciyle aynı anahtar). */
const SAMPLE_KEY = "studio.sablon.ornek";

function loadSample(): string {
  try {
    return localStorage.getItem(SAMPLE_KEY) || i18n.t("templates:try.defaultSample");
  } catch {
    return i18n.t("templates:try.defaultSample");
  }
}

/**
 * "Bu şablonla dene" (tuvalin altında yüzen kutu): örnek metinle motor önizlemesi; yapay zekâ yok, ücretsiz.
 * Kaydedilmemiş değişiklik varsa kayıtlı hâl ile değişiklikli hâl yan yana (değişiklik kaydedilmeden geçici uygulanır).
 */
export function Dene({ languageId, templateKey, patch }: { languageId: string; templateKey: string; patch: TemplatePatch }) {
  const { t } = useTranslation("templates");
  const [text, setText] = useState(loadSample);
  const [shown, setShown] = useState(true);
  const dirty = Object.keys(patch).length > 0;
  const url = path(API.templateTry, { lang: languageId, key: templateKey });

  const run = useMutation({
    mutationFn: async () => {
      const saved = await api.post<TemplateTryResponse>(url, { text } satisfies TemplateTryRequest);
      const draft = dirty ? await api.post<TemplateTryResponse>(url, { text, patch } satisfies TemplateTryRequest) : null;
      return { saved, draft };
    },
    onSuccess: () => setShown(true),
  });

  const go = () => {
    try {
      localStorage.setItem(SAMPLE_KEY, text);
    } catch {
      /* gizli pencere */
    }
    run.mutate();
  };

  return (
    <CanvasDock>
      {shown && (run.data || run.isError) && (
        <div className="sb-try-out">
          {run.isError &&
            (isUnsupported(run.error) ? (
              <IssueBox tone="info">
                <b>{t("try.missing")}</b> {unsupportedText()}
              </IssueBox>
            ) : (
              <IssueBox tone="error">
                <b>{t("try.failed")}</b> {serverText(run.error)}
              </IssueBox>
            ))}
          {run.data && (
            <div className="sb-try-res">
              <Sonuc label={run.data.draft ? t("try.saved") : t("try.result")} res={run.data.saved} />
              {run.data.draft && <Sonuc label={t("try.draft")} res={run.data.draft} />}
            </div>
          )}
          <IconButton icon="x" size={26} label={t("try.close")} onClick={() => setShown(false)} />
        </div>
      )}
      <div className="sb-try">
        <div className="sb-try-box">
          <TextArea autoGrow className="sb-try-ta" value={text} onChange={setText} aria-label={t("try.sample")} placeholder={t("try.placeholder")} />
          <span className="sb-try-free">{t("try.free")}</span>
        </div>
        <Button loading={run.isPending} disabled={!text.trim()} onClick={go}>
          {dirty ? t("try.beforeAfter") : t("try.run")}
        </Button>
      </div>
    </CanvasDock>
  );
}

function Sonuc({ label, res }: { label: string; res: TemplateTryResponse }) {
  const { t } = useTranslation("templates");
  const src = res.png.startsWith("data:") ? res.png : `data:image/png;base64,${res.png}`;
  return (
    <figure className="sb-try-fig">
      <img src={src} alt={t("try.alt", { label })} />
      <figcaption>
        {label}
        {res.basePt ? <span className="tz-mono"> · {t("try.pt", { n: formatNumber(res.basePt, { maximumFractionDigits: 1 }) })}</span> : null}
      </figcaption>
      {res.issues?.length > 0 && (
        <ul className="sb-try-iss">
          {res.issues.map((i, n) => (
            <li key={n}>{issueText(i)}</li>
          ))}
        </ul>
      )}
    </figure>
  );
}
