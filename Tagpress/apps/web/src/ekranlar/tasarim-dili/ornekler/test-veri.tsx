import { type ApiError, ProfileSchema, type LearnProposal, type Profile, type ProfileRecord, type Reference } from "@tagpress/domain";
import { parseHash } from "../../../lib/route.ts";
import { flush, mockFetch, render, type Rendered, waitFor } from "../../../tezgah/test/render.tsx";
import TasarimDiliEkrani from "../index.tsx";

/**
 * Tasarım dili B bölümlerinin (Dene, Örnekler, Öğren, Kurallar önizlemesi) ekran testleri için sahte sunucu verisi.
 * Yalnız yanıt şekli: iş kuralı yok. Metinler ASCII (sözlük denetimi test dışı dosyada Türkçe karakter aramasın).
 */

export const LANGS = [{ id: "dil-1", name: "GiftUp", activeVersion: 3, hasDraft: false, templateCount: 0, isDefault: true, createdAt: "2026-10-01T00:00:00Z" }];
export const BASE: Profile = ProfileSchema.parse({ name: "GiftUp" });
export const rec = (data: Profile, over: Partial<ProfileRecord> = {}): ProfileRecord => ({ id: "p", languageId: "dil-1", version: 3, status: "published", data, note: "", createdAt: "2026-11-01T10:00:00Z", ...over });
export const DRAFT = rec({ ...BASE, sizing: { ...BASE.sizing, fill: 0.95 } }, { status: "draft", version: 4 });

const line = (text: string, sizePx: number, y: number) => ({ text, family: "Great Vibes", style: "Regular", sizePx, segments: [{ text, family: "Great Vibes", style: "Regular", sizePx }], ink: { x: 100, y, w: 240, h: sizePx } });

export function ref(id: string, text: string, over: Partial<Reference> = {}): Reference {
  return {
    id,
    languageId: "dil-1",
    source: "figma",
    orderNo: "8812",
    quantity: 60,
    templateKey: "A15",
    labelFramePx: 440,
    text,
    user: [line(text.split(" ")[0] ?? text, 60, 120), line("14.06.2027", 20, 260)],
    program: null,
    programMeta: null,
    image: null,
    split: "train",
    createdAt: "2026-11-01T10:00:00Z",
    ...over,
  };
}

export function proposal(id: string, over: Partial<LearnProposal> = {}): LearnProposal {
  return {
    id,
    languageId: "dil-1",
    status: "open",
    title: `Proposal ${id}`,
    summary: "",
    patch: [{ target: "profile", path: "sizing.fill", from: 0.9, to: 0.95 }],
    evidence: null,
    createdAt: "2026-11-02T10:00:00Z",
    decidedAt: null,
    ...over,
  } as LearnProposal;
}

type Routes = Parameters<typeof mockFetch>[0];

/** Sahte sunucu: dil, profil (taslak isteğe bağlı), örnekler, öneriler (`?status=` süzülür) + ek uçlar. */
export function kur(opts: { draft?: ProfileRecord | null; refs?: Reference[]; proposals?: LearnProposal[]; routes?: Routes } = {}) {
  let draft = opts.draft ?? null;
  const proposals = opts.proposals ?? [];
  return mockFetch({
    "/api/languages": { languages: LANGS },
    "/api/languages/dil-1/profile": rec(BASE),
    "/api/languages/dil-1/profile/draft": (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") draft = rec((JSON.parse(String(init.body)) as { data: Profile }).data, { status: "draft", version: 4 });
      if (init?.method === "DELETE") draft = null;
      return draft;
    },
    "/api/references": { references: opts.refs ?? [] },
    "/api/learn/proposals": (u: string) => {
      const status = new URL(u, "http://x").searchParams.get("status");
      return { proposals: status ? proposals.filter((p) => p.status === status) : proposals };
    },
    "/api/languages/dil-1/learn/run": null,
    "/api/languages/dil-1/templates": { templates: [] },
    ...opts.routes,
  }).calls;
}

/**
 * Verilen uca giden isteği sahte sunucu yine kaydeder, ama yanıt `status` + hata gövdesi olur (`code` domain kataloğundan).
 * `when` verilirse yalnız onu sağlayan isteklerde.
 */
export function hataVer(pathname: string, status: number, body: ApiError, when: (init?: RequestInit) => boolean = () => true) {
  const inner = globalThis.fetch;
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const p = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (p === pathname && when(init)) return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return res;
  };
  globalThis.fetch = Object.assign(fn, { mocked: true }) as unknown as typeof fetch;
}

export async function ac(hash: string, go: (id: string, rest?: string[]) => void = () => {}): Promise<Rendered> {
  const r = await render(<TasarimDiliEkrani route={parseHash(hash)} go={go as never} />);
  await waitFor(() => document.querySelector(".tz-btabs"));
  await flush(4);
  return r;
}

export const dugme = (text: string, root: ParentNode = document.body) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

/** Ekranda en çok bir birincil düğme ve her ikon düğmesinin adı var. */
export function denetle(label: string) {
  const primary = document.querySelectorAll(".tz-btn--primary").length;
  const unnamed = [...document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b")].filter((b) => !(b.getAttribute("aria-label") || b.textContent?.trim())).map((b) => b.outerHTML.slice(0, 90));
  return { label, primary, unnamed };
}

/** Görünür metinle tuvaldeki (dünya katmanı) görsel. */
export const gorsel = (alt: string) => document.querySelector<HTMLImageElement>(`img[alt="${alt.replace(/"/g, '\\"')}"]`);
