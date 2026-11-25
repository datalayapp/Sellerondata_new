// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { setTestLocale } from "../../i18n/test.ts";
import { press, render } from "../test/render.tsx";
import "./genel.ts";
import { ariaKeys, defineCommands, formatSpec, matchSpec, useCommands } from "./kayit.ts";

/**
 * Klavye düzenleri: simge tuşları üretilen karakterle (`e.key`) eşleşir; harf, rakam ve `mod+`/`alt+` fiziksel kalır.
 * Olaylar her düzende o tuşa basınca tarayıcının verdiği `key` / `code` / değiştirici üçlüsüdür (Windows).
 */

interface Ev {
  key: string;
  code: string;
  shift?: boolean;
  /** AltGr: Windows'ta Ctrl + Alt. */
  altGr?: boolean;
}

const ev = ({ key, code, shift = false, altGr = false }: Ev) =>
  new KeyboardEvent("keydown", { key, code, shiftKey: shift, ctrlKey: altGr, altKey: altGr, bubbles: true, cancelable: true });

type Layout = Record<string, Ev>;

const US: Layout = {
  "-": { key: "-", code: "Minus" },
  "=": { key: "=", code: "Equal" },
  "[": { key: "[", code: "BracketLeft" },
  "]": { key: "]", code: "BracketRight" },
  ",": { key: ",", code: "Comma" },
  ".": { key: ".", code: "Period" },
  "/": { key: "/", code: "Slash" },
  "?": { key: "?", code: "Slash", shift: true },
  "5": { key: "5", code: "Digit5" },
  "shift+1": { key: "!", code: "Digit1", shift: true },
  "shift+2": { key: "@", code: "Digit2", shift: true },
  "shift+0": { key: ")", code: "Digit0", shift: true },
};

/** Türkçe Q: "=" Shift 0, "+" Shift 4, "[ ]" AltGr 8/9, "/" Shift 7, "?" Shift *, "-" ve "." kendi tuşunda. */
const TR_Q: Layout = {
  "-": { key: "-", code: "Equal" },
  "=": { key: "=", code: "Digit0", shift: true },
  "[": { key: "[", code: "Digit8", altGr: true },
  "]": { key: "]", code: "Digit9", altGr: true },
  ",": { key: ",", code: "Backslash" },
  ".": { key: ".", code: "Slash" },
  "/": { key: "/", code: "Digit7", shift: true },
  "?": { key: "?", code: "Minus", shift: true },
  "5": { key: "5", code: "Digit5" },
  "shift+1": { key: "!", code: "Digit1", shift: true },
  "shift+2": { key: "'", code: "Digit2", shift: true },
  "shift+0": { key: "=", code: "Digit0", shift: true },
};

/** Türkçe F: rakam sırası Q ile benzer; "[ ]" AltGr 8/9, "/" ve "?" farklı tuşlarda. */
const TR_F: Layout = {
  "-": { key: "-", code: "Equal" },
  "=": { key: "=", code: "Digit0", shift: true },
  "[": { key: "[", code: "Digit8", altGr: true },
  "]": { key: "]", code: "Digit9", altGr: true },
  ",": { key: ",", code: "Backslash" },
  ".": { key: ".", code: "Slash" },
  "/": { key: "/", code: "Digit7", shift: true },
  "?": { key: "?", code: "Minus", shift: true },
  "5": { key: "5", code: "Digit5" },
  "shift+1": { key: "!", code: "Digit1", shift: true },
  "shift+2": { key: '"', code: "Digit2", shift: true },
  "shift+0": { key: "=", code: "Digit0", shift: true },
};

const SPECS = ["-", "=", "[", "]", ",", ".", "/", "?", "1-9", "shift+1", "shift+2", "shift+0"];
/** Tablodaki her olay hangi tanımlarla eşleşmeli (beklenen). Türkçe'de Shift 0 hem "=" hem "shift+0"dır. */
const EXPECT: Record<string, Record<string, string[]>> = {
  US: { "-": ["-"], "=": ["="], "[": ["["], "]": ["]"], ",": [","], ".": ["."], "/": ["/"], "?": ["?"], "5": ["1-9"], "shift+1": ["shift+1"], "shift+2": ["shift+2"], "shift+0": ["shift+0"] },
  TR_Q: { "-": ["-"], "=": ["=", "shift+0"], "[": ["["], "]": ["]"], ",": [","], ".": ["."], "/": ["/"], "?": ["?"], "5": ["1-9"], "shift+1": ["shift+1"], "shift+2": ["shift+2"], "shift+0": ["=", "shift+0"] },
};
EXPECT.TR_F = EXPECT.TR_Q!;

afterEach(() => setTestLocale("tr"));

describe.each([
  ["US", US],
  ["TR_Q", TR_Q],
  ["TR_F", TR_F],
] as const)("%s düzeni", (name, layout) => {
  it.each(Object.keys(layout))("%s tuşu yalnız beklenen tanımlarla eşleşir", (k) => {
    const e = ev(layout[k]!);
    const hits = SPECS.filter((s) => matchSpec(s, e));
    expect(hits).toEqual(EXPECT[name]![k]);
  });

  it("mod+ ve harf fiziksel: Ctrl S, Ctrl = (Türkçe'de Ctrl Shift 0) eşleşir", () => {
    expect(matchSpec("mod+s", new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true }))).toBe(true);
    const eq = layout["="]!;
    expect(matchSpec("mod+=", new KeyboardEvent("keydown", { key: "=", code: eq.code, shiftKey: !!eq.shift, ctrlKey: true }))).toBe(true);
    // AltGr ile yazılan simge Ctrl'lu komut sayılmaz
    expect(matchSpec("mod+[", ev(layout["["]!))).toBe(false);
  });
});

// Dağıtıcı: aynı olay hem "=" (Düzelt: büyüt) hem "shift+0" (tuval: gerçek boyut) ile eşleşince karakter kazanır.
defineCommands([
  { id: "duzelt.testBuyut", scope: "duzelt", keys: ["="], group: "shortcuts:groups.general", repeat: true },
  { id: "duzelt.testKalin", scope: "duzelt", keys: ["]"], group: "shortcuts:groups.general" },
]);
for (const lng of ["tr", "en"]) {
  i18n.addResource(lng, "adjust", "shortcuts.testBuyut", "+");
  i18n.addResource(lng, "adjust", "shortcuts.testKalin", "]");
}

function Duzelt({ log }: { log: string[] }) {
  useCommands("tuval", { "canvas.actual": () => log.push("actual"), "canvas.fit": () => log.push("fit") });
  useCommands("duzelt", { "duzelt.testBuyut": () => log.push("buyut"), "duzelt.testKalin": () => log.push("kalin") });
  return null;
}

describe("dağıtıcı: karakter eşleşmesi fiziksel eşleşmenin önüne geçer", () => {
  it("Türkçe Q: Shift 0 (=) büyütür, gerçek boyuta düşmez; AltGr 9 (]) kalınlaştırır; Shift 1 sığdırır", async () => {
    const log: string[] = [];
    const r = await render(<Duzelt log={log} />);
    await press("=", { code: "Digit0", shiftKey: true });
    await press("]", { code: "Digit9", ctrlKey: true, altKey: true });
    await press("!", { code: "Digit1", shiftKey: true });
    expect(log).toEqual(["buyut", "kalin", "fit"]);
    await r.unmount();
  });

  it("ABD: Shift 0 ()) gerçek boyut; = büyütür", async () => {
    const log: string[] = [];
    const r = await render(<Duzelt log={log} />);
    await press(")", { code: "Digit0", shiftKey: true });
    await press("=", { code: "Equal" });
    expect(log).toEqual(["actual", "buyut"]);
    await r.unmount();
  });
});

describe("tuş yazımı", () => {
  it("simge olduğu gibi gösterilir (Shift eklenmez); aria da öyle", () => {
    expect(formatSpec("=")).toBe("=");
    expect(formatSpec("shift+?")).toBe("?");
    expect(formatSpec("mod+=")).toBe("Ctrl =");
    expect(formatSpec("[")).toBe("[");
    expect(ariaKeys(["shift+?"])).toBe("?");
    expect(formatSpec("shift+0")).toBe("Shift 0");
  });
});
