import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgRolesResponse, ProductKey } from '@sellerondata/contracts';
import { ME_QUERY_KEY, currentLocale, useMe } from '@sellerondata/shell';
import { client } from './session.ts';
import { isOrgAdmin } from './access.ts';
import { rolesProductOf, type RoleViewer, type RolesProduct } from './roles.ts';

/** `GET /org/roles` sorgu anahtarı (firma ve dil kapsamında: adlar isteğin dilinde gelir). */
export const rolesKey = (scope: readonly unknown[]) => [...scope, 'roles'] as const;

/**
 * Firmanın rolleri. Ekip ekranının bütün rol seçicileri buradan beslenir (özel ve adı değişen roller görünür, gizlenen hazır
 * roller görünmez). Yanıt gelene kadar ya da gelmezse katalog yedeği (`rolesProductOf`) kullanılır.
 */
export function useOrgRoles(scope: readonly unknown[]) {
  const { me } = useMe();
  return useQuery({
    queryKey: rolesKey(scope),
    queryFn: () => client.get<OrgRolesResponse>('/api/account/org/roles'),
    enabled: isOrgAdmin(me),
    staleTime: 15_000,
  });
}

/** Tek aracın rolleri (yanıt ya da katalog). */
export function useProductRoles(scope: readonly unknown[]): (k: ProductKey) => RolesProduct {
  const q = useOrgRoles(scope);
  const locale = currentLocale();
  return useCallback((k: ProductKey) => rolesProductOf(q.data, k, locale), [q.data, locale]);
}

/** Rol değişince yenilenecekler: roller, kişiler, davetler ve kendi `/me`'miz (kendi rolümüz değişmiş olabilir). */
export function useRolesRefresh(scope: readonly unknown[]) {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: rolesKey(scope) }),
        qc.invalidateQueries({ queryKey: [...scope, 'members'] }),
        qc.invalidateQueries({ queryKey: [...scope, 'invitations'] }),
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
      ]),
    [qc, scope],
  );
}

/** İsteği yapanın bu araçtaki durumu: firma sahibi mi, kendi izinleri. */
export function useRoleViewer(): (k: ProductKey) => RoleViewer {
  const { me } = useMe();
  return useCallback((k: ProductKey) => ({ isOwner: me?.activeOrg?.orgRole === 'OWNER', permissions: me?.products.find((p) => p.key === k)?.permissions ?? [] }), [me]);
}
