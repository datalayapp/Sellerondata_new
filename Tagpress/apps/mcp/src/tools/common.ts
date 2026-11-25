import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type TagpressClient, TagpressError } from "../client.ts";

/** Araç modüllerinin ortak bağlamı. */
export interface ToolContext {
  server: McpServer;
  client: TagpressClient;
}

export type Content = CallToolResult["content"][number];

export const text = (t: string): Content => ({ type: "text", text: t });
export const image = (base64: string): Content => ({ type: "image", data: base64, mimeType: "image/png" });
export const json = (v: unknown) => JSON.stringify(v, null, 1);

export function ok(...content: Content[]): CallToolResult {
  return { content };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** Hata metni: alan yollarıyla doğrulama hataları dahil. */
export function errorText(err: unknown): string {
  if (err instanceof TagpressError) {
    const fields = err.fields?.length ? `\n${err.fields.map((f) => `- ${f.path || "(kök)"}: ${f.message}`).join("\n")}` : "";
    return `${err.message}${fields}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Araç gövdesini sarar: her hata anlaşılır bir araç hatasına dönüşür (sunucu çökmez). */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(errorText(err));
    }
  };
}

export const Dil = z.string().min(1).describe("Tasarım dili kimliği (diller aracından), ör. 'benim-tarzim'.");
export const Kaynak = z.enum(["taslak", "yayinlanan"]);
export const toSource = (k: "taslak" | "yayinlanan") => (k === "taslak" ? "draft" : "published");

/** Görselleri sırayla getirir; getirilemeyen görsel atlanır (araç yine sonuç döner). */
export async function images(client: TagpressClient, urls: string[]): Promise<{ content: Content[]; failed: number }> {
  const content: Content[] = [];
  let failed = 0;
  for (const u of urls) {
    try {
      content.push(image(await client.image(u)));
    } catch {
      failed++;
    }
  }
  return { content, failed };
}

/** Oturum günlüğüne yazar; günlük yazılamazsa aracın asıl sonucu bozulmaz. */
export async function logSession(client: TagpressClient, lang: string, entry: { kind: string; text: string; group?: string; paths?: string[]; status?: string }): Promise<string | null> {
  try {
    await client.post(`/api/languages/${encodeURIComponent(lang)}/design-session/entries`, entry);
    return null;
  } catch (err) {
    return `(Oturum günlüğüne yazılamadı: ${errorText(err)})`;
  }
}
