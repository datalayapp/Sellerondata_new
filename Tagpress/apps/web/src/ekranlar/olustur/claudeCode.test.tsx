// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mockFetch, render, waitFor } from "../../tezgah/test/render.tsx";
import { ClaudeCodePenceresi } from "./ClaudeCode.tsx";

const SESSION = "/api/languages/lav/design-session";
const noop = () => {};

describe("Claude Code penceresi: oturum durumu", () => {
  it("durumu ve son kayıtları en yenisi üstte gösterir", async () => {
    mockFetch({
      [SESSION]: {
        status: "asking",
        updatedAt: "2026-11-22T10:05:00.000Z",
        entries: [
          { at: "2026-11-22T10:00:00.000Z", kind: "question", text: "Başlıkta hangi font?" },
          { at: "2026-11-22T10:05:00.000Z", kind: "draft-write", text: "Font yazıldı", paths: ["fonts.primary"] },
        ],
      },
    });
    const r = await render(<ClaudeCodePenceresi languageId="lav" refCount={2} hasDraft={false} onGo={noop} onClose={noop} />);
    const items = await waitFor(() => {
      const li = document.querySelectorAll(".ol-cc-oturum li");
      return li.length === 2 ? li : null;
    });
    expect(document.querySelector(".ol-cc-oturum header")?.textContent).toContain("Soru soruyor");
    expect(items[0]?.textContent).toContain("Taslağa yazıldı");
    expect(items[0]?.textContent).toContain("Font yazıldı");
    expect(items[1]?.textContent).toContain("Claude sordu");
    await r.unmount();
  });

  it("oturum yoksa boş durumu, uç yoksa bağlı değil notunu gösterir", async () => {
    mockFetch({ [SESSION]: { status: "idle", updatedAt: null, entries: [] } });
    let r = await render(<ClaudeCodePenceresi languageId="lav" refCount={0} hasDraft={false} onGo={noop} onClose={noop} />);
    await waitFor(() => document.querySelector(".ol-cc-oturum p")?.textContent?.includes("Henüz bir oturum başlamadı"));
    await r.unmount();

    mockFetch({});
    r = await render(<ClaudeCodePenceresi languageId="lav" refCount={0} hasDraft={false} onGo={noop} onClose={noop} />);
    await waitFor(() => document.querySelector(".ol-cc-oturum p")?.textContent?.includes("Oturum izleme ucu sunucuda yok"));
    await r.unmount();
  });
});
