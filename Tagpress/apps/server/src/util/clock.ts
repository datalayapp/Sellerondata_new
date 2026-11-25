/** Saat (testlerde ileri sarılabilir). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Elle ilerletilen saat (testler). */
export class ManualClock implements Clock {
  constructor(private t = new Date("2026-10-09T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const iso = (c: Clock) => c.now().toISOString();
export const DAY_MS = 86_400_000;
