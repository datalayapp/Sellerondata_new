/**
 * TagPress MCP sunucusu (stdio). Claude Code'daki "tasarım dili" becerisi bu araçlarla yerel uygulamayla konuşur.
 * Uygulama aboneliği hiç çağırmaz; yönetici kendi Claude Code oturumunu kullanır.
 *
 *   node --import tsx apps/mcp/src/main.ts      (proje kökünden; .mcp.json bunu kullanır)
 *   TAGPRESS_URL=http://127.0.0.1:5499 …         (deneme sunucusu; eski adı STUDIO_URL da kabul edilir)
 *
 * stdout MCP protokolüne aittir: günlük yalnızca stderr'e yazılır.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.ts";

const { server, client } = buildServer();
await server.connect(new StdioServerTransport());
process.stderr.write(`tagpress MCP hazır → ${client.baseUrl}\n`);
