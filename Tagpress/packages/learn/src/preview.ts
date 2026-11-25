import { existsSync } from "node:fs";
import { type Profile, type Reference, type Template, templateImageBox } from "@tagpress/domain";
import sharp, { type OverlayOptions } from "sharp";
import type { ReplayEnv } from "./env.ts";

/**
 * Önce/sonra önizlemeleri: [kullanıcının son hâli (referans) | önce | sonra] yan yana tek PNG.
 * Kullanıcı paneli = şablon görseli + referansın yazı katmanı görseli (varsa).
 */

const CAPTION_H = 22;

/** Kullanıcının son hâli: şablon + yazı katmanı (tasarım alanı × scale). Görsel yoksa null. */
export async function userPanel(ref: Reference, profile: Profile, template: Template | null, env: ReplayEnv, scale = 0.5): Promise<Buffer | null> {
  const img = env.opts.referenceImagePath?.(ref) ?? null;
  if (!img || !existsSync(img)) return null;
  const size = Math.round(profile.output.designFramePx * scale);
  const layers: OverlayOptions[] = [];
  if (template) {
    const tp = env.opts.templatePath(template);
    if (existsSync(tp)) {
      // Şablona özel kutu; yoksa kendi kesiminin kutusu ya da profilin şablon kutusu (motorla aynı yer).
      const tb = templateImageBox(template, profile);
      const t = await sharp(tp).resize(Math.max(1, Math.round(tb.w * scale)), Math.max(1, Math.round(tb.h * scale)), { fit: "fill" }).png().toBuffer();
      layers.push({ input: t, left: Math.round(tb.x * scale), top: Math.round(tb.y * scale) });
    }
  }
  layers.push({ input: await sharp(img).resize(size, size, { fit: "fill" }).png().toBuffer(), left: 0, top: 0 });
  return sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } }).composite(layers).png().toBuffer();
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** Panelleri yan yana dizer, her birinin üstüne kısa başlık yazar. */
export async function sideBySide(panels: Array<{ label: string; png: Buffer }>): Promise<Buffer> {
  const metas = await Promise.all(panels.map((p) => sharp(p.png).metadata()));
  const h = Math.max(...metas.map((m) => m.height ?? 0));
  const gap = 8;
  const width = metas.reduce((a, m) => a + (m.width ?? 0), 0) + gap * (panels.length - 1);
  const layers: OverlayOptions[] = [];
  let x = 0;
  panels.forEach((p, i) => {
    const w = metas[i]!.width ?? 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${CAPTION_H}"><text x="${w / 2}" y="15" font-family="Segoe UI, Arial, sans-serif" font-size="13" text-anchor="middle" fill="#333">${esc(p.label)}</text></svg>`;
    layers.push({ input: Buffer.from(svg), left: x, top: 0 }, { input: p.png, left: x, top: CAPTION_H });
    x += w + gap;
  });
  return sharp({ create: { width, height: h + CAPTION_H, channels: 4, background: "#ffffff" } }).composite(layers).png().toBuffer();
}

/** Bir referans için [kullanıcı | önce | sonra]. */
export async function comparisonPng(
  ref: Reference,
  env: ReplayEnv,
  before: { profile: Profile; template: Template },
  after: { profile: Profile; template: Template },
  labels: { before: string; after: string } = { before: "Önce", after: "Sonra" },
): Promise<Buffer> {
  const panels: Array<{ label: string; png: Buffer }> = [];
  const user = await userPanel(ref, before.profile, before.template, env);
  if (user) panels.push({ label: "Son hâl (referans)", png: user });
  panels.push({ label: labels.before, png: await env.preview(ref, before.profile, before.template) });
  panels.push({ label: labels.after, png: await env.preview(ref, after.profile, after.template) });
  return sideBySide(panels);
}
