import { API, type CreateLanguage, type Language, type UndoToken } from "@tagpress/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText, undoText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { useLanguage } from "../../lib/language.tsx";
import { Button, EmptyState, Field, IconButton, Menu, PanelSection, Select, Tag, TextField, useConfirm, useToast } from "../../tezgah/index.ts";
import { Giris } from "./veri.tsx";

export default function TasarimDilleri() {
  const { t } = useTranslation("settings");
  const { languages, loading } = useLanguage();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // Yeni dil formu açıkken üstteki "Yeni" düğmesi gizlenir: ekranda en çok bir birincil düğme.
  const [creating, setCreating] = useState<{ copyFrom: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["languages"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  };
  const fail = (e: unknown) => toast({ message: serverText(e), tone: "error" });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.post<Language>(path(API.languageDefault, { lang: id })),
    onSuccess: (l) => {
      refresh();
      toast({ message: t("designLanguages.defaultToast", { name: l.name }), tone: "success" });
    },
    onError: fail,
  });

  const undo = async (token: string) => {
    try {
      await api.post(path(API.undo, { token }));
      refresh();
      toast({ message: t("designLanguages.undone"), tone: "success" });
    } catch (e) {
      fail(e);
    }
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.del<UndoToken>(path(API.language, { lang: id })),
    onSuccess: (tok) => {
      refresh();
      toast({ message: undoText(tok), action: { label: t("designLanguages.undo"), run: () => undo(tok.undoToken) } });
    },
    onError: fail,
  });

  return (
    <>
      <Giris>{t("designLanguages.intro")}</Giris>
      <PanelSection
        heading={t("designLanguages.listTitle")}
        aside={
          !creating && (
            <Button need="edit" variant="primary" icon="plus" onClick={() => setCreating({ copyFrom: "" })}>
              {t("designLanguages.new")}
            </Button>
          )
        }
      >
        {creating && <YeniDil languages={languages} initialCopy={creating.copyFrom} onDone={() => setCreating(null)} onCreated={refresh} />}

        {!loading && languages.length === 0 && !creating && <EmptyState icon="globe" title={t("designLanguages.empty")} />}

        {languages.length > 0 && (
          <ul className="ay-list">
            {languages.map((l) => (
              <li key={l.id} className="ay-li">
                {renaming === l.id ? (
                  <AdDegistir language={l} onDone={() => setRenaming(null)} onSaved={refresh} />
                ) : (
                  <>
                    <div className="ay-li-t">
                      <span className="ay-li-n">
                        <span>{l.name}</span>
                        {l.isDefault && <Tag tone="accent">{t("designLanguages.badgeDefault")}</Tag>}
                        {l.hasDraft && <Tag>{t("designLanguages.badgeDraft")}</Tag>}
                      </span>
                      <span className="ay-li-s tz-mono">
                        {l.activeVersion === null
                          ? t("designLanguages.metaNone", { count: l.templateCount })
                          : t("designLanguages.metaVersion", { version: l.activeVersion, count: l.templateCount })}
                        {` · ${l.id}`}
                      </span>
                    </div>
                    <div className="ay-li-a">
                      {!l.isDefault && (
                        <Button size="mini" variant="quiet" loading={makeDefault.isPending && makeDefault.variables === l.id} onClick={() => makeDefault.mutate(l.id)}>
                          {t("designLanguages.makeDefault")}
                        </Button>
                      )}
                      <Menu
                        trigger={(p) => <IconButton {...p} icon="dots" size={28} label={t("designLanguages.more", { name: l.name })} />}
                        items={[
                          { label: t("designLanguages.rename"), icon: "pen", onSelect: () => setRenaming(l.id) },
                          { label: t("designLanguages.copy"), icon: "copy", onSelect: () => setCreating({ copyFrom: l.id }) },
                          "sep",
                          {
                            label: l.isDefault ? t("designLanguages.deleteDefault") : t("designLanguages.delete"),
                            icon: "trash",
                            danger: true,
                            disabled: l.isDefault || remove.isPending,
                            onSelect: async () => {
                              const ok = await confirm({
                                title: t("designLanguages.confirmTitle", { name: l.name }),
                                body: t("designLanguages.confirmBody"),
                                confirmLabel: t("designLanguages.delete"),
                                tone: "danger",
                              });
                              if (ok) remove.mutate(l.id);
                            },
                          },
                        ]}
                      />
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}

function AdDegistir({ language, onDone, onSaved }: { language: Language; onDone(): void; onSaved(): void }) {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const [name, setName] = useState(language.name);
  const save = useMutation({
    mutationFn: () => api.patch<Language>(path(API.language, { lang: language.id }), { name: name.trim() }),
    onSuccess: () => {
      onSaved();
      onDone();
    },
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
  });
  const valid = name.trim().length > 0 && name.trim() !== language.name;
  return (
    <form
      className="ay-rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <TextField aria-label={t("designLanguages.newName")} autoFocus maxLength={80} value={name} onChange={setName} onKeyDown={(e) => e.key === "Escape" && onDone()} />
      {/* Satır içi kaydet ikincil: üstteki "Yeni tasarım dili" tek birincil düğme kalır. */}
      <Button type="submit" disabled={!valid} loading={save.isPending}>
        {t("state.save")}
      </Button>
      <VazgecDugmesi onClick={onDone} />
    </form>
  );
}

function YeniDil({ languages, initialCopy, onDone, onCreated }: { languages: Language[]; initialCopy: string; onDone(): void; onCreated(): void }) {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const { setCurrent } = useLanguage();
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState(initialCopy);
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateLanguage) => api.post<Language>(API.languages, body),
    onSuccess: (l) => {
      onCreated();
      setCurrent(l.id);
      toast({ message: t("designLanguages.createdToast", { name: l.name }), tone: "success" });
      onDone();
    },
    onError: (e) => setErr(serverText(e)),
  });
  const submit = () => {
    if (!name.trim()) {
      setErr(t("designLanguages.form.nameRequired"));
      return;
    }
    setErr(null);
    create.mutate({ name: name.trim(), ...(copyFrom ? { copyFrom } : {}) });
  };
  return (
    <form
      className="ay-card"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="ay-two">
        <Field label={t("designLanguages.form.name")} error={err ?? undefined}>
          <TextField autoFocus maxLength={80} value={name} onChange={setName} onKeyDown={(e) => e.key === "Escape" && onDone()} />
        </Field>
        <Field label={t("designLanguages.form.start")} hint={t("designLanguages.form.startHint")}>
          <Select
            value={copyFrom}
            onChange={setCopyFrom}
            options={[{ value: "", label: t("designLanguages.form.blank") }, ...languages.map((l) => ({ value: l.id, label: t("designLanguages.form.copyOf", { name: l.name }) }))]}
          />
        </Field>
      </div>
      <div className="ay-actions">
        <Button need="edit" variant="primary" type="submit" loading={create.isPending}>
          {t("designLanguages.form.create")}
        </Button>
        <VazgecDugmesi onClick={onDone} />
      </div>
    </form>
  );
}

function VazgecDugmesi({ onClick }: { onClick(): void }) {
  const { t } = useTranslation("common");
  return (
    <Button variant="quiet" onClick={onClick}>
      {t("actions.cancel")}
    </Button>
  );
}
