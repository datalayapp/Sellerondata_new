import { API, type Language } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";

/** Etkin tasarım dili: bütün ekranlar bunun profiliyle, şablonlarıyla ve fontlarıyla çalışır. */
interface LanguageState {
  languages: Language[];
  current: Language | null;
  setCurrent: (id: string) => void;
  loading: boolean;
}

const Ctx = createContext<LanguageState>({ languages: [], current: null, setCurrent: () => {}, loading: true });
const KEY = "studio.dil";

/** `enabled: false`: dil listesi henüz sorulmaz (platform kipinde oturum kapısı açılmadan). */
export function LanguageProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const q = useQuery({ queryKey: ["languages"], queryFn: () => api.get<{ languages: Language[] }>(API.languages), enabled });
  const [chosen, setChosen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  // Veri yokken her çizimde yeni boş dizi olmasın (bağlam değeri boşuna değişmesin).
  const languages = useMemo(() => q.data?.languages ?? [], [q.data?.languages]);
  const current = languages.find((l) => l.id === chosen) ?? languages.find((l) => l.isDefault) ?? languages[0] ?? null;
  useEffect(() => {
    if (current && current.id !== chosen) setChosen(current.id);
  }, [current, chosen]);
  const value = useMemo<LanguageState>(
    () => ({
      languages,
      current,
      loading: q.isLoading,
      setCurrent: (id) => {
        setChosen(id);
        try {
          localStorage.setItem(KEY, id);
        } catch {
          /* gizli pencere */
        }
      },
    }),
    [languages, current, q.isLoading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLanguage() {
  return useContext(Ctx);
}
