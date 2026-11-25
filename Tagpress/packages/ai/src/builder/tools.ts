import type Anthropic from "@anthropic-ai/sdk";
import { BUILDER_TOOL_NAMES, type BuilderToolInput, type BuilderToolName, builderToolJsonSchema, parseBuilderToolInput, type StrictJsonSchema } from "@tagpress/domain";
import { BUILDER_TOOL_DESCRIPTIONS } from "./prompt.ts";

/**
 * Oluşturucunun araç tanımları: sözleşmedeki zod şemalarından (`builder-tools.ts`) katı (`strict: true`) tanım.
 * Sıra sabittir (`BUILDER_TOOL_NAMES`): araç listesi önbellek önekinin ve korunan düşünmenin parçasıdır, oturum
 * boyunca bayt bayt aynı kalmalıdır. Modelin yayın ve ücretli deneme aracı YOKTUR (liste sözleşmedeki sekiz araç).
 */

export type BuilderToolDefinition = Anthropic.Beta.BetaTool;

export interface BuilderToolOptions {
  /**
   * Araç girdisi parça parça akar (`eager_input_streaming`). Açıkken API girdiyi önceden doğrulamaz; döngü her
   * girdiyi zaten zod ile doğrular. Geçit ya da vekil sunucu alanı reddederse kapatılır.
   */
  eagerInputStreaming?: boolean;
}

/** Katı tanımda her nesneye `required` yazılır (boşsa boş dizi): katı kipte alan zorunludur, anlamı değişmez. */
function withRequired(node: StrictJsonSchema): StrictJsonSchema {
  const out: StrictJsonSchema = { ...node };
  if (node.type === "object") {
    out.required = node.required ?? [];
    if (node.properties) out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, withRequired(v)]));
  }
  if (node.items) out.items = withRequired(node.items);
  return out;
}

/** Sekiz aracın tanımı (sabit sırada). Aynı seçenekle her çağrıda aynı sonucu verir. */
export function builderToolDefinitions(opts: BuilderToolOptions = {}): BuilderToolDefinition[] {
  return BUILDER_TOOL_NAMES.map((name) => ({
    name,
    description: BUILDER_TOOL_DESCRIPTIONS[name],
    input_schema: withRequired(builderToolJsonSchema(name)) as unknown as BuilderToolDefinition["input_schema"],
    strict: true,
    ...(opts.eagerInputStreaming ? { eager_input_streaming: true } : {}),
  }));
}

export const isBuilderToolName = (name: string): name is BuilderToolName => (BUILDER_TOOL_NAMES as readonly string[]).includes(name);

/** Doğrulanmış araç çağrısı (çalıştırıcıya giden). */
export type BuilderToolCall = { [N in BuilderToolName]: { id: string; name: N; input: BuilderToolInput<N> } }[BuilderToolName];

/** Model girdisini doğrular. Geçmezse sorunlar alan yoluyla döner (modele `is_error` sonucu olarak gider). */
export function validateBuilderToolUse(id: string, name: string, input: unknown): { ok: true; call: BuilderToolCall } | { ok: false; issues: string[] } {
  if (!isBuilderToolName(name)) return { ok: false, issues: [`Unknown tool "${name}". Available tools: ${BUILDER_TOOL_NAMES.join(", ")}.`] };
  const parsed = parseBuilderToolInput(name, input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`) };
  return { ok: true, call: { id, name, input: parsed.data } as BuilderToolCall };
}
