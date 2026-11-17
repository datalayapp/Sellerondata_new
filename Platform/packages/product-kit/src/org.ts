import { DEFAULT_ORG_TIME_ZONE, isOrgTimeZone } from '@sellerondata/contracts';
import { sqlIdent, type SqlDb } from './db.ts';

/** Firmanın yerel kaydından araç ve Merkez çatısının okuduğu alanlar (`memberProjectionSql` `Company`). */
export type OrgProfile = {
  name: string;
  /** `org.updated` ile; eski biçim olayda gelmemişse null (araç kendi varsayılanını uygular). */
  currency: string | null;
  country: string | null;
  /** Firmanın saat dilimi; kayıtta yoksa ya da listede değilse `DEFAULT_ORG_TIME_ZONE`. "Bugün", son günler ve dışa aktarma buna göre. */
  timeZone: string;
  /**
   * Firma bilgileri Merkez'de onaylı mı (`org.updated` `companyConfirmed`). Aracın kurulumu buna bağlıdır: onay yoksa kurulum
   * tamamlanmış sayılmaz (Merkez çatısı Genel Bakış'ın `setup.completed` alanını buna göre düzeltir).
   */
  companyConfirmed: boolean;
  closed: boolean;
};

/** Firma bağlamında (`withOrg`) çağrılır. Satır yoksa (hiç görülmemiş ya da kalıcı silinmiş firma) null. */
export async function readOrgProfile(tx: SqlDb, schema: string, orgId: string): Promise<OrgProfile | null> {
  const s = sqlIdent(schema, 'schema');
  const rows = await tx.query<{
    name: string;
    currency: string | null;
    country: string | null;
    timeZone: string | null;
    companyConfirmed: boolean;
    closedAt: Date | null;
  }>(`SELECT "name", "currency", "country", "timeZone", "companyConfirmed", "closedAt" FROM ${s}."Company" WHERE "id" = $1`, [orgId]);
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    currency: row.currency,
    country: row.country,
    timeZone: isOrgTimeZone(row.timeZone) ? row.timeZone : DEFAULT_ORG_TIME_ZONE,
    companyConfirmed: row.companyConfirmed === true,
    closed: row.closedAt !== null,
  };
}
