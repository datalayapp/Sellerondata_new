export { type BuiltGeometry, type GeometryOptions, DARK_LIGHTNESS, buildGeometry, clearGeometryCache, imageBoxOf, suggestArea } from "./geometry.ts";
export { type OverlayOptions, renderOverlay } from "./overlay.ts";
export { type TemplateKeyResult, normalizeTemplateKey, templateKeyFromInput } from "./key.ts";
export { WRITABLE_THICKNESS } from "./decoration.ts";
export { STICKER_AREA_RATIO, buildStickerGeometry, stickerAreaShape } from "./sticker.ts";
export {
  ALIGN_LIMITS,
  type AlignOptions,
  type Alignment,
  type AlignmentResult,
  INK_THRESHOLDS,
  type InkLine,
  type InkLinesResult,
  LINE_LIMITS,
  PLAIN_LIMITS,
  type PlainInkResult,
  type RgbImage,
  type TemplateInkResult,
  alignTemplate,
  gapsAbove,
  inkLines,
  paperColor,
  plainInk,
  templateInk,
  unionBoxes,
  warpTemplate,
} from "./ink-lines.ts";
