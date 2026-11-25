import { type ProfileRecord, ProfileSchema } from "@tagpress/domain";

/**
 * Biçimleyici testlerinin sabit girdileri. `format.golden.json` bu girdilerle, biçimleyiciler `apps/mcp`'den
 * taşınmadan ÖNCE üretildi; taşınmış hâlin çıktısı bayt bayt aynı olmalı (`format.test.ts`).
 */

const profile = ProfileSchema.parse({
  name: "Deneme",
  sizing: { fill: 0.93 },
  ai: { instructions: "Zarif ve ferah.\nİsim belirgin." },
  lineBreaking: { examples: [{ text: "Mina & Ali 12.09.2026", lines: ["Mina", "&", "Ali", "12.09.2026"] }] },
});

export const FIXTURE_PROFILE_RECORD: ProfileRecord = {
  id: "x",
  languageId: "dil",
  version: 3,
  status: "published",
  data: profile,
  note: "",
  createdAt: "2026-10-09T00:00:00Z",
} as ProfileRecord;

/** Profil verisine açıklamasız bir alan eklenmiş hâli (biçimleyicinin "Açıklamasız alanlar" bölümü için). */
export const FIXTURE_PROFILE_EXTRA = { ...profile, deneme: { yeni: 1 } };

export const FIXTURE_SAMPLES = [
  {
    id: "ref-1",
    text: "Mina & Ali",
    templateKey: "7",
    split: "train",
    orderNo: "1001",
    labelFramePx: 440,
    lines: [
      { text: "Mina", font: "script", sizePx: 80, pt: 24, segments: [] },
      { text: "&", font: "serif", sizePx: 40, pt: 12, segments: [{ text: "&", font: "serif", sizePx: 40 }] },
      { text: "Ali", font: "script", sizePx: 80, pt: 24, segments: [] },
    ],
    program: ["Mina & Ali"],
    imageUrl: "/api/x.png",
  },
  {
    id: "ref-2",
    text: "Teşekkürler\n2026",
    templateKey: null,
    split: "test",
    orderNo: null,
    labelFramePx: 600,
    lines: [{ text: "Teşekkürler 2026", font: "sans", sizePx: 50, pt: 15, segments: [] }],
    program: ["Teşekkürler 2026"],
    imageUrl: null,
  },
];

const metrics = { n: 10, within10: 7, failed: 1, sizeRatio: 1.04, sizeError: 0.06, heightError: 0.1, positionError: 3.25, dx: 1.5, dy: -2, gapNormal: 0.12, gapBeforeLast: null, gapConnector: 0.3 };

export const FIXTURE_REPLAYS = [
  {
    refs: 10,
    split: "test",
    sides: [
      {
        label: "Taslak (v4)",
        metrics,
        summary: { gaps: { normal: { n: 8, user: 0.2, engine: 0.25 } } },
        worst: [
          { id: "ref-3", templateKey: "7", ok: true, reason: null, sizeRatio: 1.3, dx: 4, dy: 2 },
          { id: "ref-4", templateKey: null, ok: false, reason: "sığmadı", sizeRatio: 0, dx: 0, dy: 0 },
        ],
      },
      { label: "Yayınlanan (v3)", metrics: { ...metrics, failed: 0, sizeRatio: null }, summary: { gaps: {} }, worst: [] },
    ],
  },
  { refs: 3, split: "train", sides: [] },
  { refs: 5, split: "all", sides: [] },
];
