import { ORG_HEADER } from '@sellerondata/contracts';
import { ApiError, createSessionClient } from '../src/session/client.ts';
import { sessionStatus } from '../src/session/status.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const beforeEach: (fn: () => void) => void;
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ME = '/api/account/me';
const REFRESH = '/api/account/auth/refresh';
const DATA = '/api/deciship/invoices';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stale = () => json(401, { error: { code: 'TOKEN_STALE', message: 'bayat' } });
const me = (org: string | null) =>
  json(200, { activeOrg: org ? { id: org, name: `Firma ${org}` } : null, orgs: org ? [{ id: org, name: `Firma ${org}`, status: 'ACTIVE' }] : [] });

type Call = { path: string; method: string; org: string | null };

/** Sunucunun bir sekmeye gördürdükleri: jetonun firması yenilemeyle değişir. */
function server(opts: { tokenOrg: string | null; refreshOrg?: string | null; dataStale?: boolean }) {
  const calls: Call[] = [];
  let org = opts.tokenOrg;
  let dataStale = opts.dataStale ?? false;
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const path = String(input);
    calls.push({ path, method: init.method ?? 'GET', org: new Headers(init.headers).get(ORG_HEADER) });
    if (path === REFRESH) {
      if (opts.refreshOrg !== undefined) org = opts.refreshOrg;
      dataStale = false;
      return json(200, { ok: true, activeOrgId: org });
    }
    if (path === ME) return me(org);
    if (dataStale) return stale();
    return json(200, { org });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, setOrg: (next: string | null) => (org = next), reads: () => calls.filter((c) => c.path === DATA) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// Önceki testin istemcileri aynı süreçte kanalda kalır; gecikmiş duyuruları sonraki testin durumunu değiştirmesin.
const RealChannel = globalThis.BroadcastChannel;
const openChannels: BroadcastChannel[] = [];
class TrackedChannel extends RealChannel {
  constructor(name: string) {
    super(name);
    openChannels.push(this);
  }
}

beforeEach(() => {
  openChannels.splice(0).forEach((c) => c.close());
  vi.stubGlobal('BroadcastChannel', TrackedChannel);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  sessionStatus.update({ orgChange: null, offline: false, busy: false });
});

describe('yenileme firmayı değiştirirse', () => {
  it('A sekmesinin okuması B firmasına tekrar gitmez, ORG_MISMATCH atar ve uyarı açılır', async () => {
    const s = server({ tokenOrg: 'A', refreshOrg: 'B', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    const error = await client.get(DATA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ORG_MISMATCH');
    expect(s.reads()).toHaveLength(1);
    await tick();
    expect(sessionStatus.get().orgChange?.current?.id).toBe('B');
    // Uyarı açıkken de okuma gitmez.
    await expect(client.get(DATA)).rejects.toMatchObject({ code: 'ORG_MISMATCH' });
    expect(s.reads()).toHaveLength(1);
  });

  it('firmayı öğrenme isteği (orgGuard false) durmaz', async () => {
    const s = server({ tokenOrg: 'A', refreshOrg: 'B', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    const res = await client.raw(DATA, { orgGuard: false });
    expect(res.status).toBe(200);
    expect(s.reads()).toHaveLength(2);
  });

  it('yazma tekrarı eski firma başlığıyla gider: kararı sunucu verir', async () => {
    const s = server({ tokenOrg: 'A', refreshOrg: 'B', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    await client.post(DATA, {});
    const writes = s.reads().filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.org).toBe('A');
  });

  it('uyarı kaldırılınca okumalar yeniden gider', async () => {
    const s = server({ tokenOrg: 'A', refreshOrg: 'B', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    await client.get(DATA).catch(() => undefined);
    await tick();
    s.setOrg('A');
    await sessionStatus.resumeOrg();
    await expect(client.get(DATA)).resolves.toEqual({ org: 'A' });
  });
});

describe('yenileme firmayı değiştirmezse', () => {
  it('okuma yenilemeden sonra tekrar gider, uyarı açılmaz', async () => {
    const s = server({ tokenOrg: 'A', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    await expect(client.get(DATA)).resolves.toEqual({ org: 'A' });
    expect(s.reads()).toHaveLength(2);
    await tick();
    expect(sessionStatus.get().orgChange).toBeNull();
  });

  it('firması henüz doğrulanmamış sayfa engellenmez', async () => {
    const s = server({ tokenOrg: 'A', refreshOrg: 'B', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.adoptCachedOrg('A');
    await expect(client.get(DATA)).resolves.toEqual({ org: 'B' });
  });

  it('firmasız sayfa askı kalkınca engellenmez, uyarı açılmaz, firmayı alır', async () => {
    const s = server({ tokenOrg: null, refreshOrg: 'A', dataStale: true });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg(null);
    await expect(client.get(DATA)).resolves.toEqual({ org: 'A' });
    expect(client.noteActiveOrg('A')).toBe(true);
    await tick();
    expect(sessionStatus.get().orgChange).toBeNull();
  });
});

describe('sekmeler arası duyuru', () => {
  const announce = (orgId: string | null) => {
    const other = new BroadcastChannel('sod-session');
    other.postMessage({ type: 'org', orgId });
    other.close();
  };

  it('firmasız sekme: uyarı açılmaz, firma alınır, /me yeniden sorulsun diye bildirilir, okumalar yeni firmayla gider', async () => {
    const s = server({ tokenOrg: 'A' });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg(null);
    const adopted = vi.fn();
    const stop = client.onOrgAdopted(adopted);
    announce('A');
    await vi.waitFor(() => expect(adopted).toHaveBeenCalledTimes(1));
    stop();
    expect(sessionStatus.get().orgChange).toBeNull();
    await expect(client.get(DATA)).resolves.toEqual({ org: 'A' });
    expect(s.reads().at(-1)?.org).toBe('A');
  });

  it('firmalı sekmede eski davranış: uyarı açılır, bildirim gitmez', async () => {
    const s = server({ tokenOrg: 'B' });
    const client = createSessionClient({ fetchImpl: s.fetchImpl });
    client.noteActiveOrg('A');
    const adopted = vi.fn();
    client.onOrgAdopted(adopted);
    announce('B');
    await vi.waitFor(() => expect(sessionStatus.get().orgChange?.current?.id).toBe('B'));
    expect(adopted).not.toHaveBeenCalled();
  });
});

describe('çıkış duyurusu', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });

  it('başka sekme çıkış yapınca bu sekme bir kez girişe gönderilir, kabuk önbelleği silinir', async () => {
    const s = server({ tokenOrg: 'A' });
    const onSessionLost = vi.fn();
    createSessionClient({ fetchImpl: s.fetchImpl, onSessionLost });
    sessionStorage.setItem('sod_me_cache', '{}');
    const other = new BroadcastChannel('sod-session');
    other.postMessage({ type: 'logout' });
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('sod_me_cache')).toBeNull();
    other.postMessage({ type: 'logout' });
    await tick();
    other.close();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(0); // bir sonraki isteği beklemez
  });

  it('announceLogout öbür sekmelere gider; duyuran sekmenin kendisi girişe gönderilmez', async () => {
    const s = server({ tokenOrg: 'A' });
    const mine = vi.fn();
    const theirs = vi.fn();
    const a = createSessionClient({ fetchImpl: s.fetchImpl, onSessionLost: mine });
    createSessionClient({ fetchImpl: s.fetchImpl, onSessionLost: theirs });
    a.announceLogout();
    await vi.waitFor(() => expect(theirs).toHaveBeenCalledTimes(1));
    await tick();
    expect(mine).not.toHaveBeenCalled();
  });

  it('firma duyurusu çıkış sayılmaz', async () => {
    const s = server({ tokenOrg: 'A' });
    const onSessionLost = vi.fn();
    const client = createSessionClient({ fetchImpl: s.fetchImpl, onSessionLost });
    client.noteActiveOrg('A');
    const other = new BroadcastChannel('sod-session');
    other.postMessage({ type: 'org', orgId: 'A' });
    await tick();
    other.close();
    expect(onSessionLost).not.toHaveBeenCalled();
  });
});

describe('noteActiveOrg', () => {
  it('firmasızdan firmaya kabul edilir, firmadan başka firmaya edilmez', async () => {
    const s = server({ tokenOrg: 'B' });
    const a = createSessionClient({ fetchImpl: s.fetchImpl });
    a.noteActiveOrg(null);
    expect(a.noteActiveOrg('B')).toBe(true);
    const b = createSessionClient({ fetchImpl: s.fetchImpl });
    b.noteActiveOrg('A');
    expect(b.noteActiveOrg('B')).toBe(false);
    await tick();
  });
});
