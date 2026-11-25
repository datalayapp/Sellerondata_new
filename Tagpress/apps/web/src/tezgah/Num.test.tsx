import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Num } from "./Num.tsx";

describe("Num (Tezgâh)", () => {
  it("yalnızca . , : / karakterlerini normal genişliğe alır; rakamlar tablo hizalı kalır", () => {
    const html = renderToStaticMarkup(<Num>01:11 · 3,8 cm</Num>);
    expect(html).toContain('<span class="tz-nn">:</span>');
    expect(html).toContain('<span class="tz-nn">,</span>');
    expect(html.startsWith('<span class="tz-num">01')).toBe(true);
  });
  it("sayı ve eleman çocukları korunur", () => {
    expect(renderToStaticMarkup(<Num>{12}</Num>)).toBe('<span class="tz-num">12</span>');
    expect(
      renderToStaticMarkup(
        <Num>
          <b>x</b>
        </Num>,
      ),
    ).toContain("<b>x</b>");
  });
});
