# samples/

Reproducible sample data for DeciShip (SPEC §3, §5.7, §5.10). Everything is produced by `tools/generate.mjs`
(`cd samples/tools && npm i && node generate.mjs`). The generator contains its own independent implementation of the
SPEC §3 rules and asserts every line's intended status and the wiki numbers, so the files and `expected.json` cannot drift apart.
All data is fictional.

| File | Content |
|---|---|
| `seed-tariffs.json` | 6 carriers (`fedex ups dhl aras yurtici mng`), each `{code,name,tariffs:[full tariff body]}` (SPEC §5.7 shape without `carrierId`; `zones` is `[{country,zone}]`). All TRY, valid 2026. |
| `seed-measurements.json` | 57 measurements by `mehmet`, 19-25 Oct 2026. The first 16 are the FedEx 9-482-11735 parcels (wiki: #5305 = `794812345305`, 40x30x25, 4.0 kg). Three FedEx entries use 34-digit Code128 raw values (`96...` + 12-digit tracking); one uses a spaced value `7948 1234 5301`. Some dims are fractional (LiDAR/AR) to exercise CEIL_CM. |
| `invoices/*` | 7 invoice files (see below). |
| `expected.json` / `EXPECTED.md` | Golden results per invoice line + totals (machine / human form). |
| `tariff-template-example.xlsx` | FedEx tariff in the §5.7 import template (`Fiyatlar`, `Bölgeler`, `Ek ücretler`). |
| `reference-card.pdf`, `vision/` | owned by the vision agent |

## Tariff highlights
- FedEx Intl Economy 2026: divisor 5000, CEIL_CM, steps 0.5 kg <=20 then 1 kg, discount 38, fuel 25. Zones A (FR DE NL BE IT ES), B (GB CH), D (US CA); rates 0.5-30 kg; A/6.0 kg = 1527.75 -> expected 1184.00. Surcharges in tariff: `REMOTE_AREA` PER_KG 18.50, `ADDITIONAL_HANDLING` FIXED 285. `ADDRESS_CORRECTION` is deliberately NOT in any tariff.
- UPS (zones Z1/Z2/Z3, disc 32, fuel 22), DHL (zones EU/UK/WW, steps 0.5 up to 30 kg, disc 35, fuel 24), Aras (disc 10, fuel 0), Yurtiçi (disc 15, fuel 5), MNG (disc 8, fuel 3): domestic = divisor 3000, zone `*`, 1-30 desi, overflow per desi.
- UPS has no zone for `AU` and no `*` -> that line is `NO_TARIFF`.

## Invoices (upload order matters only for the cross-invoice duplicate)
The numbers below assume the setting "Tarifede olmayan ek ücretleri fark say" is ON (`unknownSurchargesAsDiff: true`, as in `samples.test.ts`). With the default (off) a surcharge missing from the tariff is added to the expected amount as billed (it cannot be checked, so it does not create a diff); e.g. FedEx 9-482-11735 then gives 13 match / 4 diff / 611,20 (İncele 1.120,00).

"Overcharge" is the firm amount ("Fazla ödeme"). "İncele" (review) lines keep their status and diff but stay out of it (KALANLAR 1.8, owner decision 2026-11-14): a tracking number on more than one charge line of the same file makes none of its differences firm. Every file below repeats one tracking number, so its second line (DUPLICATE) is "İncele". The cross-invoice duplicate in 11736 (same carrier, amount and description as in 11735) stays firm.

| File | Format / quirks | Lines | Match | Diff | Unmatched | NoTariff | Overcharge TRY | İncele TRY |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| fedex-9-482-11735.csv | CSV `,` BOM, dot decimals, ISO dates, PII columns, Discount negative | 18 | 12 | 5 | 1 | 0 | 1.023,20 | 1.120,00 |
| fedex-9-482-11736.xlsx | numeric cells, `Express or Ground Tracking ID`, one DIMENSION+SURCHARGE line, one cross-invoice duplicate of 11735 | 9 | 3 | 5 | 1 | 0 | 1.557,83 | 0,00 |
| ups-0000F4A71X.xlsx | numeric cells, 18-char `1Z` numbers | 10 | 3 | 5 | 1 | 1 | 1.073,34 | 1.019,02 |
| dhl-SIN-4471029.csv | CSV `,`, `Waybill Number` | 9 | 3 | 5 | 1 | 0 | 574,29 | 2.596,46 |
| aras-ARS-2026-004871.xlsx | 5 preamble rows before header (header auto-detect), TEXT cells `1.234,56` / `27.10.2026`, amounts KDV dahil via `Toplam`, dims in one cell `45x35x30`, TOPLAM footer row | 8 | 2 | 5 | 1 | 0 | 133,43 | 139,79 |
| yurtici-YK-2026-118833.xlsx | real numeric + Date cells, `En/Boy/Yükseklik` columns, net = `Tutar (KDV Hariç)`, footer total row | 9 | 3 | 5 | 1 | 0 | 126,64 | 145,81 |
| mng-MNG-2026-77120.csv | CSV `;` BOM, Turkish numbers/dates, no dims, net = `Tutar` (KDV hariç), footer total | 8 | 3 | 4 | 1 | 0 | 63,50 | 141,30 |

FedEx 9-482-11735 reproduces the wiki: #5305 DIMENSION +458,50 (expected 1.184,00, billed 1.642,50), #5299 WEIGHT +96,40, #5293 SURCHARGE +412,00, #5290 PRICE +56,30 (fuel 27,5%), #5288 DUPLICATE +1.120,00 ("İncele": second line of the same tracking number in this file), unmatched `774012346105`; firm overcharge 1.023,20, İncele 1.120,00 (all diffs 2.143,20).
Each file also has MATCH edge cases: tolerance diff (+2,00 / +3,50 -> MATCH), "Lehimize fark" (-12,00 -> MATCH with note), billed dims >1 cm larger but same chargeable kg (MATCH), tariff-listed surcharges billed correctly (MATCH), and a listed surcharge billed too high (+100, SURCHARGE).
Every duplicate row differs from its original in the reference column (suffix `-R`) so `rawHash` does not drop it at import.

## expected.json
`invoices[]`: `file, carrierCode, tariff, invoiceNo, invoiceDate, currency, suggestedMapping` (a ColumnMapping using the real header names), `fileInfo` (quirks), `lines[]`, `totals`, `reviewTotals` (`estimatedOverchargeTotal`, `estimatedLines`: "İncele" DIFF lines).
Line: `row` (1-based data row, order of appearance), `trackingNo, scenario, status, diffTypes, ourChargeableKg, billedChargeableKg, expectedAmount, billedAmount, diffAmount, note?`; an "İncele" line also has `confidence: "LOW"` and `reviewCode`.
Cross-invoice duplicate line also carries `standalone*` fields (result if that file is imported alone).
Totals: `lines, match, diff, unmatched, noTariff, billedTotal, expectedTotal, overchargeTotal, verifiedTotal` (definitions at top of EXPECTED.md).

## Interpretations (ambiguities in SPEC §3)
- Surcharges are added after fuel, not discounted and no fuel on them. PER_KG = amount x chargeable kg (round2); FIXED = amount. A PCT surcharge (DHL `INSURANCE`) exists in the tariff but is never used on an invoice (base of the % is unspecified).
- Excess on a listed surcharge counts as SURCHARGE when billed - expected > amountTol.
- DUPLICATE line: `expectedAmount` = null, `diffAmount` = full net; only status / diffTypes / diffAmount should be asserted for it.
- UNMATCHED and NO_TARIFF: `diffAmount` null. NO_TARIFF has `ourChargeableKg` set.
- Rule 5 "or" precedence: all samples are constructed so both readings (and comparing edges raw vs ceiled) give the same result; WEIGHT cases always have billed volumetric <= our actual kg.
- Domestic "Desi" column is mapped as billed chargeable (`desiAsWeight`). For KDV-dahil Aras, net = Toplam / 1,2 round2 round-trips exactly to the KDV-hariç cent. Surcharge columns in Aras/MNG/Yurtiçi are KDV hariç.
- MNG has no dims, so a billed-dimension inflation there is classified WEIGHT (row 4, billed 10 desi vs our 9).
- FedEx/UPS/DHL "Discount"/"Incentive Credit" columns are negative numbers.
- overchargeTotal counts only positive diffs of firm DIFF lines ("İncele" lines go to `reviewTotals`).

## Synthetic files for AI mapping (SPEC §11)
Hand-written by `gen_synth` (fictional names, numbers and addresses); not part of `expected.json`.
- `invoices/generic-de-rechnung-sample.csv` — German headers, `;` separator, EU numbers (`1.234,56`), label/amount pair `Zuschlagsart`/`Zuschlagsbetrag`, invoice-level totals repeated on every row. 16 lines, net total 586,25 EUR.
- `invoices/generic-en-invoice-sample.csv` — English headers in a different layout, inches/lbs, one-cell dimensions, US dates (`mdy`), `,` thousands. 14 lines, total 880.11 USD.

Sample tariffs set `fuelVariable: false` ("fuel fixed by contract") on purpose: the wiki case #5290 (fuel 27,5% billed against a 25% contract) must stay a PRICE difference. Tariffs created without the field default to variable fuel for international carriers.
