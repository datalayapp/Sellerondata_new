import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAuth } from '../auth/AuthContext';
import { sameScope, scopeKey } from '../auth/token';
import type { DimMethod, PhotoKind, WeightMethod } from '../api/endpoints';
import { fileExists } from '../lib/images';
import { rowExists } from '../queue/store';
import {
  createDraftSync,
  deleteDraft,
  deleteSpareDraft,
  draftFileRefs,
  draftHasContent,
  restoreDraft,
  sweepExpiredDrafts,
  writeDraft,
  writeSpareDraft,
  type HeldDraft,
} from './persist';
import { deleteDraftPhoto, keepDraftPhoto, migrateDraftPhoto, sweepOrphanDraftDirs } from './photoFiles';

export type DraftPhoto = { id: string; uri: string; kind: PhotoKind; width?: number; height?: number };

export type Draft = {
  /** Taslakla doğar; kayıt kuyruğa bu kimlikle girer (çift kayıt önlemi). */
  clientId: string;
  trackingRaw: string;
  weightKg: number | null;
  weightMethod: WeightMethod;
  ocrWeightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  dimMethod: DimMethod;
  dimConfidence: number | null;
  boxPresetId: string | null;
  photos: DraftPhoto[];
  note: string;
  startedAt: number;
  /** KALANLAR 6.7-a: bilerek yeniden ölçülen sunucu kaydının kimliği (barkod ekranındaki "Yeniden ölç"). */
  replacesId?: string | null;
};

const empty = (): Draft => ({
  clientId: Crypto.randomUUID(),
  trackingRaw: '',
  weightKg: null,
  weightMethod: 'MANUAL',
  ocrWeightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  dimMethod: 'MANUAL',
  dimConfidence: null,
  boxPresetId: null,
  photos: [],
  note: '',
  startedAt: Date.now(),
});

type DraftState = {
  draft: Draft;
  /** Bu oturumun taslağı diskten okundu. Öncesinde taslak gösterilmez, yeni ölçüm başlatılmaz. */
  ready: boolean;
  hasContent: boolean;
  /** Geri yüklenirken dosyası bulunamayan fotoğraf sayısı; bir kez gösterilir. */
  missingPhotos: number;
  ackMissingPhotos: () => void;
  update: (patch: Partial<Draft>) => void;
  addPhoto: (p: Omit<DraftPhoto, 'id'>) => void;
  removePhoto: (id: string) => void;
  /** Aynı türdeki tek fotoğrafı değiştirir (ör. PHOTO_SCALE). */
  replacePhotoOfKind: (p: Omit<DraftPhoto, 'id'>, tag?: string) => void;
  /** Taslağı boşaltır; diskteki kopya beklemeden silinir. `deleteFiles`: taslak fotoğrafları da silinir. */
  reset: (deleteFiles?: boolean) => void;
};

/** Bellekteki taslak ve sahibi (bkz. `HeldDraft`). `flush: 'now'`: beklemeden yazılır (taslak silme). */
type Held = HeldDraft & { flush?: 'now' };

const DraftCtx = createContext<DraftState | null>(null);

const photoId = () => `p-${Crypto.randomUUID()}`;

/** Taslağın kalan fotoğrafları silinmez (aynı dosyayı anan başka kayıt). */
const urisOf = (photos: DraftPhoto[], ...more: string[]) => new Set([...photos.map((p) => p.uri), ...more]);

export function DraftProvider({ children }: { children: ReactNode }) {
  const { scope } = useAuth();
  const [held, setHeld] = useState<Held>(() => ({ owner: null, draft: empty() }));
  const [missingPhotos, setMissingPhotos] = useState(0);
  const draft = held.draft;
  // Diskten okuma bu kapsam için bitmeden taslak gösterilmez, yeni ölçüm başlatılmaz, hiçbir şey yazılmaz.
  const ready = !!scope && sameScope(held.owner, scope);
  const heldRef = useRef(held);
  heldRef.current = held;

  const [sync] = useState(() =>
    createDraftSync({
      // Eski taslağın önbellekteki fotoğrafı geri yüklemede kalıcı klasöre geçer (`keepPhoto`).
      restore: (sc) => restoreDraft(sc, { exists: fileExists, rowExists, deletePhoto: (u) => deleteDraftPhoto(u), keepPhoto: migrateDraftPhoto }),
      write: (sc, d) => writeDraft(sc, d),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d),
      removeSpare: deleteSpareDraft,
      fresh: empty,
      onLoaded: (owner, d, missing) => {
        setHeld({ owner, draft: d });
        setMissingPhotos(missing);
      },
      sweep: async () => {
        await sweepExpiredDrafts((u) => deleteDraftPhoto(u));
        // Sahipsiz taslak klasörleri: diskteki bütün taslaklar ve bellekteki geçerli taslak korunur.
        const refs = await draftFileRefs();
        const cur = heldRef.current.draft;
        sweepOrphanDraftDirs({ ids: [...refs.ids, cur.clientId], uris: [...refs.uris, ...cur.photos.map((p) => p.uri)] });
      },
      onError: (e) => console.warn('draft', e),
    }),
  );

  const currentKey = scopeKey(scope);
  useEffect(() => {
    // Kapsam nesnesi yalnız anahtar değişince değişir (AuthContext); bağımlılık anahtardır.
    sync.setScope(scope);
  }, [currentKey, sync]);

  useEffect(() => {
    sync.changed(held, held.flush === 'now');
  }, [held, sync]);

  // Arka plana geçerken bekleyen yazma hemen yapılır (300 ms içinde kapatılma). Öne gelince okunamamış taslak yeniden okunur.
  // Sağlayıcı ayrılırken de bekleyen yazma beklenmeden yapılır ve okuma yeniden denemesinin zamanlayıcısı durur.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background' || st === 'inactive') void sync.flush();
      else if (st === 'active') void sync.retry();
    });
    return () => {
      sub.remove();
      void sync.dispose();
    };
  }, [sync]);

  const change = useCallback((fn: (d: Draft) => Draft, flush?: 'now') => {
    setHeld((h) => ({ owner: h.owner, draft: fn(h.draft), ...(flush ? { flush } : {}) }));
  }, []);

  const update = useCallback((patch: Partial<Draft>) => change((d) => ({ ...d, ...patch, clientId: d.clientId })), [change]);

  // Taslağa giren fotoğraf önce kalıcı klasöre kopyalanır (11-B4): önbellek temizlense de kaybolmaz. Kopyalanamazsa eski
  // adresiyle girer; sonraki açılışta geri yükleme yeniden dener.
  const addPhoto = useCallback(
    (p: Omit<DraftPhoto, 'id'>) => {
      const id = photoId();
      const uri = keepDraftPhoto(heldRef.current.draft.clientId, p.uri, id);
      change((d) => ({ ...d, photos: [...d.photos, { ...p, uri, id }] }));
    },
    [change],
  );

  const removePhoto = useCallback(
    (id: string) => {
      const photos = heldRef.current.draft.photos;
      const ph = photos.find((x) => x.id === id);
      if (ph) deleteDraftPhoto(ph.uri, urisOf(photos.filter((x) => x.id !== id)));
      change((d) => ({ ...d, photos: d.photos.filter((x) => x.id !== id) }));
    },
    [change],
  );

  const replacePhotoOfKind = useCallback(
    (p: Omit<DraftPhoto, 'id'>, tag?: string) => {
      const id = tag ?? `kind-${p.kind}`;
      const photos = heldRef.current.draft.photos;
      const old = photos.find((x) => x.id === id);
      const uri = keepDraftPhoto(heldRef.current.draft.clientId, p.uri, photoId());
      // Yeni kopyanın kaynağı ve kopyası silinmez (aynı çekim yeniden verildiyse).
      if (old && old.uri !== uri) deleteDraftPhoto(old.uri, urisOf(photos.filter((x) => x.id !== id), p.uri, uri));
      change((d) => ({ ...d, photos: [...d.photos.filter((x) => x.id !== id), { ...p, uri, id }] }));
    },
    [change],
  );

  const reset = useCallback(
    (deleteFiles = false) => {
      // Kayıtta kuyruk kendi kopyasını almıştır (`copyToQueue`, Kaydet `reset(true)`'dan önce biter).
      if (deleteFiles) heldRef.current.draft.photos.forEach((p) => deleteDraftPhoto(p.uri));
      setMissingPhotos(0);
      // Yeni taslak yeni kimlikle doğar; sahibi aynı kalır, diskteki kopya beklemeden silinir.
      change(() => empty(), 'now');
    },
    [change],
  );

  const ackMissingPhotos = useCallback(() => setMissingPhotos(0), []);
  const hasContent = draftHasContent(draft);

  const value = useMemo(
    () => ({ draft, ready, hasContent, missingPhotos, ackMissingPhotos, update, addPhoto, removePhoto, replacePhotoOfKind, reset }),
    [draft, ready, hasContent, missingPhotos, ackMissingPhotos, update, addPhoto, removePhoto, replacePhotoOfKind, reset],
  );
  return <DraftCtx.Provider value={value}>{children}</DraftCtx.Provider>;
}

export function useDraft(): DraftState {
  const v = useContext(DraftCtx);
  if (!v) throw new Error('DraftProvider eksik');
  return v;
}
