import {
  BUILDER_API,
  type Build,
  type BuildCreate,
  type BuildEstimate,
  type BuildEstimateRequest,
  type BuildIntake,
  type BuildMessage,
  type BuildMessageResponse,
  type BuildMessagesResponse,
  type BuildQuality,
  type BuildTryRequest,
  type ProfileRecord,
  type ProfileTryResponse,
  type RevisionDetail,
  type RevisionListResponse,
  type Sample,
  type SamplePatch,
  type SampleUpload,
  type SampleUploadResponse,
  type ShowcaseResponse,
} from "@tagpress/domain";
import { api, path, withQuery } from "../../lib/api.ts";

/** Oluşturucu uçları (`BUILDER_API`, sözleşme `packages/domain/src/builder-api.ts`). Yol şablonu sözleşmeden okunur. */
const p = (r: { path: string }, params?: Record<string, string | number>) => path(r.path, params);
const id_ = (id: string) => ({ id });

export const builderApi = {
  estimate: (body: BuildEstimateRequest) => api.post<BuildEstimate>(p(BUILDER_API.estimate), body),
  current: (lang: string) => api.get<Build | null>(p(BUILDER_API.currentBuild, { lang })),
  create: (lang: string, body: BuildCreate) => api.post<Build>(p(BUILDER_API.createBuild, { lang }), body),
  get: (id: string) => api.get<Build>(p(BUILDER_API.getBuild, id_(id))),
  messages: (id: string, after: number) => api.get<BuildMessagesResponse>(withQuery(p(BUILDER_API.listMessages, id_(id)), { after, limit: 500 })),
  post: (id: string, body: BuildMessage) => api.post<BuildMessageResponse>(p(BUILDER_API.postMessage, id_(id)), body),
  intake: (id: string, body: BuildIntake) => api.put<Build>(p(BUILDER_API.putIntake, id_(id)), body),
  upload: (id: string, body: SampleUpload) => api.post<SampleUploadResponse>(p(BUILDER_API.uploadSamples, id_(id)), body),
  patchSample: (id: string, sid: string, body: SamplePatch) => api.patch<Sample>(p(BUILDER_API.patchSample, { id, sid }), body),
  deleteSample: (id: string, sid: string) => api.del<{ ok: true }>(p(BUILDER_API.deleteSample, { id, sid })),
  skip: (id: string) => api.post<Build>(p(BUILDER_API.skipSamples, id_(id))),
  analyze: (id: string) => api.post<Build>(p(BUILDER_API.analyze, id_(id))),
  cancel: (id: string) => api.post<Build>(p(BUILDER_API.cancel, id_(id))),
  resume: (id: string) => api.post<Build>(p(BUILDER_API.resume, id_(id))),
  raise: (id: string) => api.post<Build>(p(BUILDER_API.raiseBudget, id_(id))),
  close: (id: string) => api.post<Build>(p(BUILDER_API.close, id_(id))),
  revisions: (id: string) => api.get<RevisionListResponse>(p(BUILDER_API.revisions, id_(id))),
  revision: (id: string, rev: number) => api.get<RevisionDetail>(p(BUILDER_API.revision, { id, rev })),
  showcase: (id: string, rev: number, locale: "tr" | "en") => api.get<ShowcaseResponse>(withQuery(p(BUILDER_API.showcase, { id, rev }), { locale })),
  tryText: (id: string, body: BuildTryRequest) => api.post<ProfileTryResponse>(p(BUILDER_API.tryText, id_(id)), body),
  restore: (id: string, rev: number) => api.post<RevisionDetail>(p(BUILDER_API.restore, id_(id)), { rev }),
  /** `overwrite`: oturum sürerken dil başka yerden değiştiyse (409 `build-base-changed`) kullanıcı onayıyla yine de yayınla. */
  publish: (id: string, note: string, overwrite = false) =>
    api.post<ProfileRecord>(p(BUILDER_API.publish, id_(id)), { ...(note.trim() ? { note: note.trim() } : {}), ...(overwrite ? { overwrite: true } : {}) }),
  quality: (id: string, rev: number) => api.get<BuildQuality>(withQuery(p(BUILDER_API.quality, id_(id)), { rev })),
  streamUrl: (id: string) => p(BUILDER_API.stream, id_(id)),
};

/** Sorgu anahtarları: hepsi `["build", dil, …]` altında (dil değişince ya da tazelemede birlikte). */
export const keys = {
  current: (lang: string) => ["build", lang, "current"] as const,
  estimate: (lang: string, samples: number) => ["build", lang, "estimate", samples] as const,
  messages: (lang: string, id: string) => ["build", lang, id, "messages"] as const,
  revisions: (lang: string, id: string) => ["build", lang, id, "revisions"] as const,
  revision: (lang: string, id: string, rev: number) => ["build", lang, id, "rev", rev] as const,
  showcase: (lang: string, id: string, rev: number, locale: string) => ["build", lang, id, "showcase", rev, locale] as const,
  quality: (lang: string, id: string, rev: number) => ["build", lang, id, "quality", rev] as const,
};

/** Dosyayı base64'e çevirir (data: öneki yok). */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
