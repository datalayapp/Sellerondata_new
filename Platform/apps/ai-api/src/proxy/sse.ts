/**
 * Artımlı SSE ayrıştırıcı (yalnız ölçüm için; araca giden baytlar buradan geçmez, olduğu gibi aktarılır). Olaylar boş satırla
 * ayrılır; `event:` ve `data:` alanları (çok satırlı `data` `\n` ile birleşir), `:` yorum satırı yok sayılır. `\r\n`, `\n`, `\r`
 * satır sonları kabul edilir. Tek olay `maxEventBytes`'ı aşarsa ayrıştırma durur (`overflow`): ölçüm tahmine düşer, akış sürer.
 */
export type SseEvent = { event: string; data: string };

export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private buf = '';
  private event = '';
  private data: string[] = [];
  overflow = false;

  constructor(
    private readonly onEvent: (e: SseEvent) => void,
    private readonly maxEventBytes = 32 * 1024 * 1024,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.overflow) return;
    this.buf += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(): void {
    if (this.overflow) return;
    this.buf += this.decoder.decode();
    this.drain(true);
    this.dispatch();
  }

  private drain(final: boolean): void {
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // Sonda tek `\r` varsa ardından `\n` gelebilir: sonraki parçayı bekle.
      if (!final && m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line);
      if (this.overflow) return;
    }
    if (final && this.buf) {
      this.line(this.buf);
      this.buf = '';
    }
    if (this.buf.length + this.data.reduce((n, d) => n + d.length, 0) > this.maxEventBytes) {
      this.overflow = true;
      this.buf = '';
      this.data = [];
    }
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }

  private dispatch(): void {
    if (this.data.length) this.onEvent({ event: this.event || 'message', data: this.data.join('\n') });
    this.event = '';
    this.data = [];
  }
}
