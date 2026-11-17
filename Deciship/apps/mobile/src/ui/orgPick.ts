/**
 * Firma seçimi. `onSwitched` isteğe bağlıdır; firma değişimi her durumda çalışır.
 * (`onSwitched?.(await switchOrg(id))` yazılırsa geri çağırma yokken argüman hiç değerlendirilmez, seçim sessizce çalışmaz.)
 */
export async function pickOrg<T>(switchOrg: (orgId: string) => Promise<T>, orgId: string, onSwitched?: (result: T) => void): Promise<void> {
  const result = await switchOrg(orgId);
  onSwitched?.(result);
}
