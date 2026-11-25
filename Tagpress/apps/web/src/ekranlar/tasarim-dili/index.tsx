import { API, type Language } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { useLanguage } from "../../lib/language.tsx";
import type { EkranProps } from "../../lib/route.ts";
import { parseSection, SECTIONS, type SectionId, sectionPath } from "./mantik/sections.ts";
import { useProposals, useReferences, useWork, WorkProvider } from "./mantik/work.tsx";
import { AppFrame, BandButton, Button, Dialog, EmptyState, Field, Icon, IssueBox, StatusDot, TextField, useConfirm, useToast, WorkRow } from "../../tezgah/index.ts";
import "./tasarim-dili.css";
import Dene from "./dene/Dene.tsx";
import Kurallar from "./kurallar/Kurallar.tsx";
import Ogren from "./ogren/Ogren.tsx";
import Ornekler from "./ornekler/Ornekler.tsx";
import Ozet from "./ozet/Ozet.tsx";
import Surumler from "./surumler/Surumler.tsx";

/** Tasarım dili: iş satırında dilin adı ve yedi sekme; rota `#/tasarim-dili/<bölüm>[/<grup>]`. */
export default function TasarimDiliEkrani(props: EkranProps) {
  const { t } = useTranslation("designLanguage");
  const { current, loading } = useLanguage();
  if (loading) {
    return (
      <AppFrame band="work" active="tasarim-dili" workRow={<WorkRow crumbs={[{ label: t("title") }]} />}>
        <div className="td-bos">
          <StatusDot tone="busy" label={t("loading")} />
        </div>
      </AppFrame>
    );
  }
  if (!current) return <DilYok />;
  return (
    <WorkProvider key={current.id} languageId={current.id}>
      <Kabuk {...props} language={current} />
    </WorkProvider>
  );
}

function Kabuk({ route, go, language }: EkranProps & { language: Language }) {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const { section, group } = parseSection(route.rest);
  const open = (s: SectionId, g?: Parameters<typeof sectionPath>[1]) => go("tasarim-dili", sectionPath(s, g));
  const refs = useReferences(language.id);
  const proposals = useProposals(language.id, "open");
  // Sekme sayaçları: örnek sayısı ve bekleyen öneri sayısı.
  const counts: Partial<Record<SectionId, number>> = { ornekler: refs.data?.length, ogren: proposals.data?.length };

  const invalid = Object.keys(w.errors).length > 0;
  // Taslak yoksa (ya da yayındakinden farkı yoksa) taslak durumu, Taslağı at ve Yayınla görünmez.
  const showDraft = !!w.value && w.hasDraft && w.changedCount > 0;

  return (
    <AppFrame
      band="work"
      active="tasarim-dili"
      workRow={
        <WorkRow
          crumbs={[{ label: language.name }]}
          tabs={{
            items: SECTIONS.map((s) => ({ id: s.id, label: s.label, count: counts[s.id] || undefined })),
            value: section,
            onChange: (id) => open(id as SectionId, id === "kurallar" ? group : undefined),
          }}
          actions={showDraft ? <Eylemler canPublish={!invalid} /> : undefined}
        />
      }
    >
      {w.loading && !w.value ? (
        <div className="td-bos">
          <StatusDot tone="busy" label={t("loading")} />
        </div>
      ) : !w.value ? (
        <div className="td-bos">
          <IssueBox tone="error">{w.loadError ?? t("noPublished")}</IssueBox>
        </div>
      ) : (
        <>
          {section === "ozet" && <Ozet onEdit={(g) => open("kurallar", g)} />}
          {section === "kurallar" && <Kurallar group={group} onGroup={(g) => open("kurallar", g)} />}
          {section === "surumler" && <Surumler />}
          {section === "dene" && <Dene />}
          {section === "ornekler" && <Ornekler onCreate={() => open("olustur")} />}
          {section === "ogren" && <Ogren onGo={(s) => open(s)} />}
        </>
      )}
    </AppFrame>
  );
}

/** Taslak durumu (kalem ikonlu soluk metin); iş satırının sağında, Taslağı at'ın solunda. */
function TaslakBilgisi() {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const invalid = Object.keys(w.errors).length > 0;
  const state = w.save === "saving" ? "saving" : invalid ? "invalid" : w.save === "error" ? "error" : w.save === "saved" ? "saved" : "pending";
  return (
    <span aria-live="polite" className={`td-meta${state === "invalid" || state === "error" ? " is-hata" : ""}`}>
      <Icon name={state === "invalid" || state === "error" ? "warn" : "pen"} size={15} />
      {t("draft.line", { n: w.changedCount, state: t(`draft.state.${state}`) })}
    </span>
  );
}

/** Taslak varken bantın sağı: taslak durumu, Taslağı at (onaylı) ve Yayınla (birincil, onaylı). */
function Eylemler({ canPublish }: { canPublish: boolean }) {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const confirm = useConfirm();
  const toast = useToast();
  const note = useRef("");

  const publish = async () => {
    note.current = "";
    const ok = await confirm({
      title: t("publish.title"),
      body: <YayinNotu onChange={(v) => (note.current = v)} />,
      confirmLabel: t("publish.confirm"),
    });
    if (!ok) return;
    try {
      const rec = await w.publish(note.current);
      toast({ message: t("publish.done", { version: rec.version }), tone: "success" });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    }
  };

  const discard = async () => {
    const ok = await confirm({ title: t("discard.title"), body: t("discard.body"), confirmLabel: t("discard.confirm"), tone: "danger" });
    if (!ok) return;
    try {
      await w.discard();
      toast({ message: t("discard.done"), tone: "success" });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    }
  };

  return (
    <>
      <TaslakBilgisi />
      <BandButton need="edit" quiet label={t("discard.confirm")} onClick={() => void discard()} />
      {/* BandButton'da `disabled` yok: pasif durum bir `fieldset disabled` ile verilir (içindeki düğme gerçekten pasifleşir). */}
      <fieldset className="td-act" disabled={!canPublish} title={canPublish ? undefined : t("publish.disabledHint")}>
        <BandButton need="edit" cta label={t("actions.publish")} onClick={() => void publish()} />
      </fieldset>
    </>
  );
}

function YayinNotu({ onChange }: { onChange: (v: string) => void }) {
  const { t } = useTranslation("designLanguage");
  const [v, setV] = useState("");
  return (
    <div className="td-yayin">
      <p>{t("publish.body")}</p>
      <Field label={t("publish.noteLabel")}>
        <TextField
          value={v}
          placeholder={t("publish.notePlaceholder")}
          onChange={(x) => {
            setV(x);
            onChange(x);
          }}
        />
      </Field>
    </div>
  );
}

/** Hiç tasarım dili yoksa: açıklama ve "Yeni tasarım dili". */
function DilYok() {
  const { t } = useTranslation("designLanguage");
  const qc = useQueryClient();
  const toast = useToast();
  const { setCurrent } = useLanguage();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(undefined);
    try {
      const lang = await api.post<Language>(path(API.languages), { name: name.trim() });
      await qc.invalidateQueries({ queryKey: ["languages"] });
      setCurrent(lang.id);
      setAsking(false);
      toast({ message: t("empty.created", { name: lang.name }), tone: "success" });
    } catch (e) {
      setErr(serverText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setAsking(false);
    setErr(undefined);
    setName("");
  };

  return (
    <AppFrame band="work" active="tasarim-dili" workRow={<WorkRow crumbs={[{ label: t("title") }]} />}>
      <div className="td-bos">
        <EmptyState icon="stamp" title={t("empty.title")} action={<Button need="edit" variant="primary" onClick={() => setAsking(true)}>{t("empty.create")}</Button>} />
        <div className="td-bos-not">
          <p>{t("empty.body")}</p>
          <ol>
            {(["step1", "step2", "step3"] as const).map((k) => (
              <li key={k}>{t(`empty.${k}`)}</li>
            ))}
          </ol>
        </div>
      </div>
      {asking && (
        <Dialog
          title={t("empty.dialogTitle")}
          size="sm"
          dirty={!!name.trim()}
          busy={busy}
          onClose={close}
          footer={
            <>
              <Button variant="quiet" onClick={close} disabled={busy}>
                {t("empty.cancel")}
              </Button>
              <Button need="edit" variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
                {t("empty.confirm")}
              </Button>
            </>
          }
        >
          <p>{t("empty.dialogBody")}</p>
          <Field label={t("empty.nameLabel")} error={err}>
            <TextField value={name} placeholder={t("empty.namePlaceholder")} onChange={setName} data-autofocus="" />
          </Field>
        </Dialog>
      )}
    </AppFrame>
  );
}
