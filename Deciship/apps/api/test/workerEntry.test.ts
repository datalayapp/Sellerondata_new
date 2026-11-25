/**
 * İş çalıştırıcı girişi (KALANLAR 6.17, `src/worker.ts` → `dist/worker.js`): ayrı süreç olarak açılır, HTTP dinlemez, test
 * veritabanına bağlanır. HTTP tarafı `JOB_RUNNER=off` iken kuyruğa yazılan işi alır ve bitirir, sağlık dosyasını yazar,
 * kapanış isteğinde süren işi bırakıp 0 ile çıkar ve sağlık dosyasını siler.
 *
 * Kapanış Linux'ta (CI) gerçek SIGTERM ile, Windows'ta IPC `shutdown` iletisiyle istenir (Windows'ta sinyal süreci doğrudan
 * öldürür; iki yol da aynı kapanış işlevine gider). Derlenmiş girişin kendi gövdesini taşıdığı test/cli-entries.test.mjs'te.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { findJob } from '../src/services/jobs/queue.ts';
import { getApp, registerCompany, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
const API_ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string, output: () => string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi\n${output()}`);
}

describe('iş çalıştırıcı girişi (src/worker.ts)', () => {
  let app: FastifyInstance;
  let sup: pg.Client;
  let child: ChildProcess | null = null;
  let output = '';
  const healthFile = path.join(os.tmpdir(), `deciship-worker-test-${process.pid}.alive`);

  const closeLeftovers = () =>
    sup.query(`UPDATE "Job" SET "status" = 'CANCELLED', "finishedAt" = now() AT TIME ZONE 'UTC', "lockedBy" = NULL, "lockedUntil" = NULL WHERE "status" IN ('QUEUED', 'RUNNING')`);

  beforeAll(async () => {
    app = await getApp();
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
    // Başka test dosyalarından kalan bekleyen iş bu sürece düşmesin (gerçek işleyiciler çalışır).
    await closeLeftovers();
    fs.rmSync(healthFile, { force: true });
  });

  afterAll(async () => {
    // Test düşse de süreç kalmasın: yalnız bu testin başlattığı süreç, PID'iyle.
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    vi.unstubAllEnvs();
    fs.rmSync(healthFile, { force: true });
    await closeLeftovers();
    await sup.end();
  });

  it('HTTP JOB_RUNNER=off iken kuyruğa yazılan işi ayrı süreç alır; sağlık dosyası; kapanışta 0 ile çıkar', async () => {
    const firm = await registerCompany(app, uniq('Çalıştırıcı '));
    // HTTP tarafı yalnız kuyruğa yazar (ayrı kap düzeni).
    vi.stubEnv('JOB_RUNNER', 'off');
    const preview = () => app.inject({ method: 'POST', url: `${API}/settings/recompare-invoices/preview?async=1`, headers: firm.auth, payload: {} });
    const first = await preview();
    expect(first.statusCode, first.body).toBe(202);
    const firstId = first.json().job.id as string;
    expect(first.json().job.status).toBe('QUEUED');

    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    child = spawn(process.execPath, ['--import', tsx, 'src/worker.ts'], {
      cwd: API_ROOT,
      // Ortak ortam dosyasındaki JOB_RUNNER=off çalıştırıcıda yok sayılır.
      env: { ...process.env, JOB_RUNNER: 'off', JOB_POLL_MS: '100', WORKER_HEALTH_FILE: healthFile },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child!.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const out = () => output;

    const status = async (id: string) => (await findJob(firm.companyId, id))?.status;
    await until(async () => (await status(firstId)) === 'SUCCEEDED', 60_000, 'ilk iş', out);
    await until(() => fs.existsSync(healthFile), 20_000, 'sağlık dosyası', out);
    expect(Date.now() - fs.statSync(healthFile).mtimeMs).toBeLessThan(60_000);

    // Süreç açıkken eklenen iş de yoklamayla alınır (HTTP süreci uyandıramaz: ayrı süreç).
    const second = await preview();
    expect(second.statusCode, second.body).toBe(202);
    const secondId = second.json().job.id as string;
    expect(secondId).not.toBe(firstId);
    await until(async () => (await status(secondId)) === 'SUCCEEDED', 20_000, 'ikinci iş', out);

    const done = await findJob(firm.companyId, secondId);
    expect(done).toMatchObject({ attempts: 1, lockedBy: null, lockedUntil: null });

    if (process.platform === 'win32') child.send('shutdown');
    else child.kill('SIGTERM');
    const res = await Promise.race([exited, sleep(45_000).then(() => null)]);
    expect(res, output).toEqual({ code: 0, signal: null });
    expect(output).toMatch(/"msg":"worker started"/);
    expect(output).toMatch(/"msg":"JOB_RUNNER ignored in the worker/);
    expect(output).toMatch(/"msg":"worker stopped"/);
    expect(fs.existsSync(healthFile)).toBe(false);
    // Hiçbir HTTP portu açılmadı, iş kirası kalmadı.
    expect(output).not.toMatch(/Server listening/);
    const held = await sup.query(`SELECT count(*)::int AS n FROM "Job" WHERE "lockedBy" LIKE $1`, [`%:${child.pid}:%`]);
    expect(held.rows[0].n).toBe(0);
  });
});
