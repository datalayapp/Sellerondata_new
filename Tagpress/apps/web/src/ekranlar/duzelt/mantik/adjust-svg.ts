/**
 * Yazı katmanı SVG'sini DOM'a gömmeden önce ayıklar. Kaynak kendi sunucumuz, yine de: betik, gömülü belge, stil, olay öznitelikleri
 * ve dış bağlantılar atılır. Yalnızca çizim öğeleri (g, path, defs, clipPath …) kalır.
 */

const BLOCKED = new Set(["script", "foreignobject", "iframe", "object", "embed", "style", "link", "image", "animate", "set", "animatetransform", "audio", "video"]);

function clean(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (BLOCKED.has(child.localName.toLowerCase())) {
      child.remove();
      continue;
    }
    clean(child);
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim().toLowerCase();
    const isRef = name === "href" || name.endsWith(":href");
    if (name.startsWith("on") || (isRef && !value.startsWith("#")) || /javascript:|data:text\/html/.test(value)) el.removeAttribute(attr.name);
  }
}

/** SVG metninden ayıklanmış iç işaretlemeyi (kök `<svg>` olmadan) döndürür; geçersizse null. */
export function sanitizeSvgInner(text: string): string | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  clean(root);
  const ser = new XMLSerializer();
  return Array.from(root.childNodes)
    .map((n) => ser.serializeToString(n))
    .join("");
}
