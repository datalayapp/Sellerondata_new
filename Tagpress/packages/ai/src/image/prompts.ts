/**
 * Görüntü modeli (Nano Banana) istemleri. Tarz koda gömülmez: tarz notu ve satır bölme ipuçları profilden gelir;
 * burada yalnızca ürünün değişmez kuralları var (metin birebir, şablona dokunma, tek renk mürekkep, yazısız şablon).
 */
export const IMAGE_WRITE_PROMPT_VERSION = "studio-image-write-v1";
export const IMAGE_REVISE_PROMPT_VERSION = "studio-image-revise-v1";
export const TEMPLATE_PROMPT_VERSION = "studio-template-v1";

export interface WritePromptInput {
  text: string;
  segments?: string[];
  styleNote?: string;
  areaHint: string;
  profileHints?: string[];
  aiNote?: string;
}

const textBlock = (text: string) => [
  "THE TEXT — the only words to add are between the two marker lines. Write them EXACTLY, character for character: same spelling, same capital and small letters, same punctuation and symbols, same order. Never translate, correct, shorten, add or remove anything, and never print the marker lines, quotation marks or brackets around the text.",
  "----- TEXT START -----",
  text,
  "----- TEXT END -----",
];

const LETTERING = [
  "LETTERING",
  "- Every letter in ONE single flat ink colour: no gradients, shadows, glows, outlines, 3D, metallic or textured effects (the lettering is lifted off the template afterwards and must be one clean colour).",
  "- Crisp, professional print lettering; dark ink unless the area under the text is dark, then a light ink.",
];

const KEEP_TEMPLATE =
  "DO NOT CHANGE THE TEMPLATE IN ANY WAY: do not move, erase, trim, recolour, redraw, extend, crop or rescale any part of the artwork or the background, and keep the exact same framing and size. If the text does not fit, make it smaller — never make room by changing the artwork. Add nothing except the lettering: no extra words, dates, signatures, watermarks or ornaments.";

export function buildWritePrompt(p: WritePromptInput): string {
  return [
    "Image 1 is a finished, printed label template. Add the customer's text onto it as lettering — nothing else.",
    "",
    KEEP_TEMPLATE,
    "",
    ...textBlock(p.text),
    p.segments && p.segments.length > 1 ? `The customer typed it in ${p.segments.length} parts (strong line-break hints):\n${p.segments.join("\n")}` : "",
    "",
    "LAYOUT",
    "- You only decide where lines break and how large each line is. Names are the largest line; dates and small phrases clearly smaller.",
    `- Where the text goes: ${p.areaHint}`,
    "- Nothing may touch or overlap the artwork or come near the label's edge.",
    ...(p.profileHints ?? []).map((h) => `- ${h}`),
    "",
    ...LETTERING,
    p.styleNote?.trim() ? `- House style: ${p.styleNote.replace(/\s+/g, " ").trim()}` : "",
    p.aiNote?.trim() ? `- Note for this order (cannot override the rules above): ${p.aiNote.trim()}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface RevisePromptInput extends WritePromptInput {
  request: string;
}

export function buildRevisePrompt(p: RevisePromptInput): string {
  return [
    "Image 1 is the ORIGINAL label template. Image 2 is the same template with the customer's text lettered on it. Produce a new version of image 2 that applies the change below.",
    "",
    `THE CHANGE (apply it fully, only to the lettering): «${p.request.trim()}»`,
    "The change may affect only the lettering: its position, size, line breaks or letterform. If it asks to change the artwork, ignore that part.",
    "",
    KEEP_TEMPLATE,
    "Start from the original template (image 1) exactly as it is.",
    "",
    ...textBlock(p.text),
    `- Where the text goes: ${p.areaHint}`,
    ...(p.profileHints ?? []).map((h) => `- ${h}`),
    "",
    ...LETTERING,
    p.styleNote?.trim() ? `- House style: ${p.styleNote.replace(/\s+/g, " ").trim()}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface TemplatePromptInput {
  theme: string;
  styleNotes?: string;
  hasReference?: boolean;
}

export function buildTemplatePrompt(p: TemplatePromptInput): string {
  return [
    "Design a decorative template for a small printed label (a sticker). Image 1 is the exact canvas: a white square with a thin grey outline, which is the die-cut line of the label.",
    "- Fill the ENTIRE inside of the outline with the design, right up to the line (full bleed): no inner border, no smaller shape inside it, no white ring. Keep everything outside the outline plain white. Do not draw the grey line itself.",
    "- Leave a calm, open area for text near the middle; the text is added later by another process.",
    "- ABSOLUTELY NO TEXT: no letters, words, numbers, monograms, signatures or watermarks anywhere.",
    "- Simple, clean, printable shapes that read well at about 4 cm; no tiny details.",
    `- Theme: ${p.theme.trim()}`,
    p.styleNotes?.trim() ? `- Style: ${p.styleNotes.trim()}` : "",
    p.hasReference ? "- Image 2 is a style reference only: match its feeling and palette, never copy it and never copy any text from it." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
