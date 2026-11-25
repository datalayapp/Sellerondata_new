import type { Usage } from "@tagpress/domain";
import { z } from "zod";
import type { CallLog, ClaudePort } from "./claude.ts";
import type { AiFailure } from "./errors.ts";

/**
 * Görseldeki yazıyı okuma (Haiku görsel). Görüntü modelinin yazdığı metni ve üretilen şablonda yazı olmadığını
 * denetlemek için.
 */
export const TRANSCRIBE_PROMPT_VERSION = "studio-transcribe-v1";

const SYSTEM = `You read printed labels. Transcribe every piece of text printed on the label exactly as it appears: same spelling, same capital and small letters, same punctuation and symbols (for example "&", "!", "♥"), in reading order, one entry per printed line. Never correct, complete or guess; write "?" for a letter you cannot read. Decorative shapes that are not letters are not text. If there is no text at all, return an empty list.`;

const Schema = z.object({ lines: z.array(z.string()).catch([]), legible: z.boolean().catch(true) });

export interface TranscribeResult {
  ok: boolean;
  lines: string[];
  /** Satırlar boşlukla birleştirilmiş. */
  text: string;
  legible: boolean;
  usage: Usage[];
  raw: string;
  calls: CallLog[];
  error?: AiFailure;
}

export async function transcribe(claude: ClaudePort, png: Buffer, opts: { signal?: AbortSignal; maxSide?: number } = {}): Promise<TranscribeResult> {
  const res = await claude.callJson({
    purpose: "transcribe",
    system: SYSTEM,
    // Okuma için biraz daha büyük görsel: ince el yazısında 768 px harf kaybettirebilir.
    content: [
      { type: "image", png, maxSide: opts.maxSide ?? 1024 },
      { type: "text", text: "Transcribe the printed text on this label." },
    ],
    schema: Schema,
    maxTokens: 4000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const lines = (res.data?.lines ?? []).map((l) => l.trim()).filter(Boolean);
  return {
    ok: res.ok,
    lines,
    text: lines.join(" "),
    legible: res.data?.legible ?? false,
    usage: res.usage,
    raw: res.raw,
    calls: res.calls,
    ...(res.error ? { error: res.error } : {}),
  };
}

/**
 * İki metin aynı mı? YALNIZCA boşluk ve satır sonu farkı tolere edilir (Unicode NFC birleştirmesiyle).
 * Harf, büyük/küçük harf ve noktalama farkı = farklı. `symbols` verilirse (ör. ["&"]) bu sembollerin
 * çevresindeki boşluk da yok sayılır (profil izin veriyorsa).
 */
export function sameText(a: string, b: string, symbols: readonly string[] = []): boolean {
  const canon = (s: string) => {
    let t = s.normalize("NFC").replace(/\s+/gu, " ").trim();
    for (const sym of symbols) {
      if (!sym.trim() || /[\p{L}\p{N}]/u.test(sym)) continue;
      t = t.split(sym).map((p) => p.trim()).join(sym);
    }
    return t;
  };
  return canon(a) === canon(b);
}
