import { API, type FontItem, type FontList } from "@tagpress/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path, withQuery } from "../../lib/api.ts";
import { useLanguage } from "../../lib/language.tsx";
import { FONT_EXT, formatBytes } from "./mantik/format.ts";
import { Button, cx, EmptyState, Field, IssueBadge, IssueBox, PanelSection, TextField, useToast } from "../../tezgah/index.ts";
import { Giris, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read"));
    r.readAsDataURL(file);
  });
}

export default function Fontlar() {
  const { t } = useTranslation("settings");
  const { current } = useLanguage();
  const lang = current?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const defaultText = t("fonts.sample.default");
  const [text, setText] = useState(defaultText);
  const [specimenText, setSpecimenText] = useState(defaultText);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Örnek resimleri her tuşta yeniden istememek için yazma durunca uygula.
  useEffect(() => {
    const id = window.setTimeout(() => setSpecimenText(text.trim() || defaultText), 450);
    return () => window.clearTimeout(id);
  }, [text, defaultText]);

  const q = useQuery({
    queryKey: ["fonts", lang],
    enabled: !!lang,
    queryFn: () => api.get<FontList>(path(API.fonts, { lang: lang ?? "" })),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const done: string[] = [];
      for (const f of files) {
        const data = await readAsDataUrl(f);
        await api.post(path(API.fonts, { lang: lang ?? "" }), { fileName: f.name, data });
        done.push(f.name);
      }
      return done;
    },
    onSuccess: (done) => toast({ message: done.length === 1 ? t("fonts.uploadedOne", { name: done[0] }) : t("fonts.uploadedMany", { count: done.length }), tone: "success" }),
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["fonts", lang] }),
  });

  const pick = (list: FileList | null) => {
    if (!list) return;
    const all = [...list];
    const ok = all.filter((f) => FONT_EXT.test(f.name));
    if (ok.length < all.length) toast({ message: t("fonts.badType"), tone: "error" });
    if (ok.length) upload.mutate(ok);
  };

  const own = q.data?.files.filter((f) => f.scope === "language") ?? [];
  const shared = q.data?.files.filter((f) => f.scope === "shared") ?? [];
  const missing = q.data?.missing ?? [];

  return (
    <>
      <Giris>{current ? t("fonts.intro", { name: current.name }) : t("fonts.introNone")}</Giris>
      {!current && <EmptyState icon="type" title={t("fonts.noLanguage")} />}
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {q.data && current && (
        <>
          {missing.length > 0 && (
            <IssueBox tone="error">
              <b>{t("fonts.missingTitle", { count: missing.length })}</b>
              <ul className="ay-miss">
                {missing.map((m) => (
                  <li key={m.fontId}>
                    {m.fontId} · <span className="tz-mono">{m.file ?? t("fonts.missingNoFile")}</span>
                  </li>
                ))}
              </ul>
              {t("fonts.missingHelp")}
            </IssueBox>
          )}

          <PanelSection>
            <Field label={t("fonts.sample.label")} hint={t("fonts.sample.hint")}>
              <TextField value={text} maxLength={80} onChange={setText} />
            </Field>
          </PanelSection>

          <FontGrubu title={t("fonts.own.title")} items={own} lang={current.id} text={specimenText} empty={t("fonts.own.empty")} />

          <div
            className={cx("ay-drop", over && "is-over")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              pick(e.dataTransfer.files);
            }}
          >
            <div className="ay-drop-t">
              <b>{t("fonts.drop.title")}</b>
              <span className="ay-note">{t("fonts.drop.hint", { name: current.name })}</span>
            </div>
            <Button need="edit" variant="primary" icon="plus" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
              {t("fonts.drop.pick")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".ttf,.otf,.woff,.woff2"
              aria-label={t("fonts.drop.pick")}
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <FontGrubu title={t("fonts.shared.title")} items={shared} lang={current.id} text={specimenText} empty={t("fonts.shared.empty")} />
        </>
      )}
    </>
  );
}

function FontGrubu({ title, items, lang, text, empty }: { title: string; items: FontItem[]; lang: string; text: string; empty: string }) {
  const { t } = useTranslation("settings");
  return (
    <PanelSection heading={title} aside={<span className="tz-mono ay-note">{items.length}</span>}>
      {items.length === 0 ? (
        <p className="ay-note">{empty}</p>
      ) : (
        <div>
          {items.map((f) => (
            <div key={`${f.scope}:${f.file}`} className="ay-font">
              <div className="ay-font-n">
                <b title={f.file}>
                  {f.family ?? f.file}
                  {f.style && ` ${f.style}`}
                </b>
                <small title={f.file}>
                  {f.file} · {formatBytes(f.size)}
                </small>
                {f.profileFontId ? (
                  <span className="ay-note">{t("fonts.inProfile", { id: f.profileFontId })}</span>
                ) : f.scope === "language" ? (
                  <span>
                    <IssueBadge tone="warn">{t("fonts.notInProfile")}</IssueBadge>
                  </span>
                ) : null}
              </div>
              <Ornek font={f} lang={lang} text={text} />
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  );
}

function Ornek({ font, lang, text }: { font: FontItem; lang: string; text: string }) {
  const { t } = useTranslation("settings");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [text]);
  const src = withQuery(path(API.fontSpecimen, { lang, file: font.file }), { scope: font.scope, text });
  return (
    <div className="ay-spec">
      {failed ? (
        <span className="ay-note">{t("fonts.specimenFailed")}</span>
      ) : (
        <img src={src} alt={t("fonts.specimenAlt", { name: font.family ?? font.file, text })} loading="lazy" onError={() => setFailed(true)} />
      )}
    </div>
  );
}
