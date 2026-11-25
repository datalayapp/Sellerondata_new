import {
  API,
  type ApproveBestResponse,
  type BatchSummary,
  type GenerateRequest,
  type GenerateResponse,
  type JobDetail,
  type JobListResponse,
  type JobLog,
  type JobPatch,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type LabelSize,
  type ProfileRecord,
  type ProgressStep,
  type TemplateItem,
  type UndoToken,
  type VariantDetail,
  type VariantEditModel,
} from "@tagpress/domain";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fileProblemText, toastText, uploadText } from "../metin.ts";
import { previewBody, readImportFile } from "../../ice-aktar/mantik/desk.ts";
import { type UploadSource, uploadPlan } from "./yukle.ts";
import { i18n } from "../../../i18n/index.ts";
import { serverText, undoText } from "../../../i18n/sunucu.ts";
import { api, ApiFailure, goToConnections, path, withQuery } from "../../../lib/api.ts";
import { useServerEvents } from "../../../lib/events.ts";
import { useToast } from "../../../lib/notify.ts";

/**
 * Üretim ekranının sunucu katmanı. Sorgu anahtarları: ["jobs", filtre] · ["job", id] · ["batches", dilId] · ["queue"].
 * Süzme/sıralama/arama istemcide yapılır (sunucu işleri tek sorguda verir); ekran bütün işleri ister (parti süzgeci yok).
 */

export interface JobsFilter {
  languageId?: string;
  batchId?: string;
}

export function useJobs(filter: JobsFilter, enabled = true) {
  return useQuery({
    queryKey: ["jobs", filter],
    queryFn: ({ signal }) => api.get<JobListResponse>(withQuery(API.jobs, { ...filter, sort: "created", dir: "asc" }), signal),
    enabled: enabled && !!filter.languageId,
    placeholderData: (prev) => prev,
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ["job", id],
    queryFn: ({ signal }) => api.get<JobDetail>(path(API.job, { id: id as string }), signal),
    enabled: !!id,
  });
}

export function useVariantDetail(id: string | null) {
  return useQuery({
    queryKey: ["variant", id],
    queryFn: ({ signal }) => api.get<VariantDetail>(path(API.variant, { id: id as string }), signal),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** Hafif düzeltme katmanının modeli. Her açılışta taze alınır (kayıttan sonra eski düzeltme görünmesin). */
export function useVariantEdit(id: string | null) {
  return useQuery({
    queryKey: ["variantEdit", id],
    queryFn: ({ signal }) => api.get<VariantEditModel>(path(API.variantEdit, { id: id as string }), signal),
    enabled: !!id,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useJobLog(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["job", id, "log"],
    queryFn: ({ signal }) => api.get<JobLog>(path(API.jobLog, { id: id as string }), signal),
    enabled: enabled && !!id,
  });
}

export function useBatches(languageId: string | undefined) {
  return useQuery({
    queryKey: ["batches", languageId],
    queryFn: ({ signal }) => api.get<{ batches: BatchSummary[] }>(withQuery(API.batches, { languageId }), signal),
    enabled: !!languageId,
    select: (d) => d.batches,
  });
}

export function useTemplates(languageId: string | undefined) {
  return useQuery({
    queryKey: ["templates", languageId, "uretim"],
    queryFn: ({ signal }) => api.get<{ templates: TemplateItem[] }>(path(API.templates, { lang: languageId as string }), signal),
    enabled: !!languageId,
    select: (d) => d.templates,
    staleTime: 60_000,
  });
}

/** Etiket boyutları (profilin çıktı ayarlarından). */
export function useLabelSizes(languageId: string | undefined) {
  return useQuery({
    queryKey: ["profile", languageId, "uretim"],
    queryFn: ({ signal }) => api.get<ProfileRecord>(path(API.profile, { lang: languageId as string }), signal),
    enabled: !!languageId,
    select: (p): { sizes: LabelSize[]; defaultSize: string } => ({ sizes: p.data.output.sizes, defaultSize: p.data.output.defaultSize }),
    staleTime: 60_000,
  });
}

/** İş başına son üretim adımı ("Yerleşim hesaplanıyor…") — yalnızca üretilen işlerde gösterilir. */
export function useProgress(): Record<string, ProgressStep> {
  const [map, setMap] = useState<Record<string, ProgressStep>>({});
  useServerEvents((e) => {
    if (e.type === "progress") setMap((m) => ({ ...m, [e.step.jobId]: e.step }));
    else if (e.type === "job" && e.status && e.status !== "generating" && e.status !== "queued")
      setMap((m) => {
        if (!(e.jobId in m)) return m;
        const { [e.jobId]: _gone, ...rest } = m;
        return rest;
      });
  });
  return map;
}

// ---------------------------------------------------------------- önbellek yardımcıları

/** Bir işin güncel hâlini hem ayrıntı hem liste önbelleklerine yazar (arayüz sunucu olayını beklemeden güncellenir). */
export function syncJob(qc: QueryClient, job: JobDetail) {
  qc.setQueryData(["job", job.id], job);
  qc.setQueriesData<JobListResponse>({ queryKey: ["jobs"] }, (old) => {
    if (!old || !old.jobs.some((j) => j.id === job.id)) return old;
    return { ...old, jobs: old.jobs.map((j) => (j.id === job.id ? { ...j, ...job } : j)) };
  });
}

export function invalidateWork(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["jobs"] });
  void qc.invalidateQueries({ queryKey: ["job"] });
  void qc.invalidateQueries({ queryKey: ["variant"] });
  void qc.invalidateQueries({ queryKey: ["variantEdit"] });
  void qc.invalidateQueries({ queryKey: ["batches"] });
}

// ---------------------------------------------------------------- eylemler

export type JobOps = ReturnType<typeof useJobOps>;

/** Bütün yazma eylemleri: hata bildirimi, geri al, önbellek tazeleme burada. Her eylem başarıyı null olmayan sonuçla bildirir. */
export function useJobOps() {
  const qc = useQueryClient();
  const toast = useToast();

  return useMemo(() => {
    const fail = (e: unknown) => {
      // "Anahtar yok" (409 missing-key): bildirimde Ayarlar → Bağlantılar eylemi (her dilde; sağlayıcı yalnız TR metinde ekliyordu).
      const missingKey = e instanceof ApiFailure && e.body.code === "missing-key";
      toast({ tone: "error", message: serverText(e), ...(missingKey ? { action: { label: i18n.t("common:actions.goToConnections"), run: goToConnections } } : {}) });
      return null;
    };

    const undo = async (token: string) => {
      try {
        await api.post(path(API.undo, { token }));
        invalidateWork(qc);
        toast({ tone: "success", message: toastText("undone") });
      } catch (e) {
        fail(e);
      }
    };
    const undoToast = (t: UndoToken) => toast({ message: undoText(t), action: { label: toastText("undo"), run: () => undo(t.undoToken) } });

    const skippedText = (skipped: Array<{ id: string; reason: string }>) => (skipped.length ? ` ${toastText("skipped", { count: skipped.length, reason: skipped[0]?.reason ?? "" })}` : "");

    return {
      undo,

      async generate(ids: string[], opts: Partial<Omit<GenerateRequest, "jobIds">> = {}) {
        if (ids.length === 0) return null;
        try {
          const r = await api.post<GenerateResponse>(API.generate, { jobIds: ids, ...opts });
          invalidateWork(qc);
          void qc.invalidateQueries({ queryKey: ["queue"] });
          toast({ tone: r.queued.length ? "success" : "error", message: `${r.queued.length ? toastText("queued", { count: r.queued.length }) : toastText("noneQueued")}${skippedText(r.skipped)}` });
          return r;
        } catch (e) {
          return fail(e);
        }
      },

      async approveBest(ids: string[]) {
        try {
          const r = await api.post<ApproveBestResponse>(API.jobsApproveBest, { ids });
          invalidateWork(qc);
          toast({
            tone: r.approved.length ? "success" : "error",
            message: `${r.approved.length ? toastText("approved", { count: r.approved.length }) : toastText("noneApproved")}${skippedText(r.skipped)}`,
          });
          return r;
        } catch (e) {
          return fail(e);
        }
      },

      async setAiNote(ids: string[], aiNote: string) {
        try {
          const r = await api.post<{ jobs: JobDetail[] }>(API.jobsBulk, { ids, patch: { aiNote } });
          for (const j of r.jobs) syncJob(qc, j);
          toast({ tone: "success", message: aiNote ? toastText("noteAdded", { count: r.jobs.length }) : toastText("noteCleared") });
          return r;
        } catch (e) {
          return fail(e);
        }
      },

      async deleteJobs(ids: string[]) {
        try {
          const t = await api.post<UndoToken>(API.jobsDelete, { ids });
          invalidateWork(qc);
          undoToast(t);
          return t;
        } catch (e) {
          return fail(e);
        }
      },

      async approve(jobId: string, variantId: string | null) {
        try {
          const j = await api.post<JobDetail>(path(API.jobApprove, { id: jobId }), { variantId });
          syncJob(qc, j);
          void qc.invalidateQueries({ queryKey: ["batches"] });
          return j;
        } catch (e) {
          return fail(e);
        }
      },

      async patchJob(id: string, patch: JobPatch) {
        try {
          const j = await api.patch<JobDetail>(path(API.job, { id }), patch);
          syncJob(qc, j);
          void qc.invalidateQueries({ queryKey: ["batches"] });
          return j;
        } catch (e) {
          return fail(e);
        }
      },

      async deleteVariant(id: string) {
        try {
          const t = await api.del<UndoToken>(path(API.variant, { id }));
          invalidateWork(qc);
          undoToast(t);
          return t;
        } catch (e) {
          return fail(e);
        }
      },

      async setSuspect(id: string, suspect: boolean) {
        try {
          const v = await api.patch<VariantDetail>(path(API.variant, { id }), { suspect });
          qc.setQueryData(["variant", id], v);
          invalidateWork(qc);
          return v;
        } catch (e) {
          return fail(e);
        }
      },

      async revise(variantId: string, request: string) {
        try {
          const r = await api.post<GenerateResponse>(path(API.variantRevise, { id: variantId }), { request });
          invalidateWork(qc);
          void qc.invalidateQueries({ queryKey: ["queue"] });
          toast({ tone: r.queued.length ? "success" : "error", message: r.queued.length ? toastText("reviseQueued") : `${toastText("reviseFailed")}${skippedText(r.skipped)}` });
          return r;
        } catch (e) {
          return fail(e);
        }
      },

      /**
       * Dosyayı doğrudan listeye alır (sahip kararı 2026-11-24): önizleme, sonra üretimsiz kayıt (`generate: false`).
       * Sorunlu satırlar iş olur ve kartta uyarıyla görünür; tekrarlar ve metinsiz satırlar sunucunun önizlemede
       * dediği gibi alınmaz. Metin alanı bulunamazsa ya da hiçbir satır alınmazsa bildirimde "Ayrıntılı içe aktar".
       */
      async upload(src: UploadSource, languageId: string, openDesk: (file: File) => void) {
        const desk = { label: uploadText("detailed"), run: () => openDesk(src.file) };
        const read = await readImportFile(src.file);
        if (!read.ok) {
          toast({ tone: "error", message: fileProblemText(read.problem, src.file.name) });
          return null;
        }
        try {
          const preview = await api.post<ImportPreviewResponse>(API.importPreview, previewBody(src.file.name, read.content, languageId));
          const plan = uploadPlan(preview);
          if (plan.kind !== "commit") {
            toast({ tone: "error", message: plan.kind === "no-text" ? uploadText("noText") : uploadText("nothing"), action: desk });
            return null;
          }
          const r = await api.post<ImportCommitResponse>(API.importCommit, plan.body);
          invalidateWork(qc);
          const left = plan.duplicates + plan.blank;
          toast({
            tone: "success",
            message: `${uploadText("added", { count: r.created })}${left ? ` ${uploadText("skipped", { count: left })}` : ""}`,
            ...(left ? { action: desk } : {}),
          });
          return r;
        } catch (e) {
          return fail(e);
        }
      },
    };
  }, [qc, toast]);
}
