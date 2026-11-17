/**
 * Ülke adı (Türkçe / İngilizce, taşıyıcı belgelerinde yazıldığı gibi) → ISO-3166 alfa-2.
 * Önce bu dosyadaki taşıyıcı biçimleri ("BEYAZ RUSYA", "FİLDİŞİ SAHİLİ", "KOSOVA - ISO KODSUZ"), sonra
 * Intl.DisplayNames ile çok dilli ad dizini (invoice/parse.ts → parseCountry) denenir.
 */
import { canonicalCountryCode, COUNTRY_CODE_ALIASES } from './countryNames';
import { parseCountry } from './invoice/parse';

/** Türkçe karakterleri katlar, noktalama/parantezleri boşluğa çevirir: "İTALYA" → "italya". */
export function foldCountryName(s: string): string {
  return String(s ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ve ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Intl dizininde bulunmayan ya da farklı yazılan adlar (katlanmış biçimde). */
const EXTRA: Record<string, string> = {
  // Türkçe taşıyıcı yazımları
  'beyaz rusya': 'BY',
  belarus: 'BY',
  'fildisi sahili': 'CI',
  'ivory coast': 'CI',
  'cote d ivoire': 'CI',
  filistin: 'PS',
  'filistin bolgeleri': 'PS',
  palestine: 'PS',
  'demokratik kongo cumhuriyeti': 'CD',
  'kongo demokratik cumhuriyeti': 'CD',
  'congo democratic republic': 'CD',
  'democratic republic of congo': 'CD',
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  kongo: 'CG',
  'kongo cumhuriyeti': 'CG',
  congo: 'CG',
  'republic of congo': 'CG',
  'dogu timor': 'TL',
  'east timor': 'TL',
  andora: 'AD',
  svaziland: 'SZ',
  swaziland: 'SZ',
  esvatini: 'SZ',
  eswatini: 'SZ',
  makedonya: 'MK',
  'kuzey makedonya': 'MK',
  macedonia: 'MK',
  'north macedonia': 'MK',
  'hong kong': 'HK',
  hongkong: 'HK',
  makao: 'MO',
  macau: 'MO',
  macao: 'MO',
  myanmar: 'MM',
  burma: 'MM',
  'reunion adasi': 'RE',
  reunion: 'RE',
  'reunion island': 'RE',
  saipan: 'MP',
  'kuzey mariana adalari': 'MP',
  'saint vincent ve grenadine adalari': 'VC',
  'saint vincent ve grenadinler': 'VC',
  'st vincent': 'VC',
  'st vincent ve grenadines': 'VC',
  'saint vincent ve grenadines': 'VC',
  // Intl'in kendi adı "Congo - Kinshasa"; " - " sonrası not sayılıp "Congo" (CG) okunuyordu
  'congo kinshasa': 'CD',
  'kongo kinsasa': 'CD',
  'congo brazzaville': 'CG',
  'kongo brazavil': 'CG',
  // yaygın resmî/eski yazımlar: ad tanınmayınca yanındaki kod artık tek başına kabul edilmiyor
  'slovak republic': 'SK',
  'kyrgyz republic': 'KG',
  'lao pdr': 'LA',
  'syrian arab republic': 'SY',
  holland: 'NL',
  'holy see': 'VA',
  'the gambia': 'GM',
  'the bahamas': 'BS',
  bonaire: 'BQ',
  'bonaire saba st eustatius': 'BQ',
  'bonaire saba sint eustatius': 'BQ',
  'bonaire sint eustatius ve saba': 'BQ',
  'karayip hollandasi': 'BQ',
  'sint maarten hollanda kismi': 'SX',
  'saint martin fransiz kismi': 'MF',
  'sint maarten dutch part': 'SX',
  'saint martin french part': 'MF',
  kosova: 'XK',
  kosovo: 'XK',
  'cape verde': 'CV',
  'yesil burun adalari': 'CV',
  'abd virjin adalari': 'VI',
  'amerikan virjin adalari': 'VI',
  'us virgin islands': 'VI',
  'british virgin islands': 'VG',
  'britanya virjin adalari': 'VG',
  'ingiliz virjin adalari': 'VG',
  'guney kore': 'KR',
  kore: 'KR',
  'kore guney': 'KR',
  'south korea': 'KR',
  'korea south': 'KR',
  'korea republic of': 'KR',
  'kuzey kore': 'KP',
  'north korea': 'KP',
  'kibris rum kesimi': 'CY',
  'guney kibris': 'CY',
  'cek cumhuriyeti': 'CZ',
  cekya: 'CZ',
  'bosna hersek': 'BA',
  'bosnia and herzegovina': 'BA',
  'bosnia herzegovina': 'BA',
  'trinidad ve tobago': 'TT',
  'trinidad and tobago': 'TT',
  'antigua ve barbuda': 'AG',
  'antigua and barbuda': 'AG',
  'saint kitts ve nevis': 'KN',
  'st kitts and nevis': 'KN',
  'turks ve caicos adalari': 'TC',
  'turks and caicos islands': 'TC',
  'sao tome ve principe': 'ST',
  'sao tome and principe': 'ST',
  'wallis ve futuna': 'WF',
  'wallis and futuna': 'WF',
  'saint pierre ve miquelon': 'PM',
  'st pierre and miquelon': 'PM',
  'cocos keeling adalari': 'CC',
  'cocos keeling islands': 'CC',
  'christmas adasi': 'CX',
  'christmas island': 'CX',
  'faroe adalari': 'FO',
  'faroe islands': 'FO',
  'norfolk adasi': 'NF',
  'norfolk island': 'NF',
  'amerikan samoasi': 'AS',
  'american samoa': 'AS',
  'papua yeni gine': 'PG',
  'papua new guinea': 'PG',
  'gine bissau': 'GW',
  'guinea bissau': 'GW',
  'ekvator ginesi': 'GQ',
  'equatorial guinea': 'GQ',
  'orta afrika cumhuriyeti': 'CF',
  'central african republic': 'CF',
  'dominik cumhuriyeti': 'DO',
  'dominican republic': 'DO',
  vatikan: 'VA',
  'vatican city': 'VA',
  'porto riko': 'PR',
  'puerto rico': 'PR',
  'saint barthelemy': 'BL',
  'st barthelemy': 'BL',
  'saint lucia': 'LC',
  'st lucia': 'LC',
  'marsal adalari': 'MH',
  'marshall islands': 'MH',
  'solomon adalari': 'SB',
  'solomon islands': 'SB',
  'cook adalari': 'CK',
  'cook islands': 'CK',
  'cayman adalari': 'KY',
  'cayman islands': 'KY',
  'mikronezya': 'FM',
  micronesia: 'FM',
  'yeni kaledonya': 'NC',
  'new caledonia': 'NC',
  'yeni zelanda': 'NZ',
  'new zealand': 'NZ',
  'fransiz guyanasi': 'GF',
  'french guiana': 'GF',
  'fransiz polinezyasi': 'PF',
  'french polynesia': 'PF',
  'guney afrika': 'ZA',
  'south africa': 'ZA',
  'suudi arabistan': 'SA',
  'birlesik arap emirlikleri': 'AE',
  'amerika birlesik devletleri': 'US',
  'amerika birlesik devletleri abd': 'US',
  'united states of america': 'US',
  'birlesik krallik': 'GB',
  'buyuk britanya': 'GB',
  ingiltere: 'GB',
  'kanarya adalari': 'IC',
  'canary islands': 'IC',
  laos: 'LA',
  tayvan: 'TW',
  taiwan: 'TW',
  rusya: 'RU',
  'rusya federasyonu': 'RU',
  'russian federation': 'RU',
  vietnam: 'VN',
  'viet nam': 'VN',
  iran: 'IR',
  suriye: 'SY',
  syria: 'SY',
  moldova: 'MD',
  bolivya: 'BO',
  venezuela: 'VE',
  tanzanya: 'TZ',
  tanzania: 'TZ',
  curacao: 'CW',
};

/** ISO-3166 alfa-3 → alfa-2 ("DEU" → "DE"); Kosova için yaygın "XKX". */
const ISO3: Record<string, string> = (() => {
  const t = `
AFG AF ALA AX ALB AL DZA DZ ASM AS AND AD AGO AO AIA AI ATA AQ ATG AG ARG AR ARM AM ABW AW AUS AU AUT AT AZE AZ
BHS BS BHR BH BGD BD BRB BB BLR BY BEL BE BLZ BZ BEN BJ BMU BM BTN BT BOL BO BES BQ BIH BA BWA BW BVT BV BRA BR
IOT IO BRN BN BGR BG BFA BF BDI BI CPV CV KHM KH CMR CM CAN CA CYM KY CAF CF TCD TD CHL CL CHN CN CXR CX CCK CC
COL CO COM KM COG CG COD CD COK CK CRI CR CIV CI HRV HR CUB CU CUW CW CYP CY CZE CZ DNK DK DJI DJ DMA DM DOM DO
ECU EC EGY EG SLV SV GNQ GQ ERI ER EST EE SWZ SZ ETH ET FLK FK FRO FO FJI FJ FIN FI FRA FR GUF GF PYF PF ATF TF
GAB GA GMB GM GEO GE DEU DE GHA GH GIB GI GRC GR GRL GL GRD GD GLP GP GUM GU GTM GT GGY GG GIN GN GNB GW GUY GY
HTI HT HMD HM VAT VA HND HN HKG HK HUN HU ISL IS IND IN IDN ID IRN IR IRQ IQ IRL IE IMN IM ISR IL ITA IT JAM JM
JPN JP JEY JE JOR JO KAZ KZ KEN KE KIR KI PRK KP KOR KR KWT KW KGZ KG LAO LA LVA LV LBN LB LSO LS LBR LR LBY LY
LIE LI LTU LT LUX LU MAC MO MDG MG MWI MW MYS MY MDV MV MLI ML MLT MT MHL MH MTQ MQ MRT MR MUS MU MYT YT MEX MX
FSM FM MDA MD MCO MC MNG MN MNE ME MSR MS MAR MA MOZ MZ MMR MM NAM NA NRU NR NPL NP NLD NL NCL NC NZL NZ NIC NI
NER NE NGA NG NIU NU NFK NF MKD MK MNP MP NOR NO OMN OM PAK PK PLW PW PSE PS PAN PA PNG PG PRY PY PER PE PHL PH
PCN PN POL PL PRT PT PRI PR QAT QA REU RE ROU RO RUS RU RWA RW BLM BL SHN SH KNA KN LCA LC MAF MF SPM PM VCT VC
WSM WS SMR SM STP ST SAU SA SEN SN SRB RS SYC SC SLE SL SGP SG SXM SX SVK SK SVN SI SLB SB SOM SO ZAF ZA SGS GS
SSD SS ESP ES LKA LK SDN SD SUR SR SJM SJ SWE SE CHE CH SYR SY TWN TW TJK TJ TZA TZ THA TH TLS TL TGO TG TKL TK
TON TO TTO TT TUN TN TUR TR TKM TM TCA TC TUV TV UGA UG UKR UA ARE AE GBR GB USA US UMI UM URY UY UZB UZ VUT VU
VEN VE VNM VN VGB VG VIR VI WLF WF ESH EH YEM YE ZMB ZM ZWE ZW XKX XK`.trim().split(/\s+/);
  const m: Record<string, string> = {};
  for (let i = 0; i + 1 < t.length; i += 2) m[t[i]!] = t[i + 1]!;
  return m;
})();

/** Alfa-3 ülke kodu ("DEU", "gbr") → alfa-2; değilse null. */
export function iso3ToIso2(code: string): string | null {
  const t = String(code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(t) ? (ISO3[t] ?? null) : null;
}

const SPECIAL_CODES = new Set(['XK', 'IC']);
const ISO2 = new Set([...Object.values(ISO3), ...SPECIAL_CODES]);

/**
 * Basılı ülke adı → ISO-2; bulunamazsa null. Çok satırlı adlar ("AMERİKA\nBİRLEŞİK\nDEVLETLERİ"),
 * "&" / "VE", parantezli açıklamalar ("SİNT MAARTEN (Hollanda kısmı)") ve " - " sonrası notlar
 * ("KOSOVA - ISO KODSUZ - YALNIZCA TNT") tolere edilir.
 */
export function countryNameToIso2(name: string): string | null {
  const raw = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2}$/.test(raw)) return canonicalCountryCode(raw);
  // büyük harfli alfa-3 kod ("DEU", "GBR"); küçük harfli 3 harf ad olabilir, ad olarak denenir
  if (/^[A-Z]{3}$/.test(raw) && ISO3[raw]) return ISO3[raw]!;
  const candidates = new Set<string>();
  const full = foldCountryName(raw);
  candidates.add(full);
  candidates.add(foldCountryName(raw.replace(/\([^)]*\)/g, ' ')));
  candidates.add(foldCountryName(raw.split(/\s[-–—]\s/)[0] ?? raw));
  candidates.add(foldCountryName(raw.split(',')[0] ?? raw));
  // "KORE, GÜNEY" → "guney kore"
  const comma = raw.split(',');
  if (comma.length === 2) candidates.add(foldCountryName(`${comma[1]} ${comma[0]}`));
  for (const c of candidates) {
    if (!c) continue;
    const hit = EXTRA[c] ?? EXTRA[c.replace(/\bve\b/g, 'and')];
    if (hit) return hit;
  }
  for (const c of candidates) {
    if (!c) continue;
    const viaIntl = parseCountry(c) ?? parseCountry(c.replace(/\bve\b/g, 'and'));
    if (viaIntl && (/^[A-Z]{2}$/.test(viaIntl) || SPECIAL_CODES.has(viaIntl))) return viaIntl;
  }
  return nameWithCode(raw);
}

/**
 * Ad + kod yan yana: "Germany DEU", "Almanya - DE", "DEU Germany", "GBR: United Kingdom" (kod büyük harf).
 * Ad tanınırsa kodla çelişmemeli (çelişirse null); ad tanınmazsa null
 * (bölge/zone gibi serbest metin + kod yanlış pozitif üretir).
 */
function nameWithCode(raw: string): string | null {
  const m = /^(.+?)[\s,;:/–—-]+\(?([A-Z]{2,3})\)?$/u.exec(raw) ?? /^\(?([A-Z]{2,3})\)?[\s,;:/–—-]+(.+)$/u.exec(raw);
  if (!m) return null;
  const [name, code] = /^[A-Z]{2,3}$/.test(m[1]!) && !/^[A-Z]{2,3}$/.test(m[2]!) ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
  const fromCode = code.length === 3 ? (ISO3[code] ?? null) : COUNTRY_CODE_ALIASES[code] ?? (ISO2.has(code) ? code : null);
  const fromName = countryNameToIso2(name);
  if (fromName) return !fromCode || fromCode === fromName ? fromName : null;
  // Ad tanınmadı ("Bölge 3 TUR", "Zone A ARE", "XYZ AUT"): sondaki kod tek başına güvenilmez → null (kullanıcı uyarı görür)
  return null;
}
