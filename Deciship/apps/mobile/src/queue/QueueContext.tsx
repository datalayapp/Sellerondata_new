import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Api, jpegPart, type MeasurementItem, type MeasurementPayload } from '../api/endpoints';
import { ApiError, currentPersonId, currentSessionScope, hasSession, pingServer, recoverOrgSession } from '../api/client';
import { friendlyError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { sameScope, scopeKey, type SessionScope } from '../auth/token';
import { copyToQueue, deleteQueueDir, deleteQuietly, fileExists } from '../lib/images';
import { startOfToday } from '../lib/format';
import { isUpgradeRequired, loadUpgradeFlag, onUpgradeChange } from '../version/policy';
import { backoffDelay, createRecovery, PAUSE_MS, recoverQueueSession, runFlush, wirePayload } from './flush';
import { createReach, REACH_TIMEOUT_MS } from './reach';
import { createFlushGate, type FlushTrigger } from './schedule';
import {
  countUnsent,
  deletableOtherSessions,
  deleteOtherSessions,
  deleteUnsent,
  findUnsentByTracking,
  getRow,
  insertRow,
  pendingByOrg,
  recoverInterrupted,
  reinsertRow,
  rowExists,
  rowsSince,
  summarizeOtherSessions,
  unsentGroups,
  updateSentFromServer,
  updateUnsent,
  type OtherSessions,
  type QueuePhoto,
  type QueueRow,
} from './store';

export { backoffDelay };

const RETRY_TICK_MS = 15000;
const NO_OTHERS: OtherSessions = { samePerson: 0, otherPerson: 0, total: 0 };

type QueueState = {
  /** Sunucuya ulaşılıyor (internete değil; KALANLAR 4.9, `reach.ts`). */
  online: boolean;
  flushing: boolean;
  /** Bu oturumun (kişi + firma) bekleyenleri. */
  pending: number;
  errors: number;
  rows: QueueRow[];
  version: number;
  /** Bu telefonda başka oturumda bekleyen kayıtlar. Burada gönderilmez, silinmez. */
  others: OtherSessions;
  /** `others` içinden bu oturumun silebildikleri. */
  deletableOthers: number;
  /** Kişinin firma başına bekleyen kayıtları. */
  pendingOrgs: Record<string, number>;
  /** Sunucu kaydı kayda özgü olmayan bir hatayla geri çevirdi (adres, dosya sınırı…): kayıtlar bekler, yönetici bilmeli. */
  serverIssue: boolean;
  /** Uygulamanın güncellenmesi gerekiyor (426): hiçbir gönderim yapılmaz, kayıtlar olduğu gibi bekler. */
  upgradeRequired: boolean;
  enqueue: (data: MeasurementPayload, photos: QueuePhoto[]) => Promise<void>;
  /**
   * force: elle "Gönder" (hatalıları da dener, bekleme süresini atlar; sunucunun `retry-after` süresi yine beklenir).
   * force olmadan sunucu ya da ağ hatasından sonraki bekleme süresine uyar (`schedule.ts`).
   */
  flush: (force?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  getLocal: (clientId: string) => Promise<QueueRow | null>;
  findUnsent: (tracking: string) => Promise<QueueRow | null>;
  /** Gönderilmemiş kaydı yerelde düzeltir. Kayıt bu arada gönderildiyse `false`. */
  editLocal: (clientId: string, data: MeasurementPayload, photos: QueuePhoto[]) => Promise<boolean>;
  /** Gönderilmemiş kaydı kuyruktan çıkarır; dosyalar `purgeLocal` çağrılana dek durur (Geri al için). */
  removeLocal: (clientId: string) => Promise<QueueRow | null>;
  undoRemoveLocal: (row: QueueRow) => Promise<void>;
  purgeLocal: (clientId: string) => void;
  /** Gönderilmiş ölçüm sunucuda düzeltildi: telefondaki satır yeni sürüme taşınır ("Son okunanlar" eski değeri göstermez). */
  noteServerEdit: (oldServerId: string, next: MeasurementItem) => Promise<void>;
  /** Bu oturumun silmeye yetkili olduğu başka oturum kayıtlarını ve fotoğraflarını kalıcı olarak siler. Silinen sayıyı döner. */
  purgeOtherSessions: () => Promise<number>;
};

const QueueCtx = createContext<QueueState | null>(null);

async function sendRow(row: QueueRow, scope: SessionScope): Promise<string | null> {
  const fd = new FormData();
  const photos = row.photos.filter((p) => fileExists(p.uri));
  const data: MeasurementPayload = wirePayload({ ...row.data, photoKinds: photos.map((p) => p.kind) });
  fd.append('data', JSON.stringify(data));
  photos.forEach((p) => fd.append('photos', jpegPart(p.uri)));
  const res = await Api.postMeasurement(fd, scope);
  return res?.measurement?.id ?? null;
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const { scope, refreshProfile, access } = useAuth();
  const canManage = access.has('deciship.measurements.manage');
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;
  const sessionKey = scopeKey(scope);
  /** "Çevrimiçi" = sunucunun sağlık ucu cevap veriyor (önbellekli, seyrek yoklama; `reach.ts`). */
  const reach = useRef(createReach({ probe: () => pingServer(REACH_TIMEOUT_MS) })).current;
  const [online, setOnline] = useState(reach.reachable);
  const [flushing, setFlushing] = useState(false);
  const [counts, setCounts] = useState({ pending: 0, error: 0 });
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [others, setOthers] = useState<OtherSessions>(NO_OTHERS);
  const [deletableOthers, setDeletableOthers] = useState(0);
  const [pendingOrgs, setPendingOrgs] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  const [serverIssue, setServerIssue] = useState(false);
  const [upgradeRequired, setUpgradeRequired] = useState(isUpgradeRequired);
  const busy = useRef(false);
  /** Yarıda kalmış gönderimler önce geri alınır: yeni gönderimle yarışmasın. Hata verirse sonraki gönderim yeniden dener. */
  const recovery = useRef(createRecovery(recoverInterrupted)).current;
  /** Bekleme ve engel durumu (11-B1): sunucu ya da ağ hatasında üstel bekleme, yetki engelinde `PAUSE_MS`. */
  const gate = useRef(createFlushGate()).current;

  const reload = useCallback(async () => {
    // Kapsam React durumundan değil jetondan: oturum değişiminin hemen ardından eski firma görünmesin.
    const sc = currentSessionScope();
    const person = currentPersonId();
    const [c, r, groups] = await Promise.all([
      sc ? countUnsent(sc) : Promise.resolve({ pending: 0, error: 0 }),
      sc ? rowsSince(sc, startOfToday().getTime()) : Promise.resolve([]),
      unsentGroups(),
    ]);
    // Okuma sürerken oturum değiştiyse sonucu yazma.
    const now = currentSessionScope();
    if ((sc || now) && !sameScope(sc, now)) return;
    setCounts(c);
    setRows(r);
    setOthers(summarizeOtherSessions(groups, sc, person));
    setDeletableOthers(deletableOtherSessions(groups, sc, canManageRef.current));
    setPendingOrgs(pendingByOrg(groups, person));
    setVersion((v) => v + 1);
  }, []);

  const run = useCallback(
    async (trigger: FlushTrigger) => {
      // Telefondaki güncelleme bayrağı okunmadan gönderim başlamaz: eski sürümle açılışta kayıt boşuna yüklenmesin.
      await loadUpgradeFlag();
      const sc = currentSessionScope();
      if (busy.current || !hasSession()) return;
      const plan = gate.plan(trigger, Date.now(), isUpgradeRequired());
      if (!plan.run) return;
      if (!sc) {
        // Askı kalkmış ya da davet başka cihazda kabul edilmiş olabilir. Firma gelirse jeton olayı gönderimi yeniden başlatır.
        await recoverQueueSession(currentPersonId(), recoverOrgSession).catch(() => null);
        return;
      }
      busy.current = true;
      setFlushing(true);
      try {
        await recovery.ready();
        await runFlush(
          {
            scope: sc,
            currentScope: currentSessionScope,
            send: (row) =>
              sendRow(row, sc).catch((e: unknown) => {
                // Tek ağ hatası çevrimdışı demek değildir: sağlık ucu yeniden yoklanır, rozet ona göre döner.
                if (e instanceof ApiError && (e.isNetwork || e.code === 'TIMEOUT')) reach.noteFailure();
                throw e;
              }),
            // Elle "Gönder"de, son bilinen durum "ulaşılamıyor" ise önbellek beklenmeden yeniden yoklanır.
            reachable: () => (trigger === 'manual' && !reach.reachable ? reach.check(0) : reach.check()),
            blocked: isUpgradeRequired,
            describe: (e) => friendlyError(e, 'save').text,
            onSent: (row) => {
              reach.noteSuccess();
              deleteQueueDir(row.clientId);
              gate.success();
              setServerIssue(false);
            },
            onTrouble: (t) => {
              gate.trouble(Date.now(), t);
              return gate.state.backoff.until;
            },
            onRowDone: reload,
            onPaused: (reason) => {
              // Güncelleme durumu açıldıysa onu kalkışı yönetir. Açılmadıysa (426 ama gövde tanınmadı) otomatik deneme seyrekleşir.
              if (reason === 'upgrade') {
                if (!isUpgradeRequired()) gate.pause(Date.now() + PAUSE_MS);
                return;
              }
              gate.pause(Date.now() + PAUSE_MS);
              if (reason === 'config') setServerIssue(true);
              else void refreshProfile();
            },
          },
          plan.includeErrors,
          plan.ignoreRowBackoff,
        );
      } finally {
        busy.current = false;
        setFlushing(false);
        await reload();
      }
    },
    [reload, refreshProfile, gate, recovery, reach],
  );

  const flush = useCallback((force = false) => run(force ? 'manual' : 'auto'), [run]);

  const enqueue = useCallback(
    async (data: MeasurementPayload, photos: QueuePhoto[]) => {
      // Sahibi, kaydetme anındaki oturumdur. Firmasız oturumda kayıt alınmaz.
      const sc = currentSessionScope();
      if (!sc) throw new Error('NO_SESSION_SCOPE');
      const stored: QueuePhoto[] = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i]!;
        stored.push({ kind: p.kind, uri: await copyToQueue(data.clientId, p.uri, i) });
      }
      await insertRow(sc, { clientId: data.clientId, data: { ...data, photoKinds: stored.map((p) => p.kind) }, photos: stored });
      // Satır yazıldı: kayıt alınmıştır. Liste yenilemesi başarısız olsa da kaydet hatası sayılmaz.
      await reload().catch((e) => console.warn('queue reload', e));
      flush();
    },
    [flush, reload],
  );

  const getLocal = useCallback(async (clientId: string) => {
    const sc = currentSessionScope();
    return sc ? getRow(sc, clientId) : null;
  }, []);

  const findUnsent = useCallback(async (tracking: string) => {
    const sc = currentSessionScope();
    return sc ? findUnsentByTracking(sc, tracking) : null;
  }, []);

  const editLocal = useCallback(
    async (clientId: string, data: MeasurementPayload, photos: QueuePhoto[]) => {
      const sc = currentSessionScope();
      if (!sc) return false;
      const before = await getRow(sc, clientId);
      if (!before || (before.status !== 'PENDING' && before.status !== 'ERROR')) return false;
      const keep = new Set(before.photos.map((p) => p.uri));
      const stamp = Date.now();
      const stored: QueuePhoto[] = [];
      const copied: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i]!;
        if (keep.has(p.uri)) stored.push(p);
        else {
          const uri = await copyToQueue(clientId, p.uri, `e${stamp}_${i}`);
          copied.push(uri);
          stored.push({ kind: p.kind, uri });
        }
      }
      const ok = await updateUnsent(sc, clientId, { ...data, photoKinds: stored.map((p) => p.kind) }, stored);
      if (ok) {
        const now = new Set(stored.map((p) => p.uri));
        before.photos.filter((p) => !now.has(p.uri)).forEach((p) => deleteQuietly(p.uri));
      } else copied.forEach(deleteQuietly);
      await reload();
      if (ok) flush();
      return ok;
    },
    [flush, reload],
  );

  const removeLocal = useCallback(
    async (clientId: string) => {
      const sc = currentSessionScope();
      if (!sc) return null;
      const row = await deleteUnsent(sc, clientId);
      await reload();
      return row;
    },
    [reload],
  );

  const undoRemoveLocal = useCallback(
    async (row: QueueRow) => {
      await reinsertRow(row);
      await reload();
      flush();
    },
    [flush, reload],
  );

  const noteServerEdit = useCallback(
    async (oldServerId: string, next: MeasurementItem) => {
      const sc = currentSessionScope();
      if (!sc) return;
      if (await updateSentFromServer(sc, oldServerId, next)) await reload();
    },
    [reload],
  );

  const purgeLocal = useCallback((clientId: string) => {
    rowExists(clientId).then((exists) => {
      if (!exists) deleteQueueDir(clientId);
    });
  }, []);

  useEffect(() => {
    // Soğuk açılış da öne gelmedir: kayıt beklemesi (önceki oturumdan, en çok ~11 dk) atlanır, bir kez denenir. Yoksa
    // açılışta `active` olayı gelmediği için bekleyenler, sunucu çoktan düzelmişken dakikalarca beklerdi.
    recovery
      .ready()
      .then(reload)
      .then(() => run('foreground'))
      .catch((e) => console.warn('queue recover', e));
    // Sunucuya ulaşılınca (bağlantı geldi ya da sunucu ayağa kalktı) bekleyenler hemen gider.
    setOnline(reach.reachable);
    const unsubReach = reach.subscribe((up) => {
      setOnline(up);
      if (up) void run('online');
    });
    // NetInfo'dan yalnız bağlantı türü ve "hiç bağlantı yok" bilgisi alınır; internete ulaşma bilgisi kullanılmaz (KALANLAR 4.9).
    const unsubNet = NetInfo.addEventListener((s) => reach.network({ connected: s.isConnected, kind: s.type }));
    let timer: ReturnType<typeof setInterval> | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const stopTimer = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (poll) clearTimeout(poll);
      poll = null;
    };
    // Öndeyken seyrek sağlık yoklaması: rozet sunucu düşünce de, geri gelince de doğru kalır. Arka planda yoklama yok.
    const schedulePoll = () => {
      if (poll) clearTimeout(poll);
      poll = setTimeout(() => {
        poll = null;
        if (AppState.currentState !== 'active') return;
        void reach.check().finally(() => {
          if (AppState.currentState === 'active' && timer) schedulePoll();
        });
      }, reach.pollDelay());
    };
    const startTimer = () => {
      stopTimer();
      timer = setInterval(() => {
        // Gönderilecek kayıt varsa tur önce sunucuya ulaşılıyor mu diye bakar (önbellekli, `runFlush` `reachable`).
        if (AppState.currentState === 'active') void run('timer');
      }, RETRY_TICK_MS);
      schedulePoll();
    };
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        reload();
        // Arka planda geçen sürede durum değişmiş olabilir: önbellek eskiyse bir kez yoklanır.
        void reach.check();
        // Öne gelince bekleme atlanır, bir kez denenir: tur ilk sunucu hatasında durur, en çok bir kayıt yüklenir.
        void run('foreground');
        startTimer();
      } else {
        // Zamanlayıcı ayrılırken durur; arka plana geçerken bir kez gönderim denenir.
        // Güncelleme gerekiyorsa `flush` kendisi gönderim yapmaz (`flushAllowed`); kayıtlara dokunulmaz.
        stopTimer();
        if (st === 'background') void run('auto').catch((e) => console.warn('background flush', e));
      }
    });
    if (AppState.currentState === 'active') startTimer();
    return () => {
      unsubNet();
      unsubReach();
      appSub.remove();
      stopTimer();
    };
  }, [run, reload, recovery, reach]);

  const purgeOtherSessions = useCallback(async () => {
    const sc = currentSessionScope();
    if (!sc) return 0;
    const ids = await deleteOtherSessions(sc, canManageRef.current);
    ids.forEach(deleteQueueDir);
    await reload();
    return ids.length;
  }, [reload]);

  // Güncelleme durumu kalkınca (sürüm değişti ya da sunucu "gerek yok" dedi) bekleyen kayıtlar kendiliğinden gider.
  useEffect(() => {
    setUpgradeRequired(isUpgradeRequired());
    return onUpgradeChange((s) => {
      setUpgradeRequired(s.required);
      if (!s.required) {
        gate.pause(0);
        void run('auto');
      }
    });
  }, [run, gate]);

  // Oturum veya yazma hakkı değişince engel kalkar: yeni durum hemen denensin.
  const canWrite = access.canWrite;
  useEffect(() => {
    gate.reset();
    setServerIssue(false);
  }, [sessionKey, canWrite, gate]);

  // Oturum (kişi veya firma) değişti: liste yeni kapsama döner, o kapsamın kayıtları gönderilir.
  useEffect(() => {
    reload().then(() => flush());
  }, [sessionKey, reload, flush]);

  // Yetki değişince silinebilir sayısı da değişir.
  useEffect(() => {
    reload();
  }, [canManage, reload]);

  const value = useMemo(
    () => ({
      online,
      flushing,
      pending: counts.pending,
      errors: counts.error,
      rows,
      version,
      others,
      deletableOthers,
      pendingOrgs,
      serverIssue,
      upgradeRequired,
      enqueue,
      flush,
      reload,
      getLocal,
      findUnsent,
      editLocal,
      removeLocal,
      undoRemoveLocal,
      purgeLocal,
      noteServerEdit,
      purgeOtherSessions,
    }),
    [online, flushing, counts, rows, version, others, deletableOthers, pendingOrgs, serverIssue, upgradeRequired, enqueue, flush, reload, getLocal, findUnsent, editLocal, removeLocal, undoRemoveLocal, purgeLocal, noteServerEdit, purgeOtherSessions],
  );
  return <QueueCtx.Provider value={value}>{children}</QueueCtx.Provider>;
}

export function useQueue(): QueueState {
  const v = useContext(QueueCtx);
  if (!v) throw new Error('QueueProvider eksik');
  return v;
}
