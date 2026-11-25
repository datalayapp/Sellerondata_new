import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Tuvalde arayüz çizgileri (seçim çerçevesi, tutamak, kesim çizgisi, kılavuz) yakınlaştırmadan bağımsız ekran
 * kalınlığında kalmalı. Chrome `border` / `outline` kalınlığını en az 1 px'e yuvarlar: dünya katmanında
 * `calc(1px / var(--tz-zoom))` 1 dünya pikseli olur ve yakınlaştırmayla kalınlaşır (%439'da 16 px). SVG'nin
 * `vector-effect: non-scaling-stroke`'u da HTML dönüşümünü dengelemez. Doğrusu: çerçeve `box-shadow` yayılımı
 * (yuvarlanmaz), kutu ve kesikli kenar ters ölçekli katman (`scale(1 / zoom)`), SVG çizgisi `stroke-width: calc(…/zoom)`.
 * Bu test CSS'te yanlış yöntemi yakalar (gerçek tarayıcı ölçümü `docs`/rapor betiğinde).
 */

const ROOTS = ["../", "../../ekranlar/", "../../ortak/"].map((r) => new URL(r, import.meta.url));

function cssFiles(dir: URL): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const child = new URL(name, dir);
    if (statSync(child).isDirectory()) out.push(...cssFiles(new URL(`${name}/`, dir)));
    else if (name.endsWith(".css")) out.push({ path: decodeURIComponent(child.pathname).replace(/^.*\/src\//, "src/"), text: readFileSync(child, "utf8") });
  }
  return out;
}

const files = ROOTS.flatMap(cssFiles);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("tuval çizgileri ekran pikselinde sabit", () => {
  it("border / outline kalınlığı yakınlaştırmaya bölünmez (Chrome 1 px'e yuvarlar)", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const [i, line] of strip(f.text).split("\n").entries()) {
        if (/^\s*(outline|border)[a-z-]*\s*:[^;]*var\(--tz-zoom\)/.test(line)) bad.push(`${f.path}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("non-scaling-stroke kullanılmaz (HTML dönüşümünde işlemez)", () => {
    const bad = files.filter((f) => /vector-effect\s*:\s*non-scaling-stroke/.test(strip(f.text))).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("seçim çerçevesi box-shadow, tutamak ters ölçekli sabit kutu, kesim çizgisi zoom'a bölünür", () => {
    const tuval = strip(files.find((f) => f.path.endsWith("tezgah/tuval/tuval.css"))!.text);
    const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(tuval)?.[1] ?? "";
    // Çerçeve ekran pikselli kutuda (`.tz-wrect`): yayılım 1,5 px, tutamak ve rozet ayrıca ters ölçeklenmez.
    expect(rule(".tz-selbox")).toMatch(/box-shadow:\s*0 0 0 1\.5px /);
    expect(rule(".tz-selbox .tz-hdl")).toMatch(/transform:\s*translate\(-50%, -50%\);/);
    expect(rule(".tz-selbox .tz-szb")).toMatch(/transform:\s*translateX\(-50%\);/);
    const hdl = rule(".tz-hdl");
    expect(hdl).toMatch(/width:\s*9px/);
    expect(hdl).toMatch(/border:\s*1\.5px solid/);
    expect(hdl).toMatch(/scale\(calc\(1 \/ var\(--tz-zoom\)\)\)/);
    expect(tuval).toMatch(/\.tz-cut \*,\s*\.tz-crop \*\s*\{\s*stroke-width:\s*calc\(1px \/ var\(--tz-zoom\)\)/);
  });

  it("hareketli dünya kutusu (.tz-wrect) ekran pikselinde: konum dönüşümle, boyut zoom'la çarpılır (Chrome dünya birimine yuvarlamasın)", () => {
    const tuval = strip(files.find((f) => f.path.endsWith("tezgah/tuval/tuval.css"))!.text);
    const r = /\.tz-wrect\s*\{([^}]*)\}/.exec(tuval)?.[1] ?? "";
    expect(r).toMatch(/left:\s*0;/);
    expect(r).toMatch(/top:\s*0;/);
    expect(r).toMatch(/width:\s*calc\(var\(--tz-w\) \* var\(--tz-zoom\) \* 1px\);/);
    expect(r).toMatch(/height:\s*calc\(var\(--tz-h\) \* var\(--tz-zoom\) \* 1px\);/);
    expect(r).toMatch(/transform-origin:\s*0 0;/);
    expect(r).toMatch(/transform:\s*translate\(calc\(var\(--tz-x\) \* 1px\), calc\(var\(--tz-y\) \* 1px\)\) scale\(calc\(1 \/ var\(--tz-zoom\)\)\);/);
  });

  it("tutamak sınıfı çerçevenin `.tz-hd` (tam bant başlığı) sınıfıyla çakışmaz", () => {
    const tuval = strip(files.find((f) => f.path.endsWith("tezgah/tuval/tuval.css"))!.text);
    expect(/\.tz-hd[\s{.:]/.test(tuval)).toBe(false);
  });
});
