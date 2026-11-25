import "./kisayollar.ts";
import "./sablonlar.css";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { activeTab, type EkranProps } from "../../lib/route.ts";
import { useDesignLanguage } from "../../ortak/index.ts";
import { siblingsOf, splitPngs } from "./mantik/templateList.ts";
import { AppFrame, BandButton, Button, CenterColumn, EmptyState, Icon, useCommands, useToast, Workspace, WorkRow } from "../../tezgah/index.ts";
import { Duzenleyici } from "./Duzenleyici.tsx";
import { Izgara, KutuphanePaneli, type LibraryActions, useKutuphane } from "./Kutuphane.tsx";
import { kindLabel } from "./metin.ts";
import { UretmePenceresi, YuklemePenceresi } from "./Pencereler.tsx";

/** Son açılan şablon (ızgaradan düzenleyiciye dönüş için; tarayıcı oturumunda). */
const LAST_KEY = "studio.sablon.son";
const readLast = () => {
  try {
    return sessionStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};

/**
 * Şablonlar (`#/sablonlar[/<anahtar>]`, maket 1). Anahtarlı adres düzenleyiciyi açar (solda kütüphane, ortada tuval,
 * sağda alanın ayarları); anahtarsız adres kütüphanenin tam genişlik büyük ızgarasıdır.
 */
export default function SablonlarEkrani(props: EkranProps) {
  const { t } = useTranslation("templates");
  const { current, loading } = useDesignLanguage();
  const frame = (body: ReactNode) => (
    <AppFrame band="work" active={activeTab(props.route)} workRow={<WorkRow crumbs={[{ label: t("frame:nav.templates") }]} />}>
      {body}
    </AppFrame>
  );
  if (loading) return frame(<div className="sb-wait" aria-busy="true" />);
  if (!current) {
    return frame(
      <Workspace>
        <CenterColumn>
          <EmptyState
            icon="tag"
            title={t("noLanguage.title")}
            body={t("noLanguage.body")}
            action={
              <Button variant="secondary" onClick={() => props.go("ayarlar", ["tasarim-dilleri"])}>
                {t("noLanguage.action")}
              </Button>
            }
          />
        </CenterColumn>
      </Workspace>,
    );
  }
  return <Kutuphane key={current.id} {...props} lang={current.id} />;
}

function Kutuphane({ route, go, lang }: EkranProps & { lang: string }) {
  const { t } = useTranslation("templates");
  const toast = useToast();
  const k = useKutuphane(lang);
  const key = route.rest[0];
  const [upload, setUpload] = useState<File[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!key) return;
    try {
      sessionStorage.setItem(LAST_KEY, key);
    } catch {
      /* gizli pencere */
    }
  }, [key]);

  const open = useCallback((k2: string) => go("sablonlar", [k2]), [go]);
  const toggleView = () => {
    if (key) return go("sablonlar");
    const last = readLast();
    const target = last && k.existing.has(last) ? last : (k.shown[0]?.template.key ?? k.natural[0]);
    if (target) open(target);
  };
  const sib = key ? siblingsOf(k.natural, key) : { prev: null, next: null };

  const accept = useCallback(
    (files: File[]) => {
      const { ok, bad } = splitPngs(files);
      if (bad.length) toast({ tone: "error", message: t("upload.onlyPng", { names: bad.map((f) => f.name).join(", ") }) });
      if (ok.length) setUpload(ok);
    },
    [toast, t],
  );

  // PNG'yi ekranın herhangi bir yerine bırak.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      accept(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [accept]);

  useCommands("sablonlar", {
    "sablonlar.search": () => searchRef.current?.focus(),
    "sablonlar.toggleView": () => toggleView(),
    "sablonlar.prev": () => (sib.prev ? open(sib.prev) : false),
    "sablonlar.next": () => (sib.next ? open(sib.next) : false),
  });

  const actions: LibraryActions = { onOpen: open, onUpload: () => fileRef.current?.click(), onGenerate: () => setGenerating(true), onToggleView: toggleView };

  const extras = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png"
        multiple
        hidden
        data-testid="sb-file"
        onChange={(e) => {
          accept(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="sb-drop" aria-hidden="true">
          <Icon name="up" />
          {t("upload.drop")}
        </div>
      )}
      {upload && <YuklemePenceresi files={upload} languageId={lang} existing={k.existing} onClose={() => setUpload(null)} onUploaded={(keys) => keys.length === 1 && open(keys[0]!)} />}
      {generating && <UretmePenceresi languageId={lang} existing={k.existing} onClose={() => setGenerating(false)} />}
    </>
  );

  const crumbsFor = (title: string | null) => [
    { label: t("frame:nav.templates"), onClick: key ? () => go("sablonlar") : undefined },
    ...(title ? [{ label: title }] : []),
  ];

  if (!key) {
    return (
      <AppFrame band="work" active={activeTab(route)} workRow={<WorkRow crumbs={crumbsFor(null)} meta={<span className="sb-meta tz-mono">{t("library.count", { count: k.items.length })}</span>} />}>
        <Workspace>
          <CenterColumn>
            <Izgara k={k} a={actions} lang={lang} searchRef={searchRef} />
          </CenterColumn>
        </Workspace>
        {extras}
      </AppFrame>
    );
  }

  const left = <KutuphanePaneli k={k} a={actions} current={key} lang={lang} searchRef={searchRef} />;
  const kind = k.items.find((i) => i.template.key === key)?.template.kind;
  return (
    <Duzenleyici
      key={`${lang}:${key}`}
      lang={lang}
      templateKey={key}
      left={left}
      onNotFound={() => go("sablonlar")}
      frame={(body, info) => (
        <AppFrame
          band="work"
          active={activeTab(route)}
          workRow={
            <WorkRow
              crumbs={crumbsFor(info.title ? (kind ? `${info.title} · ${kindLabel(kind)}` : info.title) : key)}
              meta={
                <span className="sb-meta">
                  <BandButton label={t("editor.prev")} icon="left" quiet command="sablonlar.prev" disabled={!sib.prev} onClick={() => sib.prev && open(sib.prev)} />
                  <BandButton label={t("editor.next")} icon="right" quiet command="sablonlar.next" disabled={!sib.next} onClick={() => sib.next && open(sib.next)} />
                  {info.dirty && <span className="sb-unsaved">{t("editor.unsaved", { fields: info.labels.join(", ").toLocaleLowerCase() })}</span>}
                </span>
              }
            />
          }
        >
          {body}
          {extras}
        </AppFrame>
      )}
    />
  );
}
