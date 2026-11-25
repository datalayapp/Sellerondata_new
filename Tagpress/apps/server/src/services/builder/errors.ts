import { HttpError } from "../../util/errors.ts";

/**
 * Yanıt gövdesine ek alanlar taşıyan hata (sözleşmedeki genişletilmiş hata gövdeleri: `build-active` → `buildId`,
 * `build-state` → `state`, `budget-exceeded` → `scope`/`usedUsd`/…, `missing-key` → `keySource`). Kod, durum ve cümle
 * temel hatadan (`fail(...)`); ek alanları `errorBody` yazar, `error`/`code`/`params`/`fields`'ı ezemezler.
 */
export class HttpErrorWithBody extends HttpError {
  constructor(
    base: HttpError,
    readonly extra: Record<string, unknown>,
  ) {
    super(base.status, base.message, base.fields, base.code, base.params);
    const { provider, feature } = base as { provider?: string; feature?: string };
    if (provider) Object.assign(this, { provider });
    if (feature) Object.assign(this, { feature });
  }
}
