import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Icon, IssueBox, StatusDot, TextArea } from "../../tezgah/index.ts";
import type { Phase } from "./useMasa.ts";

/** Dosya yokken, okunurken ya da açılamadığında: bırakma alanı, dosya seç, metni yapıştır. */
export function Karsilama({
  phase,
  onChooseFile,
  onPaste,
  onRetry,
  canRetry,
}: {
  phase: Exclude<Phase, { kind: "ready" }>;
  onChooseFile(): void;
  onPaste(text: string): void;
  onRetry(): void;
  canRetry: boolean;
}) {
  const { t } = useTranslation("importDesk");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState("");

  if (phase.kind === "loading") {
    return (
      <div className="ia-intake" role="status">
        <StatusDot tone="busy" label={t("intake.loading", { name: phase.fileName })} />
      </div>
    );
  }

  return (
    <div className="ia-intake">
      <div className="ia-intake-c">
        {phase.kind === "error" && (
          <IssueBox
            tone="error"
            fixes={
              canRetry ? (
                <Button size="mini" onClick={onRetry}>
                  {t("intake.retry")}
                </Button>
              ) : undefined
            }
          >
            <b>{t("intake.errorTitle")}</b> {phase.message}
          </IssueBox>
        )}
        <div className="ia-drop">
          <Icon name="file" />
          <p className="ia-drop-t">{t("intake.title")}</p>
          <p className="ia-drop-b">{t("intake.body")}</p>
          <div className="ia-drop-a">
            {/* Açıklama ipucunda (kural: açıklama metni yok). */}
            <Button variant={pasteOpen ? "secondary" : "primary"} size="page" icon="up" title={t("intake.bodyHint")} onClick={onChooseFile}>
              {t("intake.chooseFile")}
            </Button>
            <Button size="page" icon="clip" aria-expanded={pasteOpen} onClick={() => setPasteOpen(!pasteOpen)}>
              {t("intake.paste")}
            </Button>
          </div>
          {pasteOpen && (
            <div className="ia-paste">
              <TextArea autoFocus rows={6} value={text} onChange={setText} placeholder={t("intake.pastePlaceholder")} aria-label={t("intake.pasteLabel")} className="tz-mono" />
              <Button need="edit" variant="primary" disabled={!text.trim()} onClick={() => onPaste(text)}>
                {t("intake.preview")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
