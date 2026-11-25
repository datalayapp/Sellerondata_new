import { API, type SettingsPatch, type SettingsView } from "@tagpress/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api } from "../../lib/api.ts";
import { Button, IssueBox, useToast } from "../../tezgah/index.ts";

/** Ayarlar ve anahtar durumları (bugünkü sorgu anahtarı `["settings"]` aynen). */
export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsView>(API.settings) });
}

/** Kısmi ayar güncellemesi: sonuç önbelleğe yazılır, kaydedildi ya da hata bildirimi gösterilir. */
export function usePatchSettings() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patch<SettingsView>(API.settings, patch),
    onSuccess: (v) => {
      qc.setQueryData(["settings"], v);
      toast({ message: t("state.saved"), tone: "success" });
    },
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
  });
}

export function Yukleniyor() {
  const { t } = useTranslation("settings");
  return (
    <p className="ay-note" role="status">
      {t("state.loading")}
    </p>
  );
}

export function YuklemeHatasi({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <IssueBox
      tone="error"
      fixes={
        retry ? (
          <Button size="mini" onClick={retry}>
            {t("state.retry")}
          </Button>
        ) : undefined
      }
    >
      {t("state.loadError")}: {serverText(error)}
    </IssueBox>
  );
}

/** Bölüm girişi: bir cümle. */
export function Giris({ children }: { children: ReactNode }) {
  return <p className="ay-intro">{children}</p>;
}
