/**
 * @tagpress/ai — dış arayüz.
 *
 * Portlar (sunucu bunlara bağımlıdır; sahteleri `@tagpress/ai/testing`):
 *   ClaudePort  ← createClaude({ apiKey, model?, fetch? })
 *   ImagePort   ← createGemini({ apiKey, model?, fetch? })
 *
 * Akışlar:
 *   proposeDesigns(claude, ctx)            tasarım niyeti adayları (+ doğrulama, onarım)
 *   rankCandidates(claude, input)          adayları yan yana karşılaştırıp sıralar
 *   transcribe(claude, png) / sameText(a, b)
 *   writeOnTemplate({ gemini, claude }, input) / reviseImage(...)        şablon korunur
 *   generateTemplate({ gemini, claude }, input)                          yazısız yeni şablon
 */
export * from "./errors.ts";
export { gatewayCallIdOf, gatewayRejectFailure, gatewayRejectOf, type GatewayCall, type GatewayOptions } from "./gateway.ts";
export { extractJson, formatZodIssues, toApiJsonSchema } from "./json.ts";
export { type RawImage, decodeRgba, encodeRgba, pngForModel, shapeMask, pointInShape, nearestAspect } from "./images.ts";
export {
  createClaude,
  repairText,
  MAX_OUTPUT_TOKENS,
  type CallLog,
  type ClaudeOptions,
  type ClaudePort,
  type ContentPart,
  type JsonRequest,
  type JsonResult,
  type ProgressEvent,
  type ProgressStage,
  type Validation,
} from "./claude.ts";
export { createGemini, findImage, type GeminiOptions, type ImagePort, type ImageRequest, type ImageResult } from "./gemini.ts";
export {
  examplesSection,
  imageProfileHints,
  isBreakRule,
  preservationSymbols,
  profileRulesSection,
  renderProfileRules,
  ROLES_FOR_TIER,
  RULE_KEYS,
  styleNoteSection,
  symbolConnectors,
  type RenderedRule,
} from "./profile-rules.ts";
export type { DesignContext, DesignImages, TemplateSummary } from "./design/context.ts";
export { fontCatalog, longestUppercaseRun, type FontAvailability } from "./design/fonts.ts";
export { checkIntentText, isConnectorLine, type RuleLine, type RuleProblem } from "./design/rules.ts";
export { buildDesignSystem, buildDesignUser, defaultTier, DESIGN_PROMPT_VERSION, designWire, type DesignWire, type WireCandidate } from "./design/prompt.ts";
export { validateCandidates, wireToIntent, type CandidateCheck, type DesignCandidate, type IntentRules, type RejectedCandidate, type ValidateOptions } from "./design/validate.ts";
export { proposeDesigns, type DesignResult, type ProposeOptions } from "./design/propose.ts";
export { buildRankSystem, canonicalCandidateId, rankCandidates, RANK_PROMPT_VERSION, type RankInput, type RankResult } from "./rank.ts";
export { sameText, transcribe, TRANSCRIBE_PROMPT_VERSION, type TranscribeResult } from "./transcribe.ts";
export {
  composeOnTemplate,
  DEFAULT_LAYER_THRESHOLDS,
  dilate,
  extractTextLayer,
  inkHex,
  templateUntouched,
  type ExtractOptions,
  type LayerThresholds,
  type TextLayer,
} from "./image/text-layer.ts";
export { IMAGE_REVISE_PROMPT_VERSION, IMAGE_WRITE_PROMPT_VERSION, TEMPLATE_PROMPT_VERSION, buildRevisePrompt, buildTemplatePrompt, buildWritePrompt } from "./image/prompts.ts";
export {
  DEFAULT_ACCEPTANCE,
  reviseImage,
  templateCutShape,
  writeOnTemplate,
  type Acceptance,
  type ImageDeps,
  type ReviseImageInput,
  type WriteChecks,
  type WriteOnTemplateInput,
  type WriteOnTemplateResult,
} from "./image/write.ts";
export { cutGuidePng, generateTemplate, maskToShape, type GenerateTemplateInput, type GenerateTemplateResult } from "./image/template.ts";
export { type BreakExample, breaksOnCustomerText, pickSimilarExamples, similarExamplesSection } from "./design/similar.ts";

// Sitede tasarım dili oluşturucu (plan C1). Sahte model: `@tagpress/ai/builder/testing`.
export {
  BUILDER_BETAS,
  buildBuilderRequest,
  buildContextMessage,
  countBuilderPrefix,
  effectiveEffort,
  replayContent,
  runBuilderTurn,
  type BuilderEffort,
  type BuilderEvent,
  type BuilderFallbacks,
  type BuilderLoopOptions,
  type BuilderRequestOptions,
  type BuilderStopReason,
  type BuilderThinkingDisplay,
  type BuilderToolContent,
  type BuilderToolExecutor,
  type BuilderToolResult,
  type BuilderTurnArgs,
  type BuilderTurnResult,
} from "./builder/agent.ts";
export {
  BuilderModelError,
  createBuilderModel,
  toBuilderModelError,
  type BuilderCallOptions,
  type BuilderCountRequest,
  type BuilderMessage,
  type BuilderModelOptions,
  type BuilderModelPort,
  type BuilderRequest,
  type BuilderResponse,
  type BuilderStreamEvent,
} from "./builder/model.ts";
export { builderToolDefinitions, isBuilderToolName, validateBuilderToolUse, type BuilderToolCall, type BuilderToolDefinition, type BuilderToolOptions } from "./builder/tools.ts";
export {
  BUILDER_PROMPT_VERSION,
  BUILDER_TOOL_DESCRIPTIONS,
  builderSystemPrompt,
  contextTextParts,
  dataJson,
  escapeData,
  noticeText,
  userInputText,
  type BuilderContextSample,
  type BuilderInputEntry,
  type BuilderLocale,
  type BuilderPromptVersion,
  type BuilderSessionContext,
  type BuilderUserInput,
} from "./builder/prompt.ts";
export {
  BUILDER_ESTIMATE_REQUESTS,
  BUILDER_IMAGE_TOKENS_ESTIMATE,
  budgetCostOf,
  cacheSummary,
  costOf,
  estimateBuilderCost,
  usageFromResponse,
  type BuilderEstimate,
  type BuilderTokenCounter,
  type BuilderUsage,
  type CacheSummary,
  type CostSummary,
} from "./builder/cost.ts";
export {
  BADGE,
  formatProfile,
  formatProposalResult,
  formatReplay,
  formatSample,
  formatToolInputError,
  profileLeaves,
  schemaFields,
  type ReferenceSampleView,
  type ReplaySideView,
} from "./builder/format.ts";
