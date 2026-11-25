import { DatabaseSync } from 'node:sqlite';

/** `expo-sqlite` arayüzünün kullandığımız kısmı, gerçek SQLite üzerinde. Testler SQL'in kendisini sınar. */
export function openTestDb() {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    getFirstAsync: async <T,>(sql: string, ...params: never[]) => (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: never[]) => raw.prepare(sql).all(...params) as T[],
    runAsync: async (sql: string, ...params: never[]) => {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
  };
}

export type TestDb = ReturnType<typeof openTestDb>;

/** İmzasız test jetonu. İstemci imzayı doğrulamaz, yalnız kapsamı okur. */
export function fakeToken(claims: { sub: string; org: string | null; ep?: number; name?: string; prod?: unknown; iat?: number; exp?: number }): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'EdDSA' })}.${b64({ ep: 0, prod: {}, ...claims })}.sig`;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(status: number, code: string, message = code): Response {
  return jsonResponse(status, { error: { code, message } });
}
