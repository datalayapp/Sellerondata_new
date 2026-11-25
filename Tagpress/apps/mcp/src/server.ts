import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ClientOptions, TagpressClient } from "./client.ts";
import { registerDataTools } from "./tools/data.ts";
import { registerProfileTools } from "./tools/profile.ts";
import { registerWorkTools } from "./tools/work.ts";

/** Sunucunun kendini bildirdiği ad; `.mcp.json` kaydı ve araç adları (`mcp__tagpress__*`) bununla aynıdır. */
export const MCP_SERVER_NAME = "tagpress";

/** Sunucunun Claude Code'a kendini tanıttığı kısa yönerge. */
export const INSTRUCTIONS = [
  "TagPress: kullanıcının etiket tasarım dilini (profil) yerel uygulama üzerinden okur, ölçer, taslağa yazar ve dener.",
  "Ayrıntılı akış için 'tasarim-dili' becerisini kullanın. Uygulama 127.0.0.1:5420'de açık olmalı (TAGPRESS_URL ile değişir).",
  "Kurallar: AI piksel üretmez; tarz koda değil profile yazılır; müşteri metni asla değişmez; uydurma değer yazılmaz (ölçüm ya da yöneticinin cevabı).",
  "Yayınlama yalnızca uygulamadaki Tasarım dili ekranından yapılır. uretim_dene ücretlidir: önce onay=false ile maliyeti sorun.",
].join(" ");

export function buildServer(opts: ClientOptions = {}): { server: McpServer; client: TagpressClient } {
  const client = new TagpressClient(opts);
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ctx = { server, client };
  registerProfileTools(ctx);
  registerDataTools(ctx);
  registerWorkTools(ctx);
  return { server, client };
}
