import { useCallback, useEffect, useReducer, useRef, type Reducer } from 'react';
import { useFocusEffect } from 'expo-router';
import { toHubError } from './http';
import { emptyResource, resourceReducer, type ResourceAction, type ResourceState } from './resource';
import { hubCache } from './store';

const STALE_MS = 60_000;

/** Bir bölümün verisi: önce önbellek, sonra ağ. Sekmeye dönünce bir dakikadan eskiyse tazelenir. */
export function useHubResource<T>(key: string | null, load: () => Promise<T>) {
  const [state, dispatch] = useReducer(resourceReducer as Reducer<ResourceState<T>, ResourceAction<T>>, undefined, emptyResource<T>);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async (k: string) => {
    const since = hubCache.generation();
    dispatch({ type: 'start', key: k, cached: hubCache.read<T>(k) });
    try {
      const data = await loadRef.current();
      dispatch({ type: 'success', key: k, data, at: hubCache.write(k, data, since) });
    } catch (e) {
      const { kind } = toHubError(e);
      if (kind === 'forbidden') hubCache.drop(k);
      dispatch({ type: 'failure', key: k, kind });
    }
  }, []);

  useEffect(() => {
    if (key) void run(key);
  }, [key, run]);

  const refresh = useCallback(() => (key ? run(key) : Promise.resolve()), [key, run]);

  const { at, busy } = state;
  useFocusEffect(
    useCallback(() => {
      if (!busy && at !== null && Date.now() - at > STALE_MS) void refresh();
      // Yalnız odak değişiminde bakılır; veri geldikçe yeniden çalışmasın.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh]),
  );

  return { ...state, refresh };
}

export type HubResource<T> = ReturnType<typeof useHubResource<T>>;
