import {
  API,
  PRINT_API,
  type PrintExport,
  type PrintExportRequest,
  type PrintGridRequest,
  type PrintGridSpecInput,
  type PrintGridResponse,
  type PrintPreset,
  type PrintAddJobs,
  type PrintSessionCreate,
  type PrintSessionCreateResponse,
  type PrintSessionDetail,
  type PrintSessionPatch,
  type PrintSessionPatchResponse,
  type PrintSessionSummary,
  type PrintShelfResponse,
  type PrintTemplateCreate,
  type PrintTemplateDeleteResponse,
  type PrintTemplatePatch,
  type PrintTemplateView,
  type ProfileRecord,
  type UndoResult,
  type UndoToken,
} from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { api, path, withQuery } from "../../../lib/api.ts";

/**
 * Baskı masası istemcisi: `PRINT_API` uçları (sözleşme `packages/domain/src/print.ts` → "API").
 * Sorgu anahtarlarının kökleri `lib/liveSync.ts`'teki `print` / `printExport` olay eşlemesiyle aynıdır.
 */

export const PRINT_KEYS = {
  templates: "printTemplates",
  presets: "printPresets",
  shelf: "printShelf",
  sessions: "printSessions",
  session: "printSession",
  export: "printExport",
} as const;

export const printApi = {
  templates: (languageId: string, archived = false) =>
    api.get<{ templates: PrintTemplateView[] }>(withQuery(PRINT_API.templates, { languageId, archived: archived ? 1 : undefined })),
  template: (id: string) => api.get<PrintTemplateView>(path(PRINT_API.template, { id })),
  createTemplate: (body: PrintTemplateCreate) => api.post<PrintTemplateView>(PRINT_API.templates, body),
  patchTemplate: (id: string, body: PrintTemplatePatch) => api.patch<PrintTemplateView>(path(PRINT_API.template, { id }), body),
  archiveTemplate: (id: string, archived: boolean) => api.post<PrintTemplateView>(path(PRINT_API.templateArchive, { id }), { archived }),
  /** Kullanılmamışsa kalıcı siler (`deleted`), bir baskıda kullanılmışsa arşivler (`archived`). */
  deleteTemplate: (id: string) => api.del<PrintTemplateDeleteResponse>(path(PRINT_API.template, { id })),
  duplicateTemplate: (id: string, name?: string) => api.post<PrintTemplateView>(path(PRINT_API.templateDuplicate, { id }), name ? { name } : {}),
  grid: (body: PrintGridRequest) => api.post<PrintGridResponse>(PRINT_API.templateGrid, body),

  presets: (languageId: string) => api.get<{ presets: PrintPreset[] }>(withQuery(PRINT_API.presets, { languageId })),
  createPreset: (body: Omit<PrintPreset, "id" | "grid"> & { languageId: string; grid: PrintGridSpecInput }) => api.post<PrintPreset>(PRINT_API.presets, body),
  deletePreset: (id: string, languageId: string) => api.del<{ ok: true }>(withQuery(path(PRINT_API.preset, { id }), { languageId })),

  shelf: (languageId: string) => api.get<PrintShelfResponse>(withQuery(PRINT_API.shelf, { languageId })),

  sessions: (q: { languageId: string; status?: "draft" | "printed"; q?: string; limit?: number }) =>
    api.get<{ sessions: PrintSessionSummary[] }>(withQuery(PRINT_API.sessions, q)),
  createSession: (body: PrintSessionCreate) => api.post<PrintSessionCreateResponse>(PRINT_API.sessions, body),
  session: (id: string, signal?: AbortSignal) => api.get<PrintSessionDetail>(path(PRINT_API.session, { id }), signal),
  patchSession: (id: string, body: PrintSessionPatch) => api.patch<PrintSessionPatchResponse>(path(PRINT_API.session, { id }), body),
  deleteSession: (id: string) => api.del<UndoToken>(path(PRINT_API.session, { id })),
  replan: (id: string, version: number) => api.post<PrintSessionPatchResponse>(path(PRINT_API.sessionReplan, { id }), { version }),
  addJobs: (id: string, body: PrintAddJobs) => api.post<PrintSessionPatchResponse>(path(PRINT_API.sessionAddJobs, { id }), body),
  markPrinted: (id: string, printed: boolean, version?: number) => api.post<PrintSessionDetail>(path(PRINT_API.sessionPrinted, { id }), { printed, version }),
  reprint: (id: string, name?: string) => api.post<PrintSessionDetail>(path(PRINT_API.sessionReprint, { id }), name ? { name } : {}),
  startExport: (id: string, body: PrintExportRequest) => api.post<PrintExport>(path(PRINT_API.sessionExport, { id }), body),
  getExport: (id: string) => api.get<PrintExport>(path(PRINT_API.export, { id })),

  undo: (token: string) => api.post<UndoResult>(path(API.undo, { token })),
};

/** Sayfa küçük resmi (sunucu çizer). `v`: oturum sürümü — değişince tarayıcı önbelleği atlanır. */
export function pagePreviewUrl(pageId: string, w: number, v: number | string): string {
  return withQuery(path(PRINT_API.pagePreview, { id: pageId }), { w, v });
}

/** Varyasyon önizlemesi (raftaki adres önbellek anahtarlı gelir; yoksa yalın uç + yerel sürüm). */
export function variantPreviewUrl(variantId: string, rev = 0): string {
  return withQuery(path(API.variantPreview, { id: variantId }), { r: rev || undefined });
}

// ---------------------------------------------------------------- sorgular

export function usePrintTemplates(languageId: string | undefined, archived = false) {
  return useQuery({
    queryKey: [PRINT_KEYS.templates, languageId, archived],
    queryFn: () => printApi.templates(languageId!, archived),
    enabled: !!languageId,
    staleTime: 10_000,
  });
}

export function usePrintPresets(languageId: string | undefined) {
  return useQuery({ queryKey: [PRINT_KEYS.presets, languageId], queryFn: () => printApi.presets(languageId!), enabled: !!languageId, staleTime: 30_000 });
}

/** Tasarım dilindeki baskı çözünürlüğü (dpi). Üretim ekranıyla aynı profil sorgusunu paylaşır. */
export function useProfileDpi(languageId: string | undefined) {
  return useQuery({
    queryKey: ["profile", languageId, "uretim"],
    queryFn: ({ signal }) => api.get<ProfileRecord>(path(API.profile, { lang: languageId as string }), signal),
    enabled: !!languageId,
    select: (p): number => p.data.printing.dpi,
    staleTime: 60_000,
  });
}

export function useShelf(languageId: string | undefined) {
  return useQuery({ queryKey: [PRINT_KEYS.shelf, languageId], queryFn: () => printApi.shelf(languageId!), enabled: !!languageId, staleTime: 5_000 });
}

export function useSessions(languageId: string | undefined, status: "draft" | "printed", q = "") {
  return useQuery({
    queryKey: [PRINT_KEYS.sessions, languageId, status, q],
    queryFn: () => printApi.sessions({ languageId: languageId!, status, q: q || undefined, limit: 200 }),
    enabled: !!languageId,
    staleTime: 5_000,
  });
}
