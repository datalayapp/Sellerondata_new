import type { AiProvider } from '@sellerondata/contracts';
import { ZERO_USAGE, type MeteredUsage, type UsageIteration } from '../ledger/pricing.ts';
import { SseParser } from './sse.ts';

/**
 * Yanıttan kullanım ölçümü. Araca giden baytlar değişmez; ölçer aynı parçaların kopyasını okur.
 * - Anthropic akış: `message_start` (`message.model`, `usage`) + `message_delta` (`usage`, sonuncusu kazanır; gelen alan ezer),
 *   `message_stop` tamamlandı, `error` olayı hata türü. Önbelleğe yazma: `usage.cache_creation.ephemeral_5m/1h_input_tokens`, ayrıntı
 *   yoksa `cache_creation_input_tokens`'ın 1 sa olmayan kısmı 5 dk. `usage.iterations` (sunucu tarafı yedek model) kalem kalem.
 * - Anthropic JSON: aynı alanlar tek nesnede; hata gövdesinde `error.type`.
 * - Gemini (JSON, JSON dizisi ya da `alt=sse`): her parçada `modelVersion`, `usageMetadata` (sonuncusu kazanır; `promptTokenCount`
 *   önbellekten okunan düşülerek girdi, `cachedContentTokenCount` okuma, `candidatesTokenCount + thoughtsTokenCount` çıktı),
 *   görsel = `candidates[].content.parts[]` içindeki `inlineData`/`inline_data` görsel parçaları (parçalar toplanır); hata `error.status`.
 * Akan metin karakteri (kesilmede çıktı tahmini için) metin, düşünme ve araç girdisi parçalarından sayılır.
 */
export type MeterResult = {
  /** Sağlayıcı kullanım bildirdi mi (en az bir `usage`/`usageMetadata`). */
  hasUsage: boolean;
  usage: MeteredUsage;
  servedModel: string | null;
  /** Yanıt tamamlandı: Anthropic akışında `message_stop`, JSON'da gövde ayrıştı, Gemini'de gövde bitti ve ayrıştı. */
  completed: boolean;
  /** Sağlayıcının hata türü (Anthropic `error.type`, Gemini `error.status`) ya da null. */
  errorType: string | null;
  /** Gemini hata ayrıntısında `API_KEY_INVALID` var mı (anahtar reddi). */
  keyInvalid: boolean;
  streamedChars: number;
  /** Ölçüm sınırı aşıldı ya da gövde ayrıştırılamadı (kullanım bilinmiyor). */
  unreadable: boolean;
};

/** Ölçüm için en çok bu kadar bayt tutulur (JSON gövdeler); aşan yanıt aynen aktarılır, ölçüm tahmine düşer. */
export const METER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

export interface Meter {
  push(chunk: Uint8Array): void;
  finish(): MeterResult;
}

abstract class BaseMeter implements Meter {
  protected usage: MeteredUsage = { ...ZERO_USAGE };
  protected hasUsage = false;
  protected servedModel: string | null = null;
  protected completed = false;
  protected errorType: string | null = null;
  protected keyInvalid = false;
  protected chars = 0;
  protected unreadable = false;
  private sse: SseParser | null = null;
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(protected readonly mode: 'sse' | 'json') {
    if (mode === 'sse') this.sse = new SseParser((e) => this.safe(() => this.onSse(e.event, e.data)));
  }

  push(chunk: Uint8Array): void {
    if (this.sse) return this.sse.push(chunk);
    if (this.unreadable) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > METER_MAX_BUFFER_BYTES) {
      this.unreadable = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(chunk);
  }

  finish(): MeterResult {
    if (this.sse) {
      this.sse.end();
      if (this.sse.overflow) this.unreadable = true;
      this.onSseEnd();
    } else if (!this.unreadable) {
      const text = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      let parsed: unknown;
      try {
        parsed = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        this.unreadable = true;
      }
      if (parsed !== undefined) this.safe(() => this.onJson(parsed));
    }
    return {
      hasUsage: this.hasUsage,
      usage: this.usage,
      servedModel: this.servedModel,
      completed: this.completed && !this.unreadable,
      errorType: this.errorType,
      keyInvalid: this.keyInvalid,
      streamedChars: this.chars,
      unreadable: this.unreadable,
    };
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      // Beklenmeyen biçim: ölçüm bilinmiyor sayılır (aktarım etkilenmez).
      this.unreadable = true;
    }
  }

  protected abstract onSse(event: string, data: string): void;
  protected onSseEnd(): void {}
  protected abstract onJson(body: unknown): void;
}

// ---------- Anthropic ----------

class AnthropicMeter extends BaseMeter {
  protected onSse(_event: string, data: string): void {
    const d = JSON.parse(data) as Rec;
    switch (d.type) {
      case 'message_start':
        if (isRec(d.message)) {
          if (typeof d.message.model === 'string' && d.message.model) this.servedModel = d.message.model;
          this.applyUsage(d.message.usage);
        }
        break;
      case 'message_delta':
        this.applyUsage(d.usage);
        break;
      case 'content_block_start':
        if (isRec(d.content_block)) this.countText(d.content_block);
        break;
      case 'content_block_delta':
        if (isRec(d.delta)) this.countText(d.delta);
        break;
      case 'message_stop':
        this.completed = true;
        break;
      case 'error':
        this.errorType = isRec(d.error) && typeof d.error.type === 'string' ? d.error.type : 'error';
        break;
    }
  }

  protected onJson(body: unknown): void {
    if (!isRec(body)) return;
    if (body.type === 'error' || isRec(body.error)) {
      this.errorType = isRec(body.error) && typeof body.error.type === 'string' ? body.error.type : 'error';
      this.completed = true;
      return;
    }
    if (typeof body.model === 'string' && body.model) this.servedModel = body.model;
    this.applyUsage(body.usage);
    if (Array.isArray(body.content)) for (const b of body.content) if (isRec(b)) this.countText(b);
    this.completed = true;
  }

  private countText(b: Rec) {
    for (const k of ['text', 'thinking', 'partial_json'] as const) if (typeof b[k] === 'string') this.chars += (b[k] as string).length;
  }

  private applyUsage(raw: unknown) {
    if (!isRec(raw)) return;
    this.hasUsage = true;
    const u = this.usage;
    const input = num(raw.input_tokens);
    const output = num(raw.output_tokens);
    const read = num(raw.cache_read_input_tokens);
    if (input !== undefined) u.inputTokens = input;
    if (output !== undefined) u.outputTokens = output;
    if (read !== undefined) u.cacheReadTokens = read;
    const cc = isRec(raw.cache_creation) ? raw.cache_creation : null;
    const total = num(raw.cache_creation_input_tokens);
    if (cc) {
      const w5 = num(cc.ephemeral_5m_input_tokens);
      const w1 = num(cc.ephemeral_1h_input_tokens);
      if (w5 !== undefined) u.cacheWrite5mTokens = w5;
      if (w1 !== undefined) u.cacheWrite1hTokens = w1;
      // Ayrıntı toplamdan azsa kalan 5 dk sayılır (eksik sayılmasın).
      if (total !== undefined && total > u.cacheWrite5mTokens + u.cacheWrite1hTokens) u.cacheWrite5mTokens = total - u.cacheWrite1hTokens;
    } else if (total !== undefined && total !== u.cacheWrite5mTokens + u.cacheWrite1hTokens) {
      const w1 = Math.min(u.cacheWrite1hTokens, total);
      u.cacheWrite1hTokens = w1;
      u.cacheWrite5mTokens = total - w1;
    }
    if (Array.isArray(raw.iterations)) {
      const its: UsageIteration[] = [];
      for (const it of raw.iterations) {
        if (!isRec(it)) continue;
        const icc = isRec(it.cache_creation) ? it.cache_creation : null;
        const itTotal = num(it.cache_creation_input_tokens) ?? 0;
        const w1 = (icc && num(icc.ephemeral_1h_input_tokens)) || 0;
        const w5 = Math.max((icc && num(icc.ephemeral_5m_input_tokens)) || 0, itTotal - w1);
        its.push({
          model: typeof it.model === 'string' && it.model ? it.model : null,
          inputTokens: num(it.input_tokens) ?? 0,
          outputTokens: num(it.output_tokens) ?? 0,
          cacheReadTokens: num(it.cache_read_input_tokens) ?? 0,
          cacheWrite5mTokens: w5,
          cacheWrite1hTokens: w1,
          outputImages: 0,
        });
      }
      if (its.length) {
        u.iterations = its;
        // Toplamlar kalemlerden (kalemler fiyatlanır; satırın belirteç alanları bunların toplamıdır).
        u.inputTokens = its.reduce((n, i) => n + i.inputTokens, 0);
        u.outputTokens = its.reduce((n, i) => n + i.outputTokens, 0);
        u.cacheReadTokens = its.reduce((n, i) => n + i.cacheReadTokens, 0);
        u.cacheWrite5mTokens = its.reduce((n, i) => n + i.cacheWrite5mTokens, 0);
        u.cacheWrite1hTokens = its.reduce((n, i) => n + i.cacheWrite1hTokens, 0);
      }
    }
  }
}

// ---------- Gemini ----------

class GeminiMeter extends BaseMeter {
  private sawChunk = false;

  protected onSse(_event: string, data: string): void {
    this.chunk(JSON.parse(data));
  }

  protected onSseEnd(): void {
    // SSE akışının bitiş olayı yok: gövde temiz bittiyse ve en az bir parça geldiyse tamam.
    if (this.sawChunk && !this.errorType) this.completed = true;
  }

  protected onJson(body: unknown): void {
    if (Array.isArray(body)) for (const c of body) this.chunk(c);
    else this.chunk(body);
    if (this.sawChunk || this.errorType) this.completed = true;
  }

  private chunk(c: unknown) {
    if (!isRec(c)) return;
    if (isRec(c.error)) {
      this.errorType = typeof c.error.status === 'string' ? c.error.status : `http_${num(c.error.code) ?? 0}`;
      const text = JSON.stringify(c.error);
      if (text.includes('API_KEY_INVALID')) this.keyInvalid = true;
      return;
    }
    this.sawChunk = true;
    if (typeof c.modelVersion === 'string' && c.modelVersion) this.servedModel = c.modelVersion;
    const m = isRec(c.usageMetadata) ? c.usageMetadata : null;
    if (m) {
      this.hasUsage = true;
      const prompt = (num(m.promptTokenCount) ?? 0) + (num(m.toolUsePromptTokenCount) ?? 0);
      const cached = num(m.cachedContentTokenCount) ?? 0;
      this.usage.inputTokens = Math.max(0, prompt - cached);
      this.usage.cacheReadTokens = cached;
      this.usage.outputTokens = (num(m.candidatesTokenCount) ?? 0) + (num(m.thoughtsTokenCount) ?? 0);
    }
    if (Array.isArray(c.candidates)) {
      for (const cand of c.candidates) {
        const parts = isRec(cand) && isRec(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
        for (const p of parts) {
          if (!isRec(p)) continue;
          if (typeof p.text === 'string') this.chars += p.text.length;
          const inline = isRec(p.inlineData) ? p.inlineData : isRec(p.inline_data) ? p.inline_data : null;
          const mime = inline ? (inline.mimeType ?? inline.mime_type) : undefined;
          if (inline && typeof mime === 'string' && mime.startsWith('image/')) this.usage.outputImages += 1;
        }
      }
    }
  }
}

export function createMeter(provider: AiProvider, contentType: string | null): Meter {
  const sse = (contentType ?? '').toLowerCase().includes('text/event-stream');
  return provider === 'anthropic' ? new AnthropicMeter(sse ? 'sse' : 'json') : new GeminiMeter(sse ? 'sse' : 'json');
}

// ---------- İstek gövdesi ----------

/** Gövdedeki görsel girdi sayısı (bilgi; fiyat tokenle): Anthropic `type: 'image'` blokları, Gemini görsel `inlineData` parçaları. */
export function countInputImages(provider: AiProvider, body: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Rec;
    if (provider === 'anthropic' && o.type === 'image') n += 1;
    if (provider === 'gemini') {
      const inline = isRec(o.inlineData) ? o.inlineData : isRec(o.inline_data) ? o.inline_data : null;
      const mime = inline ? (inline.mimeType ?? inline.mime_type) : undefined;
      if (typeof mime === 'string' && mime.startsWith('image/')) n += 1;
    }
    for (const [k, x] of Object.entries(o)) {
      // Görsel verisinin kendisine inilmez (base64 metin).
      if (k === 'data' || k === 'source') continue;
      walk(x, depth + 1);
    }
  };
  if (provider === 'anthropic') walk(isRec(body) ? body.messages : undefined, 0);
  else walk(isRec(body) ? body.contents : undefined, 0);
  return n;
}
