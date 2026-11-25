import type { Sample, SamplePatch } from "@tagpress/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TemplatePicker } from "../../ortak/index.ts";
import { Button, Dialog, Field, IssueBox, Switch, TextField, useConfirm } from "../../tezgah/index.ts";

/**
 * Örnek ayrıntısı: görsel, ölçüm durumu, şablon ve satır metinleri (kullanıcının düzeltmesi cevap sayılır), dışarıda
 * bırakma ve silme. Satır metni yalnız kullanıcı yazınca değişir; boş satır gönderilmez.
 */
export function OrnekPenceresi({
  sample,
  lang,
  editable,
  onClose,
  onPatch,
  onDelete,
}: {
  sample: Sample;
  lang: string;
  editable: boolean;
  onClose: () => void;
  onPatch: (p: SamplePatch) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const { t } = useTranslation("builder");
  const confirm = useConfirm();
  const [tpl, setTpl] = useState<string | null>(sample.templateKey);
  const [lines, setLines] = useState<string[]>(() => sample.lines.map((l) => l.text ?? ""));
  const [busy, setBusy] = useState(false);
  const origLines = sample.lines.map((l) => l.text ?? "");
  const linesChanged = lines.length !== origLines.length || lines.some((v, i) => v !== origLines[i]);
  const dirty = tpl !== sample.templateKey || linesChanged;

  const save = async () => {
    const patch: SamplePatch = {};
    if (tpl !== sample.templateKey) patch.templateKey = tpl;
    if (linesChanged) patch.lines = lines.map((text) => ({ text }));
    if (Object.keys(patch).length === 0) return onClose();
    setBusy(true);
    const ok = await onPatch(patch);
    setBusy(false);
    if (ok) onClose();
  };
  const remove = async () => {
    const ok = await confirm({ title: t("sample.deleteTitle"), body: t("sample.deleteBody", { name: sample.name }), confirmLabel: t("sample.delete"), tone: "danger" });
    if (!ok) return;
    setBusy(true);
    const done = await onDelete();
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Dialog
      title={sample.name}
      size="lg"
      dirty={dirty}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {editable && (
            <Button variant="danger" icon="trash" disabled={busy} onClick={() => void remove()}>
              {t("sample.delete")}
            </Button>
          )}
          <span className="ol-sp" />
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          {editable && (
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
              {t("sample.save")}
            </Button>
          )}
        </>
      }
    >
      <div className="ol-pencere">
        <img className="ol-pencere-gorsel" src={`${sample.imageUrl}?w=600`} alt={t("sample.imageAlt", { name: sample.name })} />
        <div className="ol-pencere-sag">
          <p className="ol-mut">
            {sample.excluded ? t("sample.excluded") : t(`sample.status.${sample.status}`)}
            {sample.quality && ` · ${t(`sample.quality.${sample.quality}`)}`}
            {sample.approx && ` · ${t("sample.approx")}`}
            {sample.split === "test" && ` · ${t("sample.holdout")}`}
          </p>
          {sample.error && <IssueBox tone="warn">{t(`sample.error.${sample.error.code}`, { defaultValue: t("sample.errorUnknown") })}</IssueBox>}
          <Field label={t("sample.template")}>
            <TemplatePicker
              languageId={lang}
              value={tpl}
              onChange={setTpl}
              allowClear
              trigger={(p) => (
                <Button {...p} icon="tag" chevron disabled={!editable}>
                  {tpl ?? t("sample.noTemplate")}
                </Button>
              )}
            />
          </Field>
          <fieldset className="ol-satirlar" disabled={!editable}>
            <legend>{t("sample.lines")}</legend>
            {lines.length === 0 && <p className="ol-not">{t("sample.noLines")}</p>}
            {lines.map((v, i) => (
              <TextField key={i} value={v} maxLength={500} aria-label={t("sample.line", { n: i + 1 })} onChange={(x) => setLines((ls) => ls.map((old, j) => (j === i ? x : old)))} />
            ))}
            <p className="ol-not">{t("sample.linesHint")}</p>
          </fieldset>
          <div className="ol-satir">
            <Switch
              checked={sample.excluded}
              disabled={!editable || busy}
              label={t("sample.exclude")}
              onChange={async (v) => {
                setBusy(true);
                await onPatch({ exclude: v });
                setBusy(false);
              }}
            />
            <span aria-hidden="true">{t("sample.exclude")}</span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
