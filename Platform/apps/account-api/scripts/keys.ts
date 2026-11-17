import { env } from '../src/env.ts';
import { generateSigningJwk, rotateDevKey } from '../src/lib/keys.ts';

/**
 * generate: üretim için tek satır özel JWK basar. ACCOUNT_SIGNING_KEY değerine koyun.
 * rotate:   geliştirme anahtarını döndürür (keys/ altında). Servisi yeniden başlatın.
 *
 * Üretimde döndürme:
 *   1. Eski anahtarın açık alanlarını (kty, crv, x, kid) ACCOUNT_PREVIOUS_PUBLIC_KEYS dizisine ekleyin.
 *   2. ACCOUNT_SIGNING_KEY'e yenisini koyup servisi yeniden başlatın.
 *   3. En az 15 dakika sonra (jeton + olay ömrü) eskisini listeden çıkarabilirsiniz.
 */
const command = process.argv[2];

if (command === 'generate') {
  console.log(JSON.stringify(await generateSigningJwk()));
} else if (command === 'rotate') {
  const { kid, previousKid } = await rotateDevKey(env.keysDir);
  console.log(`Yeni anahtar: ${kid}\nJWKS'te kalan eski anahtar: ${previousKid}\nServisi yeniden başlatın.`);
} else {
  console.error('Kullanım: tsx scripts/keys.ts generate|rotate');
  process.exitCode = 1;
}
