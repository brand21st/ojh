# Handover manifest and booking-gap report

Date: 2026-11-15  
Scope: the approved cycle only. Pickup handover Excel, address overflow, and CEPT response identifiers. No new India Post Excel schema, no live production booking, and no post-office email product.

## Readiness

**READY WITH CONDITIONS**

Conditions:

- The 26-column file is a PostBus handover list. It is not an official India Post portal, SFTP, or Bulk Booking upload template.
- No live CEPT booking was sent.
- Commerce booking still cannot select `SP_INLAND_DOC` (database check). Unchanged.
- `nodemailer` is not installed. Manifest email code that already existed in the tree loads it only when a message is sent.

## Sample fixture

`MF-DRAFT-20261114-21840020.xlsx` (not committed; customer data):

| Check | Result |
|---|---|
| Sheets | `Manifest`, `Summary` |
| Columns | 26, same order as `MANIFEST_EXPORT_HEADERS` |
| Articles | 40, unique S10 barcodes, check digits valid |
| Weight | 5800 g |
| Payment | 34 PREPAID, 6 COD, COD total 2848, no prepaid row with a non-zero COD amount |
| Mobiles | 13 numbers stored as 12-digit `91…`; 2 valid 10-digit numbers that start with `91` and must not be stripped |
| After `extractIndiaMobileDigits` | all 40 receiver mobiles are valid |
| Address line 1 | 3 rows exactly 80 characters |

The unit fixture in `modules/manifests/validate-export.test.ts` reconstructs those aggregates. It does not copy the customer workbook.

## What changed

| Area | Change |
|---|---|
| Handover Excel and CSV | Receiver and sender mobiles are written as 10-digit text when the stored value is a valid Indian mobile. Invalid values are not padded or truncated. |
| Export gate | `GET /api/v1/manifests/:id/export-validation` returns per-order issues. Excel and CSV return 409 when any issue is an error. PDF is unchanged. Missing tariff and an address that does not fit three 80-character lines are warnings. |
| Manifest detail | Shows the handover check. Excel and CSV stay disabled while that check is loading or has errors. |
| Formula cells | `writeWorkbook` prefixes `=`, `+`, `-`, `@` the same way CSV already did. |
| Address wrap | A fourth chunk is no longer glued onto line 3. Booking validation rejects that overflow. Shopify keeps the original street text and marks it for review. |
| CEPT ids | `custom_id` and `mail_booking_dom_id` are stored on `shipments.metadata` as `ceptCustomId` and `ceptMailBookingDomId` without clearing `ceptSubmitIntentAt`. |
| WooCommerce | New and updated addresses store `extractIndiaMobileDigits` in `phone` and the original text in `original_phone`. Invalid numbers are left as entered. |

## Compliance matrix

| Requirement | Implementation | Status |
|---|---|---|
| Normalize `919632306200`, `+919632306200`, `9632306200` | `extractIndiaMobileDigits` / `indiaPostMobile` | Met. Existing behaviour, now used on handover export and Woo persist. |
| Do not strip a 10-digit number that starts with `91` | Same helper | Met. `9108938854` stays `9108938854`. |
| Do not invent an official Excel schema | 26-column handover kept | Met. |
| Do not treat HTTP 200 as every article booked | `classifyMultiArticleOutcome` | Already met. 95 booked / 5 failed / 0 recovery is covered by test. |
| Persist `custom_id` and `mail_booking_dom_id` | `metadataWithCeptBookingIds` | Met when CEPT sends them. |
| Do not silently drop address text on booking | Validator error when wrap reports overflow | Met. |
| Post-office email | Not part of this cycle | Not built here. |

## Tests

Passed in this cycle:

- `modules/manifests/validate-export.test.ts`
- `modules/manifests/service.test.ts`
- `modules/india-post/address-lines.test.ts`
- `modules/india-post/endpoints.test.ts`
- `lib/phone/india-whatsapp.test.ts`
- `lib/xlsx/xlsx.test.ts`
- `modules/india-post/booking-phase0-safety.test.ts` (includes the 95/5 split)
- `modules/woocommerce/woocommerce.test.ts`
- `modules/orders/prebooking-validation.test.ts`
- `modules/shopify/shipping-contact.test.ts`
- `modules/india-post/article-validator.test.ts`
- `modules/india-post/article-mapper.pickup.test.ts`
- `modules/india-post/parcel-weight-booking.test.ts`
- `modules/india-post/booking-dimensions.test.ts`
- `modules/manifests/india-post-excel.test.ts`
- `tsc --noEmit -p tsconfig.build.json`

Browser, signed-in merchant, draft `9015a82e-8557-48b8-ba24-2ff0274af04d` (14 Nov 2026, office `22360049`, 8 articles):

- `GET .../export-validation` returned 200 with `errorCount: 0`.
- Export menu offered Handover list (.xlsx), and it was not disabled.
- `GET .../export?format=xlsx` returned 200, an xlsx content type, and a zip payload (4690 bytes).
- That draft had no invalid mobiles, so the on-screen error table was correctly absent. The invalid-mobile block is covered by the unit test and the 409 on the export route.

Not verified: a live India Post booking response that includes `mail_booking_dom_id`, and whether a post office will accept the 26-column file as an upload.
