import { API, type GenerateTemplateRequest, type TemplateItem, type TemplateTask, type UploadTemplate } from "@tagpress/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { isUnsupported } from "./mantik/endpoints.ts";
import { keyFromFileName } from "./mantik/templateList.ts";
import { allUploaded, generateBody, generateCheck, type UploadStatus, uploadPlan } from "./mantik/upload.ts";
import { Button, Dialog, Field, IconButton, IssueBox, Select, StatusDot, Tag, TextArea, TextField, useToast } from "../../tezgah/index.ts";
import { kindLabel, unsupportedText } from "./metin.ts";

interface Row {
  id: number;
  file: File;
  key: string;
  kind: "label" | "sticker";
  preview: string;
  status: UploadStatus;
  error?: string;
}

let seq = 0;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error(i18n.t("templates:upload.readFailed")));
    r.readAsDataURL(file);
  });
}

const objectUrl = (f: File) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : "");

/**
 * Şablon yükleme (PNG'ler; sürükle-bırak ya da dosya seçici). Her dosyaya anahtar sorulur (dosya adından önerilir).
 * Var olan anahtarla yüklemek eski dosyanın yerine geçer; sunucu eskisini önce yedekler ve bunu kullanıcıya söyleriz.
 */
export function YuklemePenceresi({ files, languageId, existing, onClose, onUploaded }: { files: File[]; languageId: string; existing: ReadonlySet<string>; onClose(): void; onUploaded(keys: string[]): void }) {
  const { t } = useTranslation("templates");
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => files.map((file) => ({ id: ++seq, file, key: keyFromFileName(file.name), kind: "label", preview: objectUrl(file), status: "idle" })));
  const [busy, setBusy] = useState(false);
  const urls = useRef(rows.map((r) => r.preview));
  useEffect(
    () => () => {
      for (const u of urls.current) if (u) URL.revokeObjectURL(u);
    },
    [],
  );

  const patchRow = (id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const plan = uploadPlan(rows, existing, busy);

  const upload = async () => {
    setBusy(true);
    const done: string[] = [];
    for (const r of plan.pending) {
      patchRow(r.id, { status: "busy", error: undefined });
      try {
        const body: UploadTemplate = { key: r.key.trim(), fileName: r.file.name, png: await toBase64(r.file), kind: r.kind };
        await api.post<TemplateItem>(path(API.templates, { lang: languageId }), body);
        patchRow(r.id, { status: "ok" });
        done.push(r.key.trim());
      } catch (e) {
        patchRow(r.id, { status: "error", error: serverText(e) });
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ["templates", languageId] });
    void qc.invalidateQueries({ queryKey: ["template", languageId] });
    if (done.length) {
      onUploaded(done);
      toast({ tone: "success", message: done.length === 1 ? t("upload.doneOne", { key: done[0] }) : t("upload.doneMany", { count: done.length }) });
    }
    setRows((rs) => {
      if (allUploaded(rs)) window.setTimeout(onClose, 0);
      return rs;
    });
  };

  return (
    <Dialog
      title={rows.length === 1 ? t("upload.titleOne") : t("upload.titleMany", { count: rows.length })}
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            {t("upload.cancel")}
          </Button>
          <Button need="edit" variant="primary" disabled={!plan.canUpload} loading={busy} onClick={() => void upload()}>
            {plan.pending.length > 1 ? t("upload.submitMany", { count: plan.pending.length }) : t("upload.submit")}
          </Button>
        </>
      }
    >
      <div className="sb-dlg">
        {plan.overwrites.length > 0 && (
          <IssueBox tone="warn">
            <b>{t("upload.overwriteTitle", { keys: plan.overwrites.join(", ") })}</b> {t("upload.overwriteBody")}
          </IssueBox>
        )}
        <ul className="sb-up">
          {rows.map((r, i) => {
            const prob = plan.problems[i];
            const locked = r.status === "ok" || busy;
            return (
              <li key={r.id} className="sb-up-r">
                <span className="sb-up-img">{r.preview && <img src={r.preview} alt="" />}</span>
                <div className="sb-up-f">
                  <Field label={t("upload.key")} hint={r.file.name} error={prob ? t(`upload.problem.${prob}`) : r.status === "error" ? r.error : undefined}>
                    <TextField value={r.key} disabled={locked} onChange={(v) => patchRow(r.id, { key: v, status: r.status === "error" ? "idle" : r.status })} />
                  </Field>
                  <Field label={t("upload.kind")}>
                    <Select<Row["kind"]>
                      value={r.kind}
                      disabled={locked}
                      options={[
                        { value: "label", label: kindLabel("label") },
                        { value: "sticker", label: kindLabel("sticker") },
                      ]}
                      onChange={(v) => patchRow(r.id, { kind: v })}
                    />
                  </Field>
                </div>
                <div className="sb-up-s">
                  {r.status === "ok" && <StatusDot tone="ok" label={t("upload.uploaded")} />}
                  {r.status === "busy" && <StatusDot tone="busy" label={t("upload.uploading")} />}
                  {r.status === "error" && <StatusDot tone="error" label={t("upload.failed")} />}
                  {r.status !== "ok" && existing.has(r.key.trim()) && <Tag>{t("upload.overwrites")}</Tag>}
                  {r.status !== "ok" && rows.length > 1 && !busy && <IconButton icon="x" size={26} label={t("upload.remove")} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="sb-note">{t("upload.hint")}</p>
      </div>
    </Dialog>
  );
}

/**
 * Temadan şablon üret: tema/tarif + (isteğe bağlı) örnek metin → görüntü modeli yeni bir şablon PNG'si çizer ve
 * kütüphaneye "üretilmiş" olarak ekler. Ücretlidir (pencere bunu söyler); onay düğmenin kendisidir.
 */
export function UretmePenceresi({ languageId, existing, onClose }: { languageId: string; existing: ReadonlySet<string>; onClose(): void }) {
  const { t } = useTranslation("templates");
  const toast = useToast();
  const qc = useQueryClient();
  const [theme, setTheme] = useState("");
  const [sample, setSample] = useState("");
  const [key, setKey] = useState("");

  const run = useMutation({
    mutationFn: () => api.post<TemplateTask>(path(API.templatesGenerate, { lang: languageId }), generateBody({ theme, sample, key }) satisfies GenerateTemplateRequest),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["templates", languageId] });
      toast({ message: t("generate.queued") });
      onClose();
    },
  });
  const check = generateCheck({ theme, key }, existing, run.isPending);

  return (
    <Dialog
      title={t("generate.title")}
      busy={run.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t("generate.cancel")}
          </Button>
          <Button need="spend" variant="primary" icon="spark" disabled={!check.can} loading={run.isPending} onClick={() => run.mutate()}>
            {t("generate.submit")}
          </Button>
        </>
      }
    >
      <div className="sb-dlg">
        <Field label={t("generate.theme")} hint={t("generate.themeHint")}>
          <TextArea value={theme} rows={3} data-autofocus="" onChange={setTheme} />
        </Field>
        <Field label={t("generate.sample")} hint={t("generate.sampleHint")}>
          <TextArea value={sample} rows={2} onChange={setSample} />
        </Field>
        <Field label={t("generate.key")} hint={t("generate.keyHint")} error={check.keyError ? t(`generate.keyError.${check.keyError}`) : undefined}>
          <TextField value={key} onChange={setKey} />
        </Field>
        <p className="sb-note">{t("generate.cost")}</p>
        {run.isError &&
          (isUnsupported(run.error) ? (
            <IssueBox tone="info">
              <b>{t("generate.missing")}</b> {unsupportedText()}
            </IssueBox>
          ) : (
            <IssueBox tone="error">
              <b>{t("generate.failed")}</b> {serverText(run.error)}
            </IssueBox>
          ))}
      </div>
    </Dialog>
  );
}
