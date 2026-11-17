import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '../lib/fixtures.ts';
import { E2E_DIR, PLATFORM } from '../lib/sys.ts';

/**
 * Canlı hacim senaryosu: eski init.sql (sod_admin dönemi) + eski Hesap şeması + veri. Kendi kabı ve ağı vardır, hiçbir hacmi paylaşmaz.
 * Sıra compose'daki gibi: postgres-upgrade -> prisma migrate deploy (migration rolüyle).
 */
const C = 'sod-e2e-oldvol-pg';
const NET = 'sod-e2e-oldvol';
const IMAGE = 'sod-e2e-account-migrate';
const REPO = path.resolve(E2E_DIR, '..');

const docker = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8' });
const psql = (user: string, password: string, sql: string) => {
  const r = docker('exec', '-e', `PGPASSWORD=${password}`, C, 'psql', '-h', '127.0.0.1', '-U', user, '-d', 'sellerondata', '-v', 'ON_ERROR_STOP=1', '-Atc', sql);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
};
const gitShow = (ref: string) => execFileSync('git', ['-C', REPO, '-c', 'core.autocrlf=false', 'show', ref], { encoding: 'utf8' });

test.describe('postgres-upgrade: var olan hacim', () => {
  test.afterEach(() => {
    docker('rm', '-f', '-v', C);
    docker('network', 'rm', NET);
  });

  test('eski rol düzenli hacim yükselir, veri kalır, ikinci çalıştırma zararsız, migration ilerler', async () => {
    docker('rm', '-f', '-v', C);
    docker('network', 'rm', NET);
    docker('network', 'create', NET);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sod-oldvol-'));
    const oldInit = path.join(tmp, 'init.sql');
    fs.writeFileSync(oldInit, gitShow('8cf8f71:infra/postgres/init.sql'));
    expect(docker('run', '-d', '--name', C, '--network', NET, '-e', 'POSTGRES_PASSWORD=su', '-v', `${oldInit.replaceAll('\\', '/')}:/docker-entrypoint-initdb.d/01-init.sql:ro`, 'postgres:17').status).toBe(0);
    await expect.poll(() => psql('postgres', 'su', 'select 1').out, { timeout: 60_000 }).toBe('1');

    // Eski Hesap şeması, eski rol sod_admin ile. Bir kayıt: yükseltmede kaybolmamalı.
    const old = gitShow('22e6a59:apps/account-api/prisma/migrations/20261106000000_init/migration.sql');
    const mig = path.join(tmp, 'old.sql');
    // Geçmiş tablosu yok: psql ile uygulanıyor, aşağıda `migrate resolve` açar.
    const withoutHistory = old.split('\n').filter((l) => !l.includes('_prisma_migrations')).join('\n');
    fs.writeFileSync(mig, `SET search_path = platform; ${withoutHistory}`);
    expect(docker('cp', mig, `${C}:/tmp/old.sql`).status).toBe(0);
    const applied = docker('exec', '-e', 'PGPASSWORD=sod_admin_dev', C, 'psql', '-h', '127.0.0.1', '-U', 'sod_admin', '-d', 'sellerondata', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/old.sql');
    expect(applied.status, applied.stderr).toBe(0);
    const ins = psql('postgres', 'su', `INSERT INTO platform."Person"(id,name,email,"passwordHash",locale,"updatedAt") VALUES ('11111111-1111-7111-8111-111111111111','Eski Kişi','eski@e2e.test','x','tr',now())`);
    expect(ins.code, ins.err).toBe(0);
    expect(psql('postgres', 'su', `select pg_get_userbyid(relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and relname='Person'`).out).toBe('sod_admin');

    // upgrade.sql: compose'daki komutun aynısı, iki kez.
    // Compose ./infra/postgres klasörünü bağlar: betik init.sql'in hak bölümünü oradan okur.
    expect(docker('exec', C, 'mkdir', '-p', '/infra').status).toBe(0);
    expect(docker('cp', path.join(PLATFORM, 'infra', 'postgres'), `${C}:/infra/postgres`).status).toBe(0);
    for (const run of [1, 2]) {
      // İkinci çalıştırma Windows klonu gibi CRLF dosyalarla: autocrlf açık klonda betik burada durmuştu.
      if (run === 2) expect(docker('exec', C, 'sh', '-c', "sed -i 's/\\r$//; s/$/\\r/' /infra/postgres/upgrade.sql /infra/postgres/init.sql; rm -f /tmp/sod-db-setup.sql*").status).toBe(0);
      const r = docker('exec', '-e', 'PGPASSWORD=su', '-e', 'SOD_PLATFORM_ADMIN_DB_PASSWORD=sod_platform_admin_dev', '-e', 'SOD_DECISHIP_ADMIN_DB_PASSWORD=sod_deciship_admin_dev', C, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'sellerondata', '-v', 'ON_ERROR_STOP=1', '-f', '/infra/postgres/upgrade.sql');
      expect(r.status, `çalıştırma ${run}: ${r.stderr}`).toBe(0);
    }
    expect(psql('postgres', 'su', `select pg_get_userbyid(relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and relname='Person'`).out).toBe('sod_platform_admin');
    expect(psql('postgres', 'su', `select pg_get_userbyid(nspowner) from pg_namespace where nspname='deciship'`).out).toBe('sod_deciship_admin');
    expect(psql('postgres', 'su', `select name from platform."Person" where email='eski@e2e.test'`).out).toBe('Eski Kişi');
    expect(psql('postgres', 'su', `select count(*) from pg_roles where rolname like 'sod\\_%' and (rolcreatedb or rolcreaterole or rolbypassrls or rolsuper)`).out).toBe('0');

    // Uygulama rolü sınırları
    const denied = psql('sod_platform', 'sod_platform_dev', 'CREATE TABLE platform.x(i int)');
    expect(denied.code).not.toBe(0);
    expect(denied.err).toContain('permission denied');

    // Migration rolüyle ilerleme: eski migration uygulanmış sayılır, yeniler uygulanır.
    const url = `postgresql://sod_platform_admin:sod_platform_admin_dev@${C}:5432/sellerondata?schema=platform`;
    const prisma = (...a: string[]) => docker('run', '--rm', '--network', NET, '-e', `MIGRATE_DATABASE_URL=${url}`, IMAGE, 'npx', 'prisma', 'migrate', ...a);
    const resolved = prisma('resolve', '--applied', '20261106000000_init');
    expect(resolved.status, resolved.stdout + resolved.stderr).toBe(0);
    const deployed = prisma('deploy');
    expect(deployed.status, deployed.stdout + deployed.stderr).toBe(0);
    expect(psql('postgres', 'su', `select name from platform."Person" where email='eski@e2e.test'`).out).toBe('Eski Kişi');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
