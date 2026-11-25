import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runAiKeyCli } from '../src/cli/aiKey.ts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { createProviderProbe } from '../src/keystore/probe.ts';
import { KeyStore } from '../src/keystore/store.ts';
import { closeSuper, fakeKey, fakeProvider, resetKeys, superClient } from './helpers.ts';

/** Acil durum komutu: anahtar standart girdiden; çıktıda anahtar yok; her değişiklik `cli:<ad>` ile yönetici kaydında. */

afterAll(async () => {
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetKeys);

async function run(argv: string[], opts: { secret?: string; status?: Parameters<typeof fakeProvider>[0] } = {}) {
  const p = fakeProvider(opts.status);
  const keys = new KeyStore({ prisma: getPrisma(), ring: () => env.keyRing, probe: createProviderProbe({ baseUrls: () => env.providerBaseUrls, fetch: p.fetch }) });
  const out: string[] = [];
  const err: string[] = [];
  let asked = 0;
  const code = await runAiKeyCli(argv, keys, {
    readSecret: async () => {
      asked += 1;
      return opts.secret ?? '';
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), asked, calls: p.calls };
}

describe('ai-key', () => {
  it('set: standart girdiden okur, sınar, kaydeder; çıktıda yalnız son 4 hane', async () => {
    const key = fakeKey();
    const r = await run(['set', 'anthropic', '--operator', 'Gökcan'], { secret: `${key}\n` });
    expect(r.code).toBe(0);
    expect(r.asked).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.out).toContain(`…${key.slice(-4)}`);
    expect(`${r.out}${r.err}`).not.toContain(key);
    const audit = (await (await superClient()).query('SELECT "actorId", "actorName", action FROM ai."AdminAudit"')).rows;
    expect(audit).toEqual([{ actorId: 'cli:Gökcan', actorName: 'Gökcan', action: 'key.set' }]);
    const st = await run(['status']);
    expect(st.code).toBe(0);
    expect(st.out).toMatch(/anthropic: var \(….{4}\), giren Gökcan/);
    expect(st.out).toContain('gemini: yok');
    expect(st.out).not.toContain(key);
  });

  it('anahtar argüman olarak verilemez; --operator zorunlu; bilinmeyen sağlayıcı ve seçenek reddedilir', async () => {
    const key = fakeKey();
    const extra = await run(['set', 'anthropic', key, '--operator', 'x']);
    expect(extra.code).toBe(2);
    expect(extra.asked).toBe(0);
    expect(`${extra.out}${extra.err}`).not.toContain(key);
    expect((await (await superClient()).query('SELECT count(*)::int AS n FROM ai."ProviderKey"')).rows[0].n).toBe(0);
    expect((await run(['set', 'anthropic'], { secret: key })).code).toBe(2);
    expect((await run(['set', 'openai', '--operator', 'x'], { secret: key })).code).toBe(2);
    expect((await run(['set', 'anthropic', '--key', key, '--operator', 'x'])).code).toBe(2);
    expect((await run(['sil'])).code).toBe(2);
  });

  it('sağlayıcı reddederse kaydetmez (1); ulaşılamıyorsa --no-test ile kaydeder', async () => {
    const key = fakeKey();
    const rej = await run(['set', 'gemini', '--operator', 'x'], { secret: key, status: { gemini: 403 } });
    expect(rej.code).toBe(1);
    expect(rej.err).toMatch(/kabul etmedi/);
    const down = await run(['set', 'gemini', '--operator', 'x'], { secret: key, status: { gemini: 'down' } });
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/--no-test/);
    const forced = await run(['set', 'gemini', '--operator', 'x', '--no-test'], { secret: key, status: { gemini: 'down' } });
    expect(forced.code).toBe(0);
    expect(forced.calls).toHaveLength(0);
    expect(forced.out).toContain('sınanmadı');
    for (const r of [rej, down, forced]) expect(`${r.out}${r.err}`).not.toContain(key);
  });

  it('test ve remove; rotate-master', async () => {
    await run(['set', 'anthropic', '--operator', 'x'], { secret: fakeKey() });
    expect((await run(['test', 'anthropic', '--operator', 'x'])).code).toBe(0);
    expect((await run(['test', 'anthropic', '--operator', 'x'], { status: { anthropic: 401 } })).code).toBe(1);
    expect((await run(['test', 'gemini', '--operator', 'x'])).code).toBe(1);
    const rot = await run(['rotate-master', '--operator', 'x']);
    expect(rot.code).toBe(0);
    expect(rot.out).toMatch(/0 \/ 1 satır/);
    const rm = await run(['remove', 'anthropic', '--operator', 'x']);
    expect(rm.code).toBe(0);
    expect(rm.out).toContain('anthropic: yok');
  });
});
