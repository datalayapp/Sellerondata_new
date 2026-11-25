// @vitest-environment happy-dom
import { ProfileSchema, type Profile, type ProfileRecord } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestLocale } from "../../i18n/test.ts";
import { parseHash } from "../../lib/route.ts";
import { click, flush, mockFetch, press, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import TasarimDiliEkrani from "./index.tsx";

/** Yalnız yanıt şekli: iş kuralı yok. */
const LANGS = [{ id: "dil-1", name: "GiftUp", activeVersion: 3, hasDraft: false, templateCount: 0, isDefault: true, createdAt: "2026-10-01T00:00:00Z" }];
const BASE: Profile = ProfileSchema.parse({
  name: "GiftUp",
  fonts: {
    mixing: "single",
    list: [
      { id: "Ana/Regular", family: "Ana", kind: "script", roles: ["primary"], file: "ana.ttf" },
      { id: "Sembol/Regular", family: "Sembol", kind: "serif", roles: [] },
    ],
  },
  glyphRules: [{ id: "g1", match: { type: "chars", chars: "&" }, fontId: "Sembol/Regular", scale: 0.5 }],
});
const rec = (data: Profile, over: Partial<ProfileRecord> = {}): ProfileRecord => ({ id: "p", languageId: "dil-1", version: 3, status: "published", data, note: "", createdAt: "2026-11-01T10:00:00Z", ...over });
const VERSIONS = [
  { version: 3, status: "published", note: "Üçüncü", createdAt: "2026-11-03T10:00:00Z", publishedAt: "2026-11-03T10:00:00Z", active: true },
  { version: 2, status: "published", note: "İkinci", createdAt: "2026-11-02T10:00:00Z", publishedAt: "2026-11-02T10:00:00Z", active: false },
  { version: 1, status: "published", note: "", createdAt: "2026-11-01T10:00:00Z", publishedAt: "2026-11-01T10:00:00Z", active: false },
];

let calls: ReturnType<typeof mockFetch>["calls"];
let draft: ProfileRecord | null;

function kur(opts: { draft?: ProfileRecord | null } = {}) {
  draft = opts.draft ?? null;
  calls = mockFetch({
    "/api/languages": { languages: LANGS },
    "/api/languages/dil-1/profile": rec(BASE),
    "/api/languages/dil-1/profile/draft": (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { data: Profile };
        draft = rec(body.data, { status: "draft", version: 4 });
      }
      if (init?.method === "DELETE") draft = null;
      return draft;
    },
    "/api/languages/dil-1/profile/publish": rec(BASE, { version: 4 }),
    "/api/languages/dil-1/profile/versions": { versions: VERSIONS },
    "/api/languages/dil-1/profile/diff": { from: 2, to: 3, changes: [{ path: "sizing.fill", from: 0.9, to: 0.95 }] },
    "/api/languages/dil-1/profile/revert": rec(BASE, { version: 4 }),
    "/api/references": { references: [] },
    "/api/learn/proposals": { proposals: [] },
    "/api/languages/dil-1/fonts": { files: [], missing: [] },
  }).calls;
}

beforeEach(() => kur());
afterEach(() => {
  document.body.innerHTML = "";
  setTestLocale("tr");
});

async function ac(hash: string): Promise<Rendered> {
  const r = await render(<TasarimDiliEkrani route={parseHash(hash)} go={() => {}} />);
  await waitFor(() => document.querySelector(".tz-btabs"));
  await flush(4);
  return r;
}

const dugme = (text: string, root: ParentNode = document.body) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const sekme = () => document.querySelector(".tz-btabs [aria-selected=true]")?.textContent;

describe("Tasarım dili: çerçeve ve rota", () => {
  it("iş satırında yalnız dilin adı ve yedi sekme (Dene düğmesi yok); rota sekmeyi ve grubu seçer", async () => {
    const r = await ac("#/tasarim-dili/kurallar/boyut");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toBe("GiftUp");
    expect([...document.querySelectorAll(".tz-ctx .tz-cb")].map((b) => b.textContent?.trim())).not.toContain("Dene");
    expect([...document.querySelectorAll(".tz-btabs [role=tab]")].map((t) => t.textContent)).toEqual(["Özet", "Kurallar", "Dene", "Örnekler", "Öğren", "Sürümler", "Oluştur"]);
    expect(sekme()).toBe("Kurallar");
    expect(document.querySelector(".tz-lr-b[aria-current]")?.textContent).toBe("Boyut ve doluluk");
    expect(document.querySelector('[data-field="sizing.fill"]')).not.toBeNull();
    await r.unmount();
  });

  it("bilinmeyen bölüm Özet'e, bilinmeyen grup Genel'e düşer", async () => {
    let r = await ac("#/tasarim-dili/yok");
    expect(sekme()).toBe("Özet");
    await r.unmount();
    r = await ac("#/tasarim-dili/kurallar/yok");
    expect(document.querySelector(".tz-lr-b[aria-current]")?.textContent).toBe("Genel");
    await r.unmount();
  });

  it("sekmeye tıklayınca rota değişir", async () => {
    const gidilen: Array<[string, string[] | undefined]> = [];
    const r = await render(<TasarimDiliEkrani route={parseHash("#/tasarim-dili/kurallar/fontlar")} go={(id, rest) => gidilen.push([id, rest])} />);
    await waitFor(() => document.querySelector(".tz-btabs"));
    await click(document.querySelector<HTMLElement>('.tz-btabs [data-tab-id="surumler"]')!);
    await click(document.querySelector<HTMLElement>('.tz-btabs [data-tab-id="kurallar"]')!);
    expect(gidilen).toEqual([
      ["tasarim-dili", ["surumler"]],
      ["tasarim-dili", ["kurallar", "fontlar"]],
    ]);
    await r.unmount();
  });

  it("rota doğru bölümü açar: Dene, Örnekler, Öğren", async () => {
    const want: Array<[string, string, string]> = [
      ["dene", "Dene", "Deneme kümesi"],
      ["ornekler", "Örnekler", "Henüz örnek yok"],
      ["ogren", "Öğren", "Henüz öneri yok"],
    ];
    for (const [s, tab, text] of want) {
      const r = await ac(`#/tasarim-dili/${s}`);
      expect(sekme(), s).toBe(tab);
      await waitFor(() => document.body.textContent?.includes(text));
      await r.unmount();
    }
  });

  it("ekranda en çok bir birincil düğme ve her ikon düğmesinin adı var", async () => {
    for (const hash of ["#/tasarim-dili/ozet", "#/tasarim-dili/kurallar/ozel-karakterler", "#/tasarim-dili/kurallar/fontlar", "#/tasarim-dili/surumler", "#/tasarim-dili/dene", "#/tasarim-dili/ornekler", "#/tasarim-dili/ogren"]) {
      const r = await ac(hash);
      expect(document.querySelectorAll(".tz-btn--primary").length, hash).toBeLessThanOrEqual(1);
      for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b")) expect(b.getAttribute("aria-label") || b.textContent?.trim(), `${hash} ${b.outerHTML.slice(0, 90)}`).toBeTruthy();
      await r.unmount();
    }
  });
});

describe("Tasarım dili: Özet", () => {
  it("dilin okunur kurallarını iki sütunda gruplar hâlinde yazar; her grupta Düzenle", async () => {
    const gidilen: string[][] = [];
    const r = await render(<TasarimDiliEkrani route={parseHash("#/tasarim-dili/ozet")} go={(_id, rest) => gidilen.push(rest ?? [])} />);
    await waitFor(() => document.querySelector(".td-ozet-grup"));
    expect(document.querySelector(".td-ozet-kurallar")?.textContent).toContain("Yazı alanın %90'ı kadarını doldurur");
    expect(document.querySelector(".td-baslik")?.textContent).toBe("GiftUp");
    const acBtns = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Düzenle");
    expect(acBtns.length).toBeGreaterThanOrEqual(10);
    await click(acBtns.find((b) => b.getAttribute("aria-label") === "Düzenle: Boyut ve doluluk")!);
    expect(gidilen.at(-1)).toEqual(["kurallar", "boyut"]);
    await r.unmount();
  });
});

describe("Tasarım dili: Kurallar", () => {
  it("bir alanı değiştirmek taslağı kaydeder", async () => {
    const r = await ac("#/tasarim-dili/kurallar/boyut");
    const adim = document.querySelector<HTMLElement>('[data-field="sizing.fill"] [role=spinbutton]')!;
    await press("ArrowUp", { target: adim });
    const put = await waitFor(() => calls.find((c) => c.method === "PUT" && c.url.includes("/profile/draft")));
    expect((put.body as { data: Profile }).data.sizing.fill).toBeCloseTo(0.91);
    expect((put.body as { data: Profile }).data.sizing.tiers).toEqual(BASE.sizing.tiers);
    await r.unmount();
  });

  it("değişen alan işaretlenir, grup sayacı artar ve iş satırı taslağı söyler", async () => {
    const edited = { ...BASE, sizing: { ...BASE.sizing, fill: 0.95 } };
    kur({ draft: rec(edited, { status: "draft", version: 4 }) });
    const r = await ac("#/tasarim-dili/kurallar/boyut");
    expect(document.querySelector('[data-field="sizing.fill"]')?.classList.contains("is-degisti")).toBe(true);
    expect(document.querySelector('[data-field="sizing.minPt"]')?.classList.contains("is-degisti")).toBe(false);
    expect(document.querySelector(".td-meta")?.textContent).toContain("Taslak · 1 alan değişti");
    await r.unmount();
  });

  it("alan araması bütün gruplarda arar", async () => {
    const r = await ac("#/tasarim-dili/kurallar/genel");
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await click(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "doluluk");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush(2);
    expect(document.querySelector('[data-field="sizing.fill"]')).not.toBeNull();
    expect(document.querySelector('[data-field="name"]')).toBeNull();
    await r.unmount();
  });

  it("özel düzenleyiciler çizilir: font listesi ve özel karakter kuralı", async () => {
    let r = await ac("#/tasarim-dili/kurallar/fontlar");
    expect(document.querySelector('[data-field="fonts.list"]')?.textContent).toContain("Sembol");
    await r.unmount();
    r = await ac("#/tasarim-dili/kurallar/ozel-karakterler");
    expect(document.querySelector('[data-field="glyphRules"]')?.textContent).toContain("“&” her zaman Sembol ile, yarım boyutta.");
    await r.unmount();
  });
});

describe("Tasarım dili: Yayınla", () => {
  it("taslak yokken taslak durumu, Taslağı at ve Yayınla görünmez", async () => {
    const r = await ac("#/tasarim-dili/ozet");
    expect(document.querySelector("fieldset.td-act")).toBeNull();
    expect(document.querySelector(".td-meta")).toBeNull();
    expect(dugme("Taslağı at")).toBeUndefined();
    await r.unmount();
  });

  it("taslak varken etkin; onay ister, onaylayınca yayınlar", async () => {
    kur({ draft: rec({ ...BASE, sizing: { ...BASE.sizing, fill: 0.95 } }, { status: "draft", version: 4 }) });
    const r = await ac("#/tasarim-dili/ozet");
    expect(document.querySelector("fieldset.td-act")?.hasAttribute("disabled")).toBe(false);
    await click(dugme("Yayınla")!);
    const dialog = await waitFor(() => document.querySelector("dialog"));
    expect(dialog.textContent).toContain("Taslak yayınlansın mı?");
    expect(calls.some((c) => c.url.endsWith("/profile/publish"))).toBe(false);
    await click(dugme("Yayınla", dialog)!);
    const post = await waitFor(() => calls.find((c) => c.url.endsWith("/profile/publish")));
    expect(post.method).toBe("POST");
    await r.unmount();
  });

  it("onaylamazsa yayınlanmaz; Taslağı at da onaylıdır", async () => {
    kur({ draft: rec({ ...BASE, sizing: { ...BASE.sizing, fill: 0.95 } }, { status: "draft", version: 4 }) });
    const r = await ac("#/tasarim-dili/ozet");
    await click(dugme("Yayınla")!);
    const dialog = await waitFor(() => document.querySelector("dialog"));
    await click(dugme("İptal", dialog) ?? dugme("Vazgeç", dialog)!);
    await flush(2);
    expect(calls.some((c) => c.url.endsWith("/profile/publish"))).toBe(false);
    await click(dugme("Taslağı at")!);
    const d2 = await waitFor(() => document.querySelector("dialog"));
    expect(d2.textContent).toContain("Taslak atılsın mı?");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await click(dugme("Taslağı at", d2)!);
    await waitFor(() => calls.find((c) => c.method === "DELETE"));
    await r.unmount();
  });
});

describe("Tasarım dili: Sürümler", () => {
  it("sürüm listesi ve fark; etkin sürüm etiketli", async () => {
    const r = await ac("#/tasarim-dili/surumler");
    await waitFor(() => document.querySelector(".td-sv-fark"));
    const rows = [...document.querySelectorAll(".tz-lr-b .td-sv-kod")].map((b) => b.textContent);
    expect(rows).toEqual(["S.3", "S.2", "S.1"]);
    expect(document.querySelector(".tz-lr-b[aria-current] .tz-dot--ok")).not.toBeNull();
    expect(document.querySelector(".tz-lr-b[aria-current]")?.textContent).toContain("Etkin");
    expect(document.querySelector(".td-sv-fark")?.textContent).toContain("Doluluk");
    expect(document.querySelector(".td-sv-fark")?.textContent).toContain("%90");
    expect(document.querySelector(".td-sv-fark")?.textContent).toContain("%95");
    expect(dugme("Bu sürüme dön")).toBeUndefined();
    await r.unmount();
  });

  it("eski sürüme dönüş onay ister", async () => {
    const r = await ac("#/tasarim-dili/surumler");
    await waitFor(() => document.querySelector(".td-sv-fark"));
    await click([...document.querySelectorAll<HTMLElement>(".tz-lr-b")].find((b) => b.querySelector(".td-sv-kod")?.textContent === "S.2")!);
    await click(dugme("Bu sürüme dön")!);
    const dialog = await waitFor(() => document.querySelector("dialog"));
    expect(dialog.textContent).toContain("Sürüm 2'e dönülsün mü?");
    expect(calls.some((c) => c.url.endsWith("/profile/revert"))).toBe(false);
    await click(dugme("Bu sürüme dön", dialog)!);
    const post = await waitFor(() => calls.find((c) => c.url.endsWith("/profile/revert")));
    expect(post.body).toMatchObject({ version: 2 });
    await waitFor(() => document.body.textContent?.includes("yeni sürüm 4 olarak yayınlandı"));
    await r.unmount();
  });
});

describe("Tasarım dili: hiç dil yoksa", () => {
  it("boş durum ve Yeni tasarım dili", async () => {
    calls = mockFetch({ "/api/languages": { languages: [] } }).calls;
    const r = await render(<TasarimDiliEkrani route={parseHash("#/tasarim-dili")} go={() => {}} />);
    await waitFor(() => document.querySelector(".tz-empty"));
    expect(document.body.textContent).toContain("Henüz bir tasarım dilin yok");
    await click(dugme("Yeni tasarım dili")!);
    expect(document.querySelector("dialog")?.textContent).toContain("Varsayılan değerlerle boş bir dil oluşturulur");
    await r.unmount();
  });
});
