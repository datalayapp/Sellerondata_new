import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { PG_TEST_PREFIX, createSchemaDb, dropTestDbs, listTestDbs, newTestDbName } from "./pg.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Koşunun Postgres şablon veritabanı (göçler + test eki). */
    tagpressPgTemplate: string;
    /** Koşu etiketi (veritabanı adlarında; bitişte bu koşunun kalanları silinir). */
    tagpressPgRun: string;
  }
}

/**
 * `vitest.pg.config.ts` genel kurulumu: koşu başına bir şablon veritabanı açar (init.sql bölümü + göçler + test eki,
 * `test/pg.ts`); her test uygulaması bundan kopyalanır. Bitişte şablon ve bu koşunun kalmış veritabanları silinir.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Harfle başlar: süreç numarasıyla (genel kurulumsuz koşuların adı) karışmaz.
  const run = `r${randomUUID().replaceAll("-", "").slice(0, 5)}`;
  const template = await createSchemaDb(newTestDbName("_tmpl", run));
  project.provide("tagpressPgRun", run);
  project.provide("tagpressPgTemplate", template);
  return async () => {
    if (process.env.TEST_DB_KEEP === "1") return;
    await dropTestDbs(`${PG_TEST_PREFIX}${run}_`);
    // Genel kurulumsuz koşuların (tek dosya, varsayılan yapılandırma) şablonları: süreci bitmişse silinir.
    for (const pid of await untaggedTemplatePids()) if (!alive(pid)) await dropTestDbs(`${PG_TEST_PREFIX}${pid}_`);
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function untaggedTemplatePids(): Promise<number[]> {
  const names = await listTestDbs();
  return [...new Set(names.map((n) => /^tagpress_test_(\d+)_[0-9a-f]{8}_tmpl$/.exec(n)?.[1]).filter((p): p is string => !!p).map(Number))];
}
