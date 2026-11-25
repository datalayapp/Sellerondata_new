import { API, type LearnProposal, type Profile, type ProfileRecord, type ProfileVersionSummary, type Reference } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { tt } from "../dil.ts";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, ApiFailure, path, withQuery } from "../../../lib/api.ts";
import { diffLeaves, planEdit } from "./profilePath.ts";

/**
 * Bir tasarım dilinin çalışma kopyası: yayınlanmış profil + (varsa) taslak. Kurallar düzenlendikçe taslak
 * kendiliğinden kaydedilir (bekletmeli). Doğrulama hataları alan yoluyla `errors` içinde tutulur.
 */

export const SAVE_DELAY_MS = 700;

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface Work {
  languageId: string;
  loading: boolean;
  loadError: string | null;
  /** Yayınlanmış (etkin) sürüm. */
  active: ProfileRecord | null;
  /** Sunucudaki taslak. */
  draft: ProfileRecord | null;
  /** Ekranda düzenlenen kopya: yerel değişiklik > taslak > yayınlanmış. */
  value: Profile | null;
  /** Taslak var mı (sunucuda ya da henüz kaydedilmemiş yerel değişiklik). */
  hasDraft: boolean;
  /** Etkin sürümden farklı alan sayısı. */
  changedCount: number;
  save: SaveState;
  /** Alan yolu → hata iletisi (sunucu doğrulaması). */
  errors: Record<string, string>;
  generalError: string | null;
  edit: (path: string, value: unknown) => void;
  editMany: (changes: Array<{ path: string; value: unknown }>) => void;
  /** Bekleyen kaydı hemen yapar. */
  flush: () => Promise<void>;
  publish: (note: string) => Promise<ProfileRecord>;
  discard: () => Promise<void>;
}

const Ctx = createContext<Work | null>(null);

export function useWork(): Work {
  const w = useContext(Ctx);
  if (!w) throw new Error("WorkProvider yok");
  return w;
}

export function WorkProvider({ languageId, children }: { languageId: string; children: ReactNode }) {
  const qc = useQueryClient();

  const activeQ = useQuery({
    queryKey: ["profile", languageId],
    queryFn: () => api.get<ProfileRecord>(path(API.profile, { lang: languageId })),
    retry: false,
  });
  const draftQ = useQuery({
    queryKey: ["profileDraft", languageId],
    queryFn: () => api.get<ProfileRecord | null>(path(API.profileDraft, { lang: languageId })),
    retry: false,
  });

  const [local, setLocal] = useState<Profile | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const latest = useRef<Profile | null>(null);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  // Dil değişince yerel durum sıfırlanır.
  useEffect(() => {
    setLocal(null);
    latest.current = null;
    setErrors({});
    setGeneralError(null);
    setSave("idle");
  }, [languageId]);

  const base = draftQ.data?.data ?? activeQ.data?.data ?? null;
  const value = local ?? base;

  const doSave = useCallback(async () => {
    timer.current = null;
    const data = latest.current;
    if (!data) return;
    setSave("saving");
    const run = (async () => {
      try {
        const rec = await api.put<ProfileRecord>(path(API.profileDraft, { lang: languageId }), { data });
        qc.setQueryData(["profileDraft", languageId], rec);
        void qc.invalidateQueries({ queryKey: ["languages"] });
        setErrors({});
        setGeneralError(null);
        setSave("saved");
        // Bu arada yeni düzenleme yoksa sunucudaki kopyayı izlemeye dön.
        if (latest.current === data) {
          latest.current = null;
          setLocal(null);
        }
      } catch (e) {
        setSave("error");
        if (e instanceof ApiFailure && e.body.fields?.length) {
          setErrors(Object.fromEntries(e.body.fields.map((f) => [f.path, f.message])));
          setGeneralError(e.body.error);
        } else {
          setGeneralError(serverText(e));
        }
      }
    })();
    inFlight.current = run;
    await run;
    if (inFlight.current === run) inFlight.current = null;
  }, [languageId, qc]);

  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void doSave(), SAVE_DELAY_MS);
  }, [doSave]);

  const editMany = useCallback(
    (changes: Array<{ path: string; value: unknown }>) => {
      const cur = latest.current ?? local ?? base;
      if (!cur) return;
      // Yalnızca gerçekten değişen bir alan taslağı doğurur; ilk yükleme/normalize/varsayılan doldurma kayıt tetiklemez.
      const plan = planEdit(cur, activeQ.data?.data ?? null, !!draftQ.data, changes);
      if (plan.kind === "none") return;
      if (plan.kind === "revert") {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        latest.current = null;
        setLocal(null);
        setSave("idle");
        return;
      }
      const next = plan.next;
      latest.current = next;
      setLocal(next);
      setErrors((e) => {
        if (Object.keys(e).length === 0) return e;
        const copy = { ...e };
        for (const c of changes) for (const k of Object.keys(copy)) if (k === c.path || k.startsWith(`${c.path}.`)) delete copy[k];
        return copy;
      });
      setSave("idle");
      schedule();
    },
    [local, base, schedule, activeQ.data, draftQ.data],
  );
  const edit = useCallback((p: string, v: unknown) => editMany([{ path: p, value: v }]), [editMany]);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      await doSave();
    } else if (inFlight.current) await inFlight.current;
  }, [doSave]);

  // Ekrandan çıkarken bekleyen değişiklik kaybolmasın.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  const publish = useCallback(
    async (note: string) => {
      await flush();
      if (latest.current) throw new Error(tt("designLanguageLab:work.draftNotSaved"));
      const rec = await api.post<ProfileRecord>(path(API.profilePublish, { lang: languageId }), { note: note.trim() || undefined });
      qc.setQueryData(["profileDraft", languageId], null);
      qc.setQueryData(["profile", languageId], rec);
      setLocal(null);
      void qc.invalidateQueries({ queryKey: ["profileVersions"] });
      void qc.invalidateQueries({ queryKey: ["languages"] });
      return rec;
    },
    [flush, languageId, qc],
  );

  const discard = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    latest.current = null;
    await api.del(path(API.profileDraft, { lang: languageId }));
    qc.setQueryData(["profileDraft", languageId], null);
    setLocal(null);
    setErrors({});
    setGeneralError(null);
    setSave("idle");
    void qc.invalidateQueries({ queryKey: ["languages"] });
  }, [languageId, qc]);

  const hasDraft = !!draftQ.data || !!local;
  const changedCount = useMemo(() => (activeQ.data && value ? diffLeaves(activeQ.data.data, value).length : 0), [activeQ.data, value]);

  const w: Work = {
    languageId,
    loading: activeQ.isLoading || draftQ.isLoading,
    loadError: !value && (activeQ.error || draftQ.error) ? serverText(activeQ.error ?? draftQ.error) : null,
    active: activeQ.data ?? null,
    draft: draftQ.data ?? null,
    value,
    hasDraft,
    changedCount,
    save,
    errors,
    generalError,
    edit,
    editMany,
    flush,
    publish,
    discard,
  };
  return <Ctx.Provider value={w}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------- ortak sorgular

export function useReferences(languageId: string) {
  return useQuery({
    queryKey: ["references", languageId],
    queryFn: () => api.get<{ references: Reference[] }>(withQuery(API.references, { languageId })).then((r) => r.references),
  });
}

export function useProposals(languageId: string, status?: "open" | "accepted" | "rejected") {
  return useQuery({
    queryKey: ["proposals", languageId, status ?? "all"],
    queryFn: () => api.get<{ proposals: LearnProposal[] }>(withQuery(API.learnProposals, { languageId, status })).then((r) => r.proposals),
  });
}

export function useVersions(languageId: string) {
  return useQuery({
    queryKey: ["profileVersions", languageId],
    queryFn: () => api.get<{ versions: ProfileVersionSummary[] }>(path(API.profileVersions, { lang: languageId })).then((r) => r.versions),
  });
}
