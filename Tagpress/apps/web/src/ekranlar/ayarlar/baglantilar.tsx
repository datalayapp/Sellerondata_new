import { type AiProvider, API, type ApiKeyStatus, MODELS, SetApiKeySchema, type SettingsView } from "@tagpress/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { isPlatform } from "../../lib/platform.ts";
import { Button, CollapsedGroup, Field, IssueBadge, IssueBox, StatusDot, TextField, useConfirm, useToast } from "../../tezgah/index.ts";
import { modelLabel } from "./mantik/format.ts";
import { imagePriceText, keyStatusText, priceText } from "./metin.ts";
import { Giris, useSettings, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

/** Sağlayıcıya göre sabitler (marka adı ve adres dile göre değişmez; metinler sözlükte). */
const INFO: Record<AiProvider, { model: () => string; price: () => string | null; where: string }> = {
  anthropic: { model: () => modelLabel(MODELS.daily), price: () => priceText(MODELS.daily), where: "console.anthropic.com" },
  gemini: { model: () => modelLabel(MODELS.image), price: () => imagePriceText(), where: "aistudio.google.com" },
};

/**
 * Bağlantılar. Platform kipinde yapay zekâ anahtarları SellerOnData'nın yapay zekâ geçidindedir (sunucunun anahtar uçları
 * 409 `managed-by-platform`): burada yalnız bunu söyleyen not, anahtar formu yok.
 */
export default function Baglantilar() {
  return isPlatform() ? <PlatformBaglantilar /> : <YerelBaglantilar />;
}

function PlatformBaglantilar() {
  const { t } = useTranslation("settings");
  return (
    <>
      <Giris>{t("connections.platformIntro")}</Giris>
      <IssueBox tone="info">{t("connections.platformBody")}</IssueBox>
    </>
  );
}

function YerelBaglantilar() {
  const { t } = useTranslation("settings");
  const q = useSettings();
  // Aynı anda tek anahtar girilir: ekranda en çok bir birincil (Kaydet) düğme.
  const [editing, setEditing] = useState<AiProvider | null>(null);
  return (
    <>
      <Giris>{t("connections.intro")}</Giris>
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {q.data && (
        <>
          {q.data.warnings.length > 0 && (
            <IssueBox tone="warn">
              <b>{t("connections.warningTitle")}</b> {q.data.warnings.join(" ")}
            </IssueBox>
          )}
          <div className="ay-provs">
            {q.data.keys.map((k) => (
              <AnahtarGrubu key={k.provider} status={k} editing={editing === k.provider} onEdit={() => setEditing(k.provider)} onClose={() => setEditing(null)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function AnahtarGrubu({ status, editing, onEdit, onClose }: { status: ApiKeyStatus; editing: boolean; onEdit(): void; onClose(): void }) {
  const { t } = useTranslation("settings");
  const info = INFO[status.provider];
  const title = t(`connections.providers.title.${status.provider}`);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Düzenleme kapanınca (vazgeç, kaydedildi, başka sağlayıcıya geçildi) girilen değer bellekte kalmaz.
  useEffect(() => {
    if (!editing) {
      setValue("");
      setErr(null);
    }
  }, [editing]);

  const update = (s: ApiKeyStatus) =>
    qc.setQueryData<SettingsView>(["settings"], (old) => (old ? { ...old, keys: old.keys.map((x) => (x.provider === s.provider ? s : x)) } : old));

  const save = useMutation({
    mutationFn: (apiKey: string) => api.put<ApiKeyStatus>(path(API.settingsKey, { provider: status.provider }), { apiKey }),
    onSuccess: (s) => {
      update(s);
      setValue("");
      onClose();
      toast({ message: t("connections.savedToast", { provider: title }), tone: "success" });
    },
    onError: (e) => setErr(serverText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del<ApiKeyStatus>(path(API.settingsKey, { provider: status.provider })),
    onSuccess: (s) => {
      update(s);
      toast({ message: t("connections.deletedToast", { provider: title }) });
    },
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
  });

  const submit = () => {
    const parsed = SetApiKeySchema.safeParse({ apiKey: value });
    if (!parsed.success) {
      setErr(t("connections.tooShort"));
      return;
    }
    setErr(null);
    save.mutate(parsed.data.apiKey);
  };

  const price = info.price();
  return (
    <div className="ay-prov">
      <span className="ay-prov-l" aria-hidden="true">
        {title.charAt(0)}
      </span>
      <div className="ay-prov-t">
        <b>{title}</b>
        <small>
          {t(`connections.providers.use.${status.provider}`)}{" "}
          <span className="ay-nw">
            <span aria-hidden="true">·</span> <StatusDot tone={status.hasKey ? "ok" : "idle"} label={keyStatusText(status.hasKey, status.updatedAt)} />
          </span>
          {status.hasKey && !status.encrypted && <IssueBadge tone="warn">{t("connections.notEncrypted")}</IssueBadge>}
        </small>
      </div>
      {!editing && (
        <span className="ay-actions">
          <Button onClick={onEdit}>{status.hasKey ? t("connections.change") : t("connections.enter")}</Button>
          {status.hasKey && (
            <Button
              variant="quiet"
              className="ay-del"
              loading={remove.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: t("connections.confirmTitle", { provider: title }),
                  body: t("connections.confirmBody"),
                  confirmLabel: t("connections.delete"),
                  tone: "danger",
                });
                if (ok) remove.mutate();
              }}
            >
              {t("connections.delete")}
            </Button>
          )}
        </span>
      )}
      {editing && (
        <form
          className="ay-form ay-prov-f"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label={t("connections.newKey")} hint={t("connections.newKeyHint", { where: info.where })} error={err ?? undefined}>
            <TextField className="ay-key" type="password" autoComplete="off" spellCheck={false} autoFocus value={value} onChange={setValue} />
          </Field>
          <div className="ay-actions">
            <CancelButton onClick={onClose} />
            <Button variant="primary" type="submit" loading={save.isPending} disabled={!value.trim()}>
              {t("state.save")}
            </Button>
          </div>
        </form>
      )}
      <div className="ay-prov-f">
        <CollapsedGroup title={t("connections.modelGroup")} summary={info.model()}>
          <p className="ay-note tz-mono">
            {info.model()}
            {price && ` · ${price}`}
          </p>
        </CollapsedGroup>
      </div>
    </div>
  );
}

function CancelButton({ onClick }: { onClick(): void }) {
  const { t } = useTranslation("common");
  return (
    <Button variant="quiet" onClick={onClick}>
      {t("actions.cancel")}
    </Button>
  );
}
