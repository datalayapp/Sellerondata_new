import type { PrintTemplateView } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import { PRINT_KEYS, printApi } from "../mantik/api.ts";
import { deleteMode } from "../mantik/sablon/editor.ts";
import { useConfirm, useToast } from "../../../tezgah/index.ts";

type Target = Pick<PrintTemplateView, "id" | "name" | "usedIn">;

/**
 * Sayfa şablonu sil (liste kartı ve düzenleyicinin iş satırı aynı akış): pencere şablonun durumuna göre doğru metinle
 * açılır (hiç kullanılmamış: kalıcı silinir; baskıda kullanılmış: arşive kaldırılır), sonuç sunucudan gelir ve
 * bildirimle söylenir. Arşive kaldırılanda bildirimde "Geri al". Vazgeçilir ya da hata olursa null.
 */
export function useSablonSil(): (x: Target) => Promise<"deleted" | "archived" | null> {
  const { t } = useTranslation("printTemplates");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  return async (x) => {
    const mode = deleteMode(x);
    const ok = await confirm(
      mode === "archive"
        ? { title: t("delete.archiveTitle", { name: x.name }), body: t("delete.archiveBody", { count: x.usedIn ?? 0 }), confirmLabel: t("delete.archiveOk") }
        : {
            title: t("delete.title", { name: x.name }),
            body: mode === "delete" ? t("delete.body") : t("delete.bodyUnknown"),
            confirmLabel: t("delete.ok"),
            tone: "danger",
          },
    );
    if (!ok) return null;
    try {
      const r = await printApi.deleteTemplate(x.id);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      if (r.result === "deleted") toast({ message: t("toast.deleted", { name: x.name }) });
      else {
        toast({
          message: t("toast.archivedOnDelete", { name: x.name }),
          action: {
            label: t("toast.undo"),
            run: async () => {
              await printApi.archiveTemplate(x.id, false);
              void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
            },
          },
        });
      }
      return r.result;
    } catch (e) {
      toast({ tone: "error", message: t("toast.deleteFailed", { detail: serverText(e) }) });
      return null;
    }
  };
}
