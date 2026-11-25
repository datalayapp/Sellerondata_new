import { ORG_API, type OrgResponse } from "@tagpress/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api } from "../../lib/api.ts";
import { useAccess } from "../../lib/access.ts";
import { useOrg } from "../../lib/features.ts";
import { COMPANY_HREF, isPlatform } from "../../lib/platform.ts";
import { Button, Field, PanelSection, TextField, useToast } from "../../tezgah/index.ts";
import { Giris, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

/** Firma adı sınırı (`OrgPatchBodySchema`: baştaki/sondaki boşluk atılır, 1–80 karakter). */
const NAME_MAX = 80;

/**
 * Firma: ad (`GET`/`PATCH /api/org`). Kaydedilince `["org"]` önbelleği sunucunun yanıtıyla güncellenir.
 * Platform kipinde firma adı Merkez'de değişir (sunucu `PATCH` için 403 `name-managed-by-platform`): ad salt okunur,
 * Merkez'in firma sayfasına bağlantı. Yerelde de yönetemeyen (`access.manage` yok) kişi adı yalnız okur.
 */
export default function Firma() {
  const q = useOrg();
  const { manage } = useAccess();
  if (isPlatform() || !manage) return <FirmaOku name={q.data?.org.name} loading={q.isLoading} error={q.error} retry={() => void q.refetch()} />;
  return <FirmaDuzenle />;
}

function FirmaOku({ name, loading, error, retry }: { name: string | undefined; loading: boolean; error: unknown; retry(): void }) {
  const { t } = useTranslation("settings");
  return (
    <>
      <Giris>{t("org.intro")}</Giris>
      {loading && <Yukleniyor />}
      {!!error && <YuklemeHatasi error={error} retry={retry} />}
      {name !== undefined && (
        <PanelSection>
          <div className="ay-form">
            <Field label={t("org.name")} hint={isPlatform() ? t("org.platformHint") : undefined}>
              <TextField value={name} onChange={() => {}} readOnly />
            </Field>
            {isPlatform() && (
              <div className="ay-actions">
                <Button onClick={() => window.location.assign(COMPANY_HREF)}>{t("org.openHub")}</Button>
              </div>
            )}
          </div>
        </PanelSection>
      )}
    </>
  );
}

function FirmaDuzenle() {
  const { t } = useTranslation("settings");
  const q = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const current = q.data?.org.name ?? "";
  const [name, setName] = useState(current);
  useEffect(() => setName(current), [current]);

  const trimmed = name.trim();
  const error = !trimmed ? t("org.empty") : trimmed.length > NAME_MAX ? t("org.tooLong", { max: NAME_MAX }) : undefined;
  const dirty = trimmed !== current;

  const save = useMutation({
    mutationFn: () => api.patch<OrgResponse>(ORG_API.patch.path, { name: trimmed }),
    onSuccess: (v) => {
      qc.setQueryData(["org"], v);
      toast({ message: t("state.saved"), tone: "success" });
    },
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
  });

  return (
    <>
      <Giris>{t("org.intro")}</Giris>
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {q.data && (
        <PanelSection>
          <form
            className="ay-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!error && dirty) save.mutate();
            }}
          >
            <Field label={t("org.name")} error={dirty ? error : undefined}>
              <TextField value={name} onChange={setName} invalid={dirty && !!error} maxLength={NAME_MAX + 20} />
            </Field>
            <div className="ay-actions">
              <Button type="submit" variant="primary" disabled={!dirty || !!error} loading={save.isPending}>
                {t("state.save")}
              </Button>
            </div>
          </form>
        </PanelSection>
      )}
    </>
  );
}
