/**
 * `docs/sunucu-kodlari.md` belgesini `@tagpress/domain` `messages.ts` listesinden üretir (arayüz ekibi için kod →
 * parametre → Türkçe metin tablosu + İngilizce öneri + sözlük dosyası önerisi). Liste değişince yeniden çalıştırın:
 *
 *   node scripts/sunucu-kodlari.ts
 *
 * İngilizce metinler yalnız ÖNERİDİR (arayüz sözlüğüne girince sözlük geçerlidir); sunucu İngilizce metin göndermez.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_MESSAGES, FIX_LABELS, ISSUE_MESSAGES, PRINT_NOTICE_MESSAGES, PRINT_WARNING_MESSAGES, UNDO_MESSAGES, templateParams } from "../packages/domain/src/messages.ts";

const EN_ERRORS: Record<string, string> = {
  "host-not-local": "Only reachable from a local address.",
  "origin-not-allowed": "Access from this origin is not allowed.",
  "studio-header-missing": "Request rejected: the X-Studio header is missing.",
  "not-found": "Not found.",
  "web-not-built": "The interface has not been built.",
  "body-invalid-json": "The request body is not valid JSON.",
  "request-failed": "{detail}",
  "server-error": "Server error: {detail}",
  "request-invalid": "The request is invalid.",
  "query-invalid": "The query is invalid.",
  "version-invalid": "The version is invalid.",
  "version-range-invalid": "The version range is invalid.",
  "learn-request-invalid": "The learning request is invalid.",
  "source-invalid": "The source is invalid.",
  "replay-request-invalid": "The replay request is invalid.",
  "session-invalid": "The session is invalid.",
  "session-entry-invalid": "The session entry is invalid.",
  "draft-patch-invalid": "The draft patch is invalid.",
  "setting-invalid": "The setting is invalid.",
  "feature-invalid": "The feature selection is not valid.",
  "setup-invalid": "The setup answer is not valid.",
  "provider-invalid": "The provider is invalid.",
  "key-invalid": "The key is invalid.",
  "language-package-invalid": "The design language package is invalid.",
  "language-package-profile-invalid": "The profile in the package is invalid.",
  "trial-request-invalid": "The trial request is invalid.",
  "reference-invalid": "The reference is invalid.",
  "proposal-invalid": "The proposal is invalid.",
  "profile-invalid": "The profile is invalid; fix the marked fields.",
  "preset-invalid": "The preset is invalid.",
  "print-template-invalid": "The print template is invalid.",
  "print-template-corrupt": "The print template record is corrupt ({id}).",
  "template-record-invalid": "The template record is invalid.",
  "template-patch-invalid": "The template patch is invalid.",
  "template-fields-readonly": "These fields cannot be changed.",
  "template-key-invalid": 'Invalid template name: "{key}" (letters, digits, - and _).',
  "language-id-invalid": "Invalid design language ID.",
  "language-id-required": "languageId is required.",
  "language-unknown": "No such design language.",
  "preview-width-range": "w must be between 32 and 4000.",
  "file-name-invalid": "Invalid file name.",
  "not-png": "The file is not a PNG.",
  "font-file-type": "The font file must be .ttf, .otf, .woff or .woff2.",
  "font-invalid": "The file is not a valid font.",
  "job-not-found": "Job not found.",
  "jobs-to-delete-not-found": "No jobs to delete were found.",
  "batch-not-found": "Batch not found.",
  "variant-not-found": "Variant not found.",
  "preview-not-found": "Preview not found.",
  "text-layer-not-found": "Text layer not found.",
  "language-not-found": "Design language not found.",
  "profile-version-not-found": "Profile version {version} not found.",
  "template-not-found": "Template not found.",
  "template-key-not-found": 'Template "{key}" not found.',
  "template-image-not-found": "Template image not found.",
  "template-key-image-not-found": 'Image of template "{key}" not found.',
  "template-backup-not-found": 'No backup found for "{key}".',
  "template-task-not-found": "Template generation task not found.",
  "font-file-not-found": "Font file not found.",
  "reference-not-found": "Reference not found.",
  "reference-image-not-found": "Reference image not found.",
  "proposal-not-found": "Learning proposal not found.",
  "ai-call-not-found": "AI call not found.",
  "trial-preview-not-found": "Trial preview not found.",
  "undo-not-found": "Undo record not found.",
  "print-template-not-found": "Print template not found.",
  "preset-not-found": "Preset not found.",
  "print-session-not-found": "Print session not found.",
  "print-page-not-found": "Print page not found.",
  "print-item-not-found": "Print item not found.",
  "slot-not-found": "Slot {slot} not found.",
  "export-not-found": "Print export not found.",
  "export-file-not-found": "Export file not found.",
  "overlay-unavailable": "The area overlay needs the templates package, which is not connected.",
  "specimen-unavailable": "The font specimen needs the typeset package, which is not connected.",
  "key-tester-unavailable": "The connection test is not connected.",
  "text-layer-unavailable": "Text layer drawing (engine) is not connected.",
  "edit-unavailable": "Text/font editing (engine) is not connected.",
  "engine-preview-unavailable": "The engine is not connected; the preview cannot be drawn.",
  "layout-engine-unavailable": "The layout engine is not connected.",
  "geometry-unavailable": "Template geometry is not connected.",
  "ai-designer-unavailable": "The AI designer is not connected.",
  "image-generator-unavailable": "Image generation is not connected.",
  "print-render-unavailable": "Print page drawing (engine) is not connected yet.",
  "pdf-unavailable": "PDF output (engine) is not connected yet.",
  "print-planner-unavailable": "The print page planner (@tagpress/print) is not connected yet.",
  "missing-key": "There is no {providerName} key. Enter your {providerName} key in Settings → Connections.",
  "managed-by-platform": "This setting is managed by the SellerOnData platform and cannot be changed here.",
  "name-managed-by-platform": "The company name is changed in SellerOnData Hub.",
  "ai-paused": "AI is temporarily paused on SellerOnData; nothing was started. Please try again shortly.",
  "ai-unavailable": "AI is unavailable right now; nothing was started.",
  "master-key-missing":
    "The master key is missing ({keys}); keys cannot be encrypted. Put the master key back, or delete the keys that cannot be decrypted and restart the app.",
  "key-unreadable": "The {providerName} key cannot be decrypted: {detail} Enter the key again in Settings → Connections.",
  "feature-off": "This feature is turned off. You can turn it on in Settings → Features.",
  "feature-always-on": "This feature is always on; it cannot be turned off.",
  "no-language": "There is no design language yet. Create a design language first.",
  "no-published-profile": "This design language has no published profile.",
  "no-draft": "There is no draft to publish.",
  "no-draft-profile": "There is no draft profile.",
  "learn-running": "Learning is already running for this design language.",
  "learn-nothing": "No references or manual adjustments yet: adjust the generated variants with Adjust.",
  "replay-no-references": "No references to replay (they need a template, an image and the design area size).",
  "proposal-decided": "This proposal has already been decided.",
  "proposal-empty": "The proposal has no applicable change.",
  "proposal-accepted": "An applied proposal cannot be rejected; undo it first.",
  "proposal-not-applied": "The proposal has not been applied.",
  "proposal-no-record": "There is no record of applying this proposal; undo it manually.",
  "build-not-found": "Build session not found.",
  "build-active": "There is already an open build session for this design language.",
  "build-state": "The session cannot do this at this step.",
  "build-busy": "Something is running in this session; wait for it to finish.",
  "build-no-revision": "This revision does not exist yet.",
  "budget-exceeded": "The AI spending limit was reached; nothing was started.",
  "budget-raise-used": "The session limit has already been raised once.",
  "build-base-changed": "The design language was changed elsewhere during this session; publishing would discard that change.",
  "sample-limit": "A session can have at most {max} samples.",
  "sample-too-large": "The file is too large.",
  "sample-type": "This file type is not accepted (PNG, JPG or PDF).",
  "sample-not-found": "Sample not found.",
  "question-unknown": "The answered question is not among the open questions.",
  "message-kind": "This kind of message cannot be sent at this step.",
  "showcase-item-not-found": "Sample label not found.",
  "template-exists": 'A template named "{key}" already exists.',
  "trial-failed": "{detail}",
  "import-empty": "The file is empty.",
  "import-json-invalid": "Not valid JSON: {detail}",
  "import-no-list": "No job list was found in the JSON.",
  "import-no-records": "No jobs (objects) were found in the JSON.",
  "edit-font": "{detail}",
  "not-adjustable": "This variant cannot be adjusted manually (the text is not an engine layout).",
  "no-saved-adjust": "This variant has no saved adjustment.",
  "undo-used": "This action has already been undone.",
  "undo-expired": "The undo period has expired.",
  "version-conflict": "The session was changed elsewhere; reload the page and try again.",
  printed: "A printed session cannot be changed; copy it to print again.",
  "printed-session-not-deletable": "A printed session is archived and cannot be deleted.",
  "template-other-language": "The template does not belong to this design language.",
  "template-archived": "A session cannot be set up with an archived template.",
  "print-template-required": "Choose a page template (templateId).",
  "session-template-missing": "The session has no template.",
  "session-no-matching-jobs": "No approved job fits this template.",
  "session-no-matching-jobs-quantity": "No approved job fits this template. The selected jobs have no quantity.",
  "shelf-no-matching-jobs": "No unplanned approved job on the shelf fits this template.",
  "shelf-no-matching-jobs-quantity": "No unplanned approved job on the shelf fits this template. The selected jobs have no quantity.",
  "plan-failed": "Planning failed: {detail}",
  "export-no-pages": "The session has no pages to print.",
  "grid-diameter-required": "The grid needs a slot diameter.",
  "grid-size-required": "The grid needs a slot width and height.",
  "grid-no-fit": "That many slots do not fit on this paper (the step came out zero or negative).",
  "sticker-on-label-page": "A sticker cannot go on a label page; drop it on a sticker page.",
  "label-on-sticker-page": "A label cannot go on a sticker page; drop it on a label page.",
  "sticker-move-to-label": "A sticker cannot be moved to a label page.",
  "label-move-to-sticker": "A label cannot be moved to a sticker page.",
  "page-kind-mismatch": "A label page cannot be switched to a sticker template (or the other way round).",
  "no-approved-variant": "The job has no approved variant; choose a variant.",
  "slot-occupied": "Slot {slot} is taken.",
  "no-free-slot": "There is no free slot on the page; give a position.",
  "free-position-required": "A free position needs xMm and yMm.",
  "move-target-required": "Moving needs a slot or xMm/yMm.",
  "id-in-use": "ID already in use: {id}.",
};

const EN_ISSUES: Record<string, string> = {
  "text-missing": "The text is empty.",
  "text-very-long": "The text is very long ({length} characters); this profile fits about {capacity} characters.",
  "text-very-long-lines": "The customer gave {lines} lines; the profile allows at most {max}.",
  "text-very-long-segment": "Line {line} is longer than {max} characters (line breaks are fixed).",
  "text-word-too-long": "A word too long for one line: {words} (at most {max} characters).",
  "text-outer-quotes-removed": "The quotation marks around the text were removed.",
  "text-unicode-styled": "The text has styled letters ({chars}). Converted to plain letters it prints in the label font; left as is, it prints in this style.",
  "text-unprintable": "Characters missing from every font: {chars}. They would print as empty boxes.",
  "text-unprintable-broken": "There are broken characters (a damaged emoji or a copy error, in {count} places); they cannot be printed. Check the customer's text.",
  "text-unprintable-control": "There are unprintable control characters ({chars}).",
  "text-fallback-font": "Characters missing from the design fonts will print with a fallback font: {chars}.",
  "text-fallback-font-partial": "These emoji are not a single glyph in the font; their parts will print side by side: {chars}.",
  "text-fallback-font-mono": "These emoji are not in the colour font; they will print in one colour: {chars}.",
  "text-suspicious-space": "There are unusual space characters ({chars}).",
  "text-suspicious-all-caps": "The whole text is in capitals; is that what the customer wants?",
  "text-suspicious-mixed-case": "Mixed upper and lower case inside a word: {words}.",
  "text-suspicious-leading-punct": 'The text starts with a punctuation mark ("{char}").',
  "text-suspicious-trailing-punct": 'The text ends with a punctuation mark ("{char}").',
  "text-suspicious-unbalanced": "Unmatched brackets or quotes: {chars}.",
  "text-suspicious-mojibake": 'The text looks wrongly encoded (accented letters or emoji were misread); it should be: "{fixed}".',
  "text-suspicious-escapes": 'The text contains escaped characters; decoded: "{fixed}".',
  "text-suspicious-replacement": "The text has a broken character (�): the customer's file may have an encoding error; type the real character.",
  "template-missing": "No template given.",
  "template-missing-input": 'The template value could not be understood ("{input}").',
  "template-unknown": 'There is no template named "{key}" in this design language.',
  "template-unknown-suggest": 'There is no template named "{key}" in this design language. Did you mean: {suggestions}?',
  "template-unknown-file": 'The PNG file of template "{key}" is missing from the folder.',
  "size-unknown": 'Label size "{size}" was not recognised; the default {defaultSize} will be used.',
  "quantity-missing": "No quantity.",
  "quantity-invalid": 'Invalid quantity ("{value}"); it must be a positive whole number.',
  "order-missing": "No order number.",
  "duplicate-in-file": "Same job as row {row} in the file.",
  "duplicate-existing": 'This job was already imported in batch "{batch}" ({date}).',
  "duplicate-similar-file": "The same text and template are also in order {order} (row {row} in the file).",
  "duplicate-similar-batch": 'The same text and template are also in order {order} (batch "{batch}").',
  "sticker-detected": "Sticker order (no template; it goes on a sticker page).",
  "sticker-sheet-missing": "No page was chosen for this sticker.",
  "sticker-sheet-missing-none": "The profile defines no sticker page (Design language → Sticker).",
  "sticker-sheet-missing-id": 'Sticker page "{sheet}" is not in the profile.',
  "text-changed": 'The text was changed (character {at}): "{got}" ≠ "{want}"',
  "text-changed-generic": "The text was changed.",
  "text-changed-lines": "The lines change the customer's text.",
  "text-changed-customer": "The customer's text was changed.",
  "text-edited": "Line text edited by hand; it differs from the job text (only in this variant; the customer's text is unchanged).",
  "text-edited-diff":
    'Line text edited by hand; it differs from the job text (only in this variant; the customer\'s text is unchanged). The text was changed (character {at}): "{got}" ≠ "{want}"',
  "no-layout": "The text does not fit the text area even at the smallest size.",
  "text-too-small": "The smallest line is {pt} pt; the readability limit is {min} pt.",
  "text-too-small-min": "The smallest line drops below {min} pt; the text does not fit with this arrangement.",
  "text-too-small-adjust": "After shrinking, the smallest line is {pt} pt; the readability limit is {min} pt.",
  collision: "The text could not be placed without hitting the decoration or the cut line.",
  "collision-cut": "The text goes outside the cut line; it will be cut off when printed.",
  "collision-decoration": "The text touches the template decoration.",
  "text-unprintable-layout": "No font can print these characters: {chars}",
  "text-unprintable-kept": "No font can print these characters (not removed): {chars}",
  "text-fallback-font-used": "Characters missing from the design font were printed with a fallback font: {chars}",
  "text-fallback-font-partial-used": "These emoji are not a single glyph in the font; their parts will print side by side: {chars}",
  "text-fallback-font-mono-used": "These emoji are not in the colour font; they will print in one colour: {chars}",
  "rule-too-many-lines": "{lines} lines; there should be at most {max}.",
  "rule-line-too-long": "Line {line} has {chars} characters; the limit is {max}.",
  "rule-lone-word": '"{text}" should not stand alone on a line; keep it with its phrase.',
  "rule-name-not-own-line": 'The name line ("{text}") is not the largest line.',
  "rule-name-not-own-line-extra": "The name line has other words: {words}.",
  "rule-split-greeting": 'A short greeting is split: "{first}" / "{second}".',
  "rule-date-own-line": 'The date is not on its own line: "{text}".',
  "rule-customer-break": "Line {line} does not follow the customer's line break.",
  "rule-initials-split": "Text made of initials only should stay on one line.",
  "font-unavailable-unknown": "Font not in the profile: {font}.",
  "font-unavailable-disabled": "{font} is turned off in the profile.",
  "font-unavailable-special": "{font} is only for special character rules; it cannot be a line font.",
  "font-unavailable-missing": "The font file for {font} is not installed.",
  "font-unavailable-uppercase": "{font}: the text has {run} capitals in a row (limit {max}).",
  "font-mixing": "A label can use at most {limit} font families; {count} were used.",
  "font-mixing-adjust": "The design language wants at most {limit} font families per label; {count} were used by hand ({families}).",
  "rule-too-many-lines-ai": "{lines} lines; at most {max}.",
  "rule-lone-word-ai": '"{text}" cannot stand alone on a line.',
  "rule-split-greeting-example": "\"{text}\" is split; it is one line in the designer's example.",
  "rule-initials-split-connector": "The initials are stacked; they should be on one line.",
  "rule-initials-split-stacked": "The initials are stacked.",
  "rule-couple-stack": '"{text}": stack the names (name / connector / name).',
  "rule-couple-stack-connector": "The connector is on its own line; in this style the names stay on one line.",
  "rule-name-not-own-line-ai": 'The name line "{text}" is not the main line.',
  "rule-date-own-line-ai": 'The date "{date}" shares a line with other words.',
  "rule-customer-break-ai": "One of the customer's line breaks was not kept.",
  "font-unavailable-none": "No font can be used for this job (check the font list, roles and capital-letter limits).",
  "font-unavailable-catalog": "Font not in the catalogue: {font}",
  "font-unavailable-job": "{font} cannot be used for this job: {reason}",
  "font-unavailable-tier": '{font} cannot be used on a "{tier}" line (roles: {roles}).',
  "font-mixing-candidate": "This design language allows at most {limit} font families; the candidate uses {families}.",
  "ai-duplicate": "The same design already exists.",
  "ai-duplicate-lines": "The same line split was already shown.",
  "ai-failed-empty-line": "There is an empty line.",
  "ai-failed-format": "Invalid candidate format: {detail}",
  "ai-failed-intent": "The intent could not be built: {detail}",
  "ai-unavailable": "AI is unavailable: {reason}. {detail}",
  "ai-call-failed": "The AI call failed: {detail}",
  "ai-no-good-candidate": "The AI produced no valid candidate: {detail}",
  "ai-no-good-candidate-empty": "The AI produced no valid candidate: the response could not be used",
  "generation-failed": "Generation failed: {detail}",
  "critique-issue": "Visual check: {note}",
  "critique-issue-fixed": "Visual check: {note} (fixed)",
  "image-text-unreadable": "The text in the image could not be read; check it by eye.",
  "image-text-mismatch": 'The text in the image differs from the customer\'s text: "{text}"',
  "image-text-different": 'The text in the image is not the customer\'s text (in the image: "{text}").',
  "image-template-changed": "The image model changed the template's pixels; this result should not be used.",
  "image-template-changed-reasons":
    "The image model changed the template or the text could not be separated ({reasons}); the result was not used because the template cannot be guaranteed untouched.",
  "image-template-changed-internal": "Internal error: a template pixel changed in the composite; the result was not used.",
  "image-model-unavailable": "The image model is unavailable: {detail}",
  "image-generation-failed": "The image could not be generated: {detail}",
  "image-generation-failed-unknown": "The image could not be generated: unknown error",
  "template-text-unchecked": "Could not check whether the template has text (no image reader).",
  "template-has-text": 'The generated template has text: "{text}".',
  "template-text-unreadable": "Could not read whether the generated template has text.",
  "template-generation-failed": "The template could not be generated: {detail}",
  "template-cut-changed": "The cut shape or size of the template ({template}) changed; the approval was removed. Check the layout with the new cut and approve again (regenerate if needed).",
};

const EN_FIXES: Record<string, string> = {
  regenerate: "Generate again",
  retry: "Try again",
  revise: "Try with fewer lines",
  "request-fix": "Ask for this fix",
  "edit-text": "Edit text",
  "fix-text": "Fix text",
  "write-text": "Write text",
  "restore-quotes": "Put the quotes back",
  "normalize-spaces": "Use normal spaces",
  "fix-encoding": "Fix the encoding",
  "decode-escapes": "Decode escapes",
  "remove-control": "Remove control characters",
  "convert-unicode": "Convert to plain letters",
  "choose-template": "Choose template",
  "choose-template-key": "{key}",
  "set-size": "{cm} cm",
  "set-quantity": "Enter quantity",
  "fix-quantity": "Fix quantity",
  "set-order": "Enter order no.",
  "open-template": "Open template",
  "upload-template": "Upload template",
  "fix-text-area": "Fix the text area",
  skip: "Don't import",
  "skip-row": "Don't import this row",
  dismiss: "It's correct, keep it",
  "print-as-is": "Print as is",
};

const EN_UNDO: Record<string, string> = {
  "jobs-deleted": "{count} jobs deleted",
  "batch-deleted": "Batch and its {count} jobs deleted",
  "variant-deleted": "Variant deleted",
  "adjust-saved": "Manual adjustment saved",
  "adjust-removed": "Manual adjustment removed",
  "print-page-deleted": "Print page deleted",
  "print-pages-deleted": "{count} print pages deleted",
  "print-session-deleted": "Print session deleted",
  "language-deleted": "Design language deleted",
};

const EN_PRINT: Record<string, string> = {
  "no-slots": "The template has no slots.",
  "no-slots-sticker": "The template has neither slots nor a sticker flow.",
  "slot-duplicate-id": "Slots with the same ID: {slots}.",
  "slot-outside": "{count} slots go off the paper: {slots}.",
  "slot-overlap": "{count} slots overlap: {slots}.",
  "label-larger-than-slot": "The label diameter ({diameter} mm) is larger than {count} slots; the label runs over the slot line.",
  "mark-overlap": "Registration marks hit {count} slots or enter the bleed + {safeMm} mm safe area: {slots}. Change the edge margin.",
  "slot-in-printer-margin": "{count} slots (bleed included) reach into the {marginMm} mm edge the printer cannot print: {slots}. The edge may print incomplete.",
};

const EN_NOTICES: Record<string, string> = {
  "plan-stale": "This session was laid out with outdated sizes ({sheets} sheets; the sticker size or a template's cut changed). Replanning brings it to about {replanSheets} sheets; replan before printing.",
  "printed-old-scale": "This session was printed with the old sticker size; the export comes out as printed. To print with the new size, reprint and replan.",
  "sticker-small-text": "{orderNo}: the smallest sticker text is {pt} pt, below the legibility limit ({minPt} pt). Enlarge the sticker area or shorten the text.",
};

/** Serbest metin parametreleri: çevrilemez, olduğu gibi gösterilir. */
const FREE = new Set(["detail", "reason", "reasons", "note"]);

type Catalog = Record<string, { tr: string; status?: number | null; code?: string; kind?: string }>;

const i18n = (s: string) => s.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, "{{$1}}");
const cell = (s: string) => s.replaceAll("|", "\\|");
const paramsCell = (tr: string) => {
  const ps = templateParams(tr);
  return ps.length ? ps.map((p) => (FREE.has(p) ? `\`${p}\`*` : `\`${p}\``)).join(", ") : "—";
};

function checkEn(name: string, catalog: Catalog, en: Record<string, string>): void {
  for (const [k, d] of Object.entries(catalog)) {
    const e = en[k];
    if (e === undefined) throw new Error(`${name}: "${k}" için İngilizce öneri yok`);
    const a = templateParams(d.tr).sort().join(",");
    const b = templateParams(e).sort().join(",");
    if (a !== b) throw new Error(`${name}: "${k}" parametreleri farklı (tr: ${a}; en: ${b})`);
  }
  for (const k of Object.keys(en)) if (!(k in catalog)) throw new Error(`${name}: fazladan İngilizce öneri "${k}"`);
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

const json = (o: unknown) => `\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\``;
const dict = (catalog: Catalog, pick: (k: string, d: { tr: string }) => string) => Object.fromEntries(Object.entries(catalog).map(([k, d]) => [k, i18n(pick(k, d))]));

export function renderDoc(): string {
  const E = ERROR_MESSAGES as Catalog;
  const I = ISSUE_MESSAGES as Catalog;
  const F = FIX_LABELS as Catalog;
  const U = UNDO_MESSAGES as Catalog;
  const P = PRINT_WARNING_MESSAGES as Catalog;
  const N = PRINT_NOTICE_MESSAGES as Catalog;
  checkEn("hatalar", E, EN_ERRORS);
  checkEn("sorunlar", I, EN_ISSUES);
  checkEn("düzeltmeler", F, EN_FIXES);
  checkEn("geri al", U, EN_UNDO);
  checkEn("baskı uyarıları", P, EN_PRINT);
  checkEn("baskı oturumu bildirimleri", N, EN_NOTICES);
  const issueCodes = new Set(Object.values(I).map((d) => d.code));

  return `# Sunucu kodları

> Bu belge üretilir: \`node scripts/sunucu-kodlari.ts\` (kaynak: \`packages/domain/src/messages.ts\`). Elle düzenlemeyin.
> Test (\`packages/domain/src/messages.test.ts\`) listedeki her kodun burada geçtiğini denetler.

Sunucu kullanıcıya gösterilen her hatayı, sorunu, düzeltme önerisini, geri al bildirimini ve baskı şablonu uyarısını
**kod + parametre** ile gönderir. Bugünkü Türkçe cümle aynı yanıtta durur (geriye uyum; eski arayüz onu gösterir).

## Yanıt biçimi

| Ne | Alanlar (yeni olanlar kalın) | Sözlük anahtarı önerisi |
| --- | --- | --- |
| Hata (\`ApiError\`, 4xx/5xx) | \`error\` (TR cümle), **\`code\`**, **\`params\`**, \`fields\`, \`provider\` | \`errors:<code>\` |
| Sorun (\`Issue\`) | \`code\`, \`severity\`, \`message\` (TR), **\`messageKey\`**, **\`params\`**, \`field\`, \`fixes\` | \`issues:<messageKey>\` (yoksa \`issues:<code>\`) |
| Düzeltme önerisi (\`FixAction\`) | \`kind\`, \`label\` (TR), **\`labelKey\`**, **\`params\`**, \`value\` | \`issues:fix.<labelKey>\` (yoksa \`issues:fix.<kind>\`) |
| Geri al (\`UndoToken\`) | \`undoToken\`, \`label\` (TR), **\`code\`**, **\`params\`**, \`expiresAt\` | \`common:undo.<code>\` |
| Baskı şablonu uyarısı (\`PrintTemplateWarning\`) | \`code\`, \`message\` (TR), **\`messageKey\`**, **\`params\`**, \`slotIds\` | \`printTemplates:warnings.<messageKey>\` |

- **Kod düzeni:** küçük harf, kısa çizgili, düz (nokta yok): \`template-key-not-found\`. Sözlük anahtarı olarak doğrudan kullanılır.
  Var olan kodlar korundu (\`missing-key\`, \`edit-font\`, \`not-adjustable\`, \`version-conflict\`, \`printed\`; sorun kodlarının hepsi).
- **Bir sorun kodunun birden çok cümlesi olabilir** (ör. \`text-very-long\` üç farklı durum). Gruplama ve sayma \`code\` ile, metin
  \`messageKey\` ile yapılır. Tek cümlesi olan kodda \`messageKey\` kodla aynıdır.
- **Parametreler** düz JSON: sayılar sayı (\`count\`, \`line\`, \`max\`, \`version\`…), listeler önceden birleştirilmiş metin
  (\`chars\`, \`words\`, \`slots\`, \`families\`). \`pt\` bir ondalıklı metindir ("5.5"). Parametre yoksa \`params\` alanı gelmez.
- **Müşteri metni** parametreye olduğu gibi girer (\`text\`, \`fixed\`, \`first\`/\`second\`, \`got\`/\`want\`, \`input\`); arayüz
  bunları değiştirmeden göstermelidir. Sunucu cümlesi i18next'e verilirken kaçış (HTML) arayüzün işidir.
- **Serbest metin** (tabloda \`*\`): \`detail\`, \`reason\`, \`reasons\`, \`note\` motorun, AI sağlayıcısının, kütüphanenin ya da
  AI denetçisinin kendi cümlesidir (çoğu Türkçe, bazıları İngilizce). Çevrilemez; EN arayüzde olduğu gibi gösterilir.
- **Eski kayıtlar:** veritabanında saklı sorunlarda (\`variants.issues\`, iş sorunları) \`messageKey\`/\`params\` olmayabilir; o zaman
  \`message\`'a düşülür.
- **Doğrulama alanları** (\`fields[].message\`) zod'un ya da şemanın kendi cümlesidir; kodlanmadı.

### Arayüz kuralı (öneri)

1. Hata: \`code\` sözlükte varsa \`t("errors:" + code, params)\`; yoksa TR'de \`error\`, EN'de \`errors:generic\` + ayrıntıda \`error\`.
2. Sorun: \`t("issues:" + (messageKey ?? code), params)\`; anahtar yoksa \`message\`.
3. Düzeltme: \`t("issues:fix." + (labelKey ?? kind), { value, ...params })\`; anahtar yoksa \`label\`.
4. Geri al: \`t("common:undo." + code, params)\`; yoksa TR'de \`label\`, EN'de \`common:undo.generic\`.

## Hatalar (${Object.keys(E).length})

\`status\` "—": durum değişir (Fastify'ın kendi 4xx'i).

${table(
  ["Kod", "Durum", "Parametreler", "TR (bugünkü metin)", "EN önerisi"],
  Object.entries(E).map(([k, d]) => [`\`${k}\``, d.status == null ? "—" : String(d.status), paramsCell(d.tr), d.tr, EN_ERRORS[k]!]),
)}

## Sorunlar (${Object.keys(I).length} cümle, ${issueCodes.size} kod)

${table(
  ["messageKey", "code", "Parametreler", "TR (bugünkü metin)", "EN önerisi"],
  Object.entries(I).map(([k, d]) => [`\`${k}\``, d.code === k ? "=" : `\`${d.code}\``, paramsCell(d.tr), d.tr, EN_ISSUES[k]!]),
)}

## Düzeltme önerileri (${Object.keys(F).length})

\`value\` (öneri değeri: dönüştürülmüş metin, şablon anahtarı, boyut kimliği…) ayrıca gelir; sözlükte \`{{value}}\` ile kullanılabilir.

${table(
  ["labelKey", "kind", "Parametreler", "TR (bugünkü ad)", "EN önerisi"],
  Object.entries(F).map(([k, d]) => [`\`${k}\``, d.kind === k ? "=" : `\`${d.kind}\``, paramsCell(d.tr), d.tr, EN_FIXES[k]!]),
)}

## Geri al bildirimi (${Object.keys(U).length})

${table(
  ["code", "Parametreler", "TR (bugünkü metin)", "EN önerisi"],
  Object.entries(U).map(([k, d]) => [`\`${k}\``, paramsCell(d.tr), d.tr, EN_UNDO[k]!]),
)}

EN'de çoğul için i18next \`_one\`/\`_other\` önerilir (\`jobs-deleted_one\`: "1 job deleted").

## Baskı şablonu uyarıları (${Object.keys(P).length})

${table(
  ["messageKey", "code", "Parametreler", "TR (bugünkü metin)", "EN önerisi"],
  Object.entries(P).map(([k, d]) => [`\`${k}\``, d.code === k ? "=" : `\`${d.code}\``, paramsCell(d.tr), d.tr, EN_PRINT[k]!]),
)}

## Baskı oturumu bildirimleri (${Object.keys(N).length})

Oturum ayrıntısında \`notices[]\` (\`code\`, \`message\`, \`params\`); sözlük anahtarı \`printDesk:notices.<code>\`.

${table(
  ["code", "Parametreler", "TR (bugünkü metin)", "EN önerisi"],
  Object.entries(N).map(([k, d]) => [`\`${k}\``, paramsCell(d.tr), d.tr, EN_NOTICES[k]!]),
)}

## Kodlanmayan metinler (serbest metin kalanlar)

- Üretim ilerleme günlüğü (\`ProgressStep.message\`, SSE), öğrenme durumu (\`LearnStatus.message\`), AI çağrısı aşama metinleri.
- İş / görev / çıktı kayıtlarındaki \`error\` sütunları (üretim, şablon üretimi, baskı çıktısı hatası) ve \`GenerationError\` metinleri
  (sorun olarak \`generation-failed\` + \`detail\` ile gelir).
- Atlanan satır / iş gerekçeleri (\`skipped[].reason\`: içe aktarma, üretim, baskı planı) ve baskı planı uyarıları (\`warnings[]\`).
- Anahtar bağlantı denemesi sonucu (\`KeyTestResponse.message\`).
- Doğrulama alanları (\`fields[].message\`) ve şema içindeki özel doğrulama cümleleri.

## Sözlük dosyası önerisi

\`issues.json\` içinde düzeltme adları \`fix\` altında. Geri al için \`common.json\` → \`undo\`, baskı uyarıları için
\`printTemplates.json\` → \`warnings\` önerilir (bu iki bölüm aşağıda ayrı).

<details><summary><code>locales/tr/errors.json</code></summary>

${json({ generic: "Beklenmeyen bir hata oldu.", ...dict(E, (_k, d) => d.tr) })}

</details>

<details><summary><code>locales/en/errors.json</code></summary>

${json({ generic: "Something went wrong.", ...dict(E, (k) => EN_ERRORS[k]!) })}

</details>

<details><summary><code>locales/tr/issues.json</code></summary>

${json({ ...dict(I, (_k, d) => d.tr), fix: dict(F, (_k, d) => d.tr) })}

</details>

<details><summary><code>locales/en/issues.json</code></summary>

${json({ ...dict(I, (k) => EN_ISSUES[k]!), fix: dict(F, (k) => EN_FIXES[k]!) })}

</details>

<details><summary><code>common.json</code> → <code>undo</code> ve <code>printTemplates.json</code> → <code>warnings</code> (tr / en)</summary>

${json({ tr: { undo: dict(U, (_k, d) => d.tr), warnings: dict(P, (_k, d) => d.tr) }, en: { undo: dict(U, (k) => EN_UNDO[k]!), warnings: dict(P, (k) => EN_PRINT[k]!) } })}

</details>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("../docs/sunucu-kodlari.md", import.meta.url));
  writeFileSync(out, renderDoc());
  console.log(`yazıldı: ${out}`);
}
