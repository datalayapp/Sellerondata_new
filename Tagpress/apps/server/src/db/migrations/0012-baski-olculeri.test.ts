import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ProfileSchema, upgradeProfileInput } from "@tagpress/domain";
import { openDatabase } from "../database.ts";
import { MIGRATIONS } from "./index.ts";
import { migration as runMigration12 } from "./0012-baski-olculeri.ts";

const at = "2026-11-21T00:00:00.000Z";
const env = { now: () => at, newId: () => "id" };

function setup(): DatabaseSync {
  const db = openDatabase(":memory:", { backupDir: null });
  for (const org of ["firma-a", "firma-b"]) {
    db.prepare("INSERT OR IGNORE INTO orgs (id, name, source, created_at) VALUES (?, ?, 'local', ?)").run(org, org, at);
    db.prepare("INSERT INTO languages (id, name, created_at, org_id) VALUES (?, 'Dil', ?, ?)").run(`dil-${org}`, at, org);
  }
  return db;
}

const rows = (db: DatabaseSync, table: "profile_versions" | "print_templates") =>
  db.prepare(`SELECT id, org_id, data FROM ${table} ORDER BY id`).all() as { id: string; org_id: string; data: string }[];

describe("göç 12: baskı ölçüleri", () => {
  it("dizide 12. sırada; profil sürümlerine dokunmaz (yayımlanmış sürüm değişmez); oturumlara plan sürümü 1 (eski ölçü)", () => {
    expect(MIGRATIONS[11]).toBe(runMigration12);
    const db = setup();
    const ins = db.prepare(`INSERT INTO profile_versions (id, language_id, version, status, data, created_at, org_id) VALUES (?, ?, ?, 'published', ?, '${at}', ?)`);
    ins.run("p1", "dil-firma-a", 1, JSON.stringify({ name: "Eski", printing: { dpi: 300, stickerDpi: 72 } }), "firma-a");
    const before = rows(db, "profile_versions");
    db.prepare(`INSERT INTO print_sessions (org_id, id, language_id, name, status, version, template_id, job_ids, created_at, updated_at) VALUES ('firma-a', 's1', 'dil-firma-a', 'S', 'draft', 0, NULL, '[]', '${at}', '${at}')`).run();
    runMigration12(db, env);
    expect(rows(db, "profile_versions")).toEqual(before);
    // Okuma anındaki çeviri 72'yi kaldırır (varsayılan 300).
    expect(ProfileSchema.parse(upgradeProfileInput(JSON.parse(before[0]!.data))).printing.stickerDpi).toBe(300);
    expect(db.prepare("SELECT plan_version FROM print_sessions WHERE id = 's1'").get()).toEqual({ plan_version: 1 });
  });

  it("sayfa şablonu: eklentinin 595 × 842 pt kağıdı tam A4 olur; gerçek ölçüler, yuvalar ve bozuk satır aynen kalır", () => {
    const db = setup();
    const ins = db.prepare(`INSERT INTO print_templates (id, language_id, name, kind, data, created_at, updated_at, org_id) VALUES (?, ?, 'T', ?, ?, '${at}', '${at}', ?)`);
    const flow = { marginTopMm: 7.76, marginBottomMm: 8.47, marginSideMm: 7.06, minGapXMm: 5.29, minRowGapMm: 4.59, maxRowGapLastMm: 6.35 };
    const pt = (v: number) => (v * 25.4) / 72;
    const cases: [string, string, string][] = [
      ["firma-a", "sticker", JSON.stringify({ kind: "sticker", paper: { wMm: pt(595), hMm: pt(842) }, slots: [], stickerFlow: flow })],
      ["firma-b", "sticker", JSON.stringify({ kind: "sticker", paper: { wMm: 209.9, hMm: 297.04 }, slots: [] })],
      ["firma-a", "sticker", '{"kind":"sticker","paper":{"wMm":210,"hMm":297},"slots":[]}'],
      ["firma-a", "label", JSON.stringify({ kind: "label", paper: { wMm: 210, hMm: 297 }, slots: [{ id: "s1", cx: 26, cy: 29, w: 38, h: 38 }] })],
      ["firma-a", "label", JSON.stringify({ kind: "label", paper: { wMm: 215.9, hMm: 279.4 }, slots: [] })],
      ["firma-a", "label", JSON.stringify({ kind: "label", paper: { wMm: 209.5, hMm: 297 }, slots: [] })],
      ["firma-b", "label", "bozuk"],
      ["firma-b", "label", JSON.stringify({ kind: "label", paper: { wMm: "209.9", hMm: 297.04 } })],
    ];
    cases.forEach(([org, kind, data], i) => ins.run(`t${i}`, `dil-${org}`, kind, data, org));
    const before = rows(db, "print_templates");

    runMigration12(db, env);
    const after = rows(db, "print_templates");
    expect(JSON.parse(after[0]!.data)).toEqual({ kind: "sticker", paper: { wMm: 210, hMm: 297 }, slots: [], stickerFlow: flow });
    expect(JSON.parse(after[1]!.data).paper).toEqual({ wMm: 210, hMm: 297 });
    for (const i of [2, 3, 4, 5, 6, 7]) expect(after[i]).toEqual(before[i]); // tam A4 metni de bayt bayt aynı
    expect(after.map((r) => r.org_id)).toEqual(before.map((r) => r.org_id));

    runMigration12(db, env);
    expect(rows(db, "print_templates")).toEqual(after);
  });
});
