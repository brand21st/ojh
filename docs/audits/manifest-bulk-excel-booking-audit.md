# PostBus manifest, bulk Excel, and India Post booking audit

Date: 2026-11-14  
Scope: read-only. No application code, schema, data, or bookings were changed.  
Evidence labels: **VERIFIED** (code, schema, template, or the approach document), **INFERRED** (likely from that evidence), **UNVERIFIED** (not tested against live India Post or the missing sample workbook).

## Reference files

| Requested file | Status |
|---|---|
| `118_kltrends_2026-10-01_postbridge(3).xlsx` | **Missing** from the repository. Sheet contents, 118 data rows, cell formats, and hidden columns of that file were not inspected. |
| `New_Customer_Integrations_approach_document_31052026 -new(8).docx` | **Not present** under that exact name. |
| `New_Customer_Integrations_approach_document_31052026 -new.docx` | **Present** at the repo root. Used as the India Post API reference. |
| `modules/india-post/templates/article-details.template.xlsx` | **Present.** Header-only ArticleDetails sheet (48 columns) plus Information sheet. This is what the app clones when it writes an ArticleDetails workbook. It is not the 118-row sample. |

The filename this app generates is `{count}_{store}_{yyyy-mm-dd}_postbus.xlsx` (`articleDetailsFilename` in `modules/india-post/article-details-sheet.ts`). The missing sample is named `…_postbridge(3).xlsx`. **VERIFIED:** current code does not emit the `postbridge` suffix or a `(3)` copy marker.

---

## REPORT 1 — Executive summary

PostBus already has two different “Excel” products and one India Post booking pipeline. They are not the same feature.

1. **Pickup manifest (implemented).** After a label exists, a shipment can be placed on today’s draft manifest for its booking office. Download produces an 11-column `Manifest` sheet plus a `Summary` sheet (`modules/manifests/export.ts`). That download does not call India Post.
2. **India Post ArticleDetails workbook (implemented, separate).** `articleDetailsWorkbook` clones the bundled 48-column template, including the Information sheet. It is used for the bulk-upload template, the validated-import preview/export, and **Export booked shipments** on the booking queue. That export reads shipments that already have `booked_at`. It does not book again.
3. **India Post booking (implemented).** JSON `POST /process-articles/{customerId}` for up to 999 articles, and `POST /process-articles-file/{customerId}` with a **JSON file**, not an `.xlsx`, above that and up to 5,000. Excel upload creates orders and shipments, then the normal booking worker submits JSON.

**Excel compatibility with the requested 48-column layout:** the ArticleDetails generator matches the supplied header list, including the trailing space in `LENGTH `, and the Information sheet in the bundled template matches the 11 supplied headers, including the spelling `INSTRICTION RTS`. **UNVERIFIED** against the missing 118-row workbook and against a live India Post Excel import.

**The dashboard Manifest Excel button does not produce that workbook.** Treating “download manifest” as “produce the India Post ArticleDetails file” would be a new behavior on top of a handover list that merchants already download.

**Major issues**

- Optional ArticleDetails fields (REG, ACK, insurance, prepayment, delivery instruction, priority, KYC, tax, alternate address, sheet sender) are validated on Excel import and then dropped. Booking rebuilds the article from the shipment plus the organization/pickup sender (`booking-run.ts` calls `mapShipmentToArticle`, which hard-codes `ack: false`, `reg: false`, empty insurance).
- JSON booking writes `codr_cod` as `COD` or `CODR`. The ArticleDetails sheet writes `cod` or `codr`. The approach document’s field table says `COD`. The bundled Information sheet shows `cod` and `codr`.
- The Information sheet’s lookup values disagree with the booking field table (prepayment `SS`/`FM`/`PS` vs `QR`/`SQ`; delivery slot `02:00-04:00` vs `9am-2pm` / `2pm-5pm` / `5pm-8pm`; delivery instruction includes `SPDS`, which the validator rejects).
- Manifest sweep loads at most 1,000 eligible shipments per call. ArticleDetails export is synchronous in the HTTP request, up to 5,000 rows, and is not stored.

**Recommended direction:** keep the pickup manifest. Reuse the existing ArticleDetails generator for a manifest-scoped export of already booked shipments. Do not send that `.xlsx` to `process-articles`. Persist the optional article fields that booking must send, instead of rebuilding them as blanks. Do not start that work until approved.

---

## REPORT 2 — Existing architecture

**VERIFIED** from `package.json`, route modules, and migrations.

| Layer | What is in the repo |
|---|---|
| Frontend | Next.js 16.4.6 App Router, React 19, TanStack Query. Merchant UI under `app/(site)/dashboard/`. |
| API | `lib/api/v1/dispatch.ts` routes into `lib/api/v1/manifests.ts`, `lib/api/v1/booking-queue.ts`, `modules/india-post/bulk-excel-routes.ts`. |
| Database | Supabase Postgres. Tables created in `supabase/migrations/`. Row-level security via `is_org_member(organization_id)`. |
| Auth | Supabase Auth (`auth.uid()` in RLS). Tenant context carries `organizationId`. Permissions: `manifests.read` / `manifests.write`. |
| Jobs | Postgres `background_jobs` drained by `lib/jobs/drain.ts`, and BullMQ workers in `workers/index.ts` on Redis (`lib/queue/queues.ts`). Manifest job type `manifest-generation`. Excel materialize job `bulk-excel-import`. Booking queue `shipment-booking`. |
| Excel | Custom reader/writer on JSZip: `lib/xlsx/read.ts`, `lib/xlsx/write.ts`, `lib/xlsx/template-clone.ts`. No SheetJS/ExcelJS dependency. |
| Storage | Supabase buckets `labels` (PDF) and `manifests` (PDF, 20 MB) in `20260919090300_rls_storage_triggers.sql`. Handover proof uses the manifest bucket. ArticleDetails bytes are returned in the HTTP response and are not written to storage. |
| India Post | `modules/india-post/provider.ts`. Session APIs under `/beextcustomer/v1`. Booking is **not** under `/v1`. |

### Capability check

| Capability | Status | Evidence |
|---|---|---|
| Shopify order sync | Present | `modules/shopify/orders.ts`, queue `shopify-sync` |
| Order management | Present | `public.orders`, `app/(site)/dashboard/orders/` |
| India Post booking | Present | `provider.bookShipment` / `bookShipmentFile` |
| Bulk booking | Present | `modules/india-post/booking-run.ts`, `bulk-booking.ts` |
| Excel booking | Present | `bulk-excel-import.ts`, `bulk-excel-routes.ts` |
| Label generation | Present | `provider.generateLabel`, queue `label-generation` |
| AWB / barcode ranges | Present | `public.barcode_ranges`, `modules/india-post/allocate-barcode.ts` |
| COD vs prepaid | Present | `modules/orders/payment.ts`, `modules/shopify/payment.ts`, `shipments.payment_mode` / `cod_amount` |
| Tracking | Present | `tracking_events`, `modules/india-post/tracking-sync.ts` |
| Manifest (pickup list) | Present | `modules/manifests/` |
| Manifest as 48-column ArticleDetails | **Missing** on the manifest download | `manifestXlsx` writes sheets `Manifest` and `Summary` |
| ArticleDetails export of booked shipments | Present, booking queue | `modules/booking-queue/export.ts` |
| Per-merchant India Post credentials | Present | `india_post_connections` |
| Booking status | Present | `shipments.status`, `booking_queue_items` |

### Relevant modules

| Path | Function | Purpose | Depends on | Behavior |
|---|---|---|---|---|
| `app/(site)/dashboard/manifests/page.tsx` | page | List manifests; “add ready shipments”; Excel link | `GET/POST /api/v1/manifests` | Excel href is `/api/v1/manifests/{id}/export?format=xlsx`. Copy says labelled shipments join today’s draft. |
| `app/(site)/dashboard/manifests/[id]/page.tsx` | detail | View one manifest | `GET /api/v1/manifests/{id}` | Not re-read line by line in this pass; list page and API cover create/export. |
| `lib/api/v1/manifests.ts` | `handleManifestRoutes` | Manifest HTTP API | `modules/manifests/*` | POST collection = sweep. GET export builds CSV, PDF, or xlsx in process. No booking call. |
| `modules/manifests/service.ts` | `assignToDraft`, `sweepEligible`, `getManifest` | Draft per org + IST date + office | RPC `manifest_add_shipments` | Eligible only with barcode and status in the booked/label set. Unique shipment. |
| `modules/manifests/export.ts` | `manifestXlsx` | Pickup spreadsheet | `lib/xlsx/write.ts` | 11 columns. Not ArticleDetails. |
| `workers/processor.ts` | `generateManifest` | Auto-manifest after label | `assignToDraft` | Does not book and does not write Excel. May enqueue Shopify fulfillment. |
| `modules/booking-queue/export.ts` | `bookedArticleDetailsExport` | ArticleDetails of booked shipments | `mapShipmentToArticle`, `articleDetailsWorkbook` | Requires `booked_at`. Does not call India Post. Cap 5,000. |
| `modules/india-post/article-details-sheet.ts` | `articleDetailsRow`, `articleDetailsWorkbook` | 48-column row + template clone | Template base64 | Booleans, text PINs, styled weight/COD. |
| `modules/india-post/bulk-excel-import.ts` | `confirmImportBatch`, `materializeRow` | Upload → validate → create order/shipment → queue booking | `bulk_import_batches` | Confirm enqueues `bulk-excel-import`. Does not POST the xlsx. |
| `modules/india-post/booking-run.ts` | booking submit | Validate, claim, POST | `provider.bookShipment` or `bookShipmentFile` | Transport from article count. Idempotency via `booked_at` and submit-intent metadata. |
| `modules/india-post/provider.ts` | `bookShipment`, `bookShipmentFile` | HTTP | Bearer token | File body is `articles.json` (`indiaPostArticlesFileJson`). |
| `modules/india-post/endpoints.ts` | URL builders | CEPT paths | env base URL | See Report 7. |
| `modules/india-post/booking-apply.ts` | `classifyMultiArticleOutcome` | Partial success | response `valid_articles` / `error_articles` | Unnamed articles go to recovery, not a second POST. |
| `components/booking-queue/queue-actions.tsx` | button | “Book with India Post” | booking API | Separate from export. |
| `components/booking-queue/export-booked-dialog.tsx` | dialog | “Export booked shipments” | `POST /api/v1/booking-queue/export` | ArticleDetails. No booking. |
| `components/bookings/bulk-excel-wizard.tsx` | wizard | Excel upload | excel-import routes | Confirms booking after validation. |

---

## REPORT 3 — Existing workflow

### A. India Post booking (Shopify / queue)

```text
Order imported
  → shipment row (weight, dims, payment_mode, cod_amount, address)
  → merchant approves "Book with India Post" (or automation)
  → shipment-booking job
  → mapShipmentToArticle from shipment + organization/pickup sender
  → validateIndiaPostArticle
  → allocate barcode if empty
  → claim shipment (booked_at still null, submit intent stored)
  → POST process-articles           if count <= 999
     POST process-articles-file     if count >= 1000   (JSON file, not xlsx)
  → valid_articles / error_articles / recovery
  → shipment booked_at, status, tariff
  → label job
  → if auto manifest: manifest-generation job
```

**VERIFIED:** export is not on this path. **VERIFIED:** a second export does not open this path.

### B. Bulk Excel booking

```text
Upload .xlsx
  → parse (ArticleDetails or mapped PostBridge-style columns)
  → validate rows (mapExcelRowToArticle)
  → preview / download ArticleDetails (no booking)
  → Confirm
  → job materializes order + address + shipment
     (barcode, weight, dims, COD, bulk reference as order number)
     optional sheet flags are not copied onto the shipment
  → booking queue
  → same JSON booking path as A, rebuilt from the shipment
```

**VERIFIED** in `confirmImportBatch` and `materializeRow` (`bulk-excel-import.ts` around the shipment insert) and `booking-run.ts` `mapShipmentToArticle`.

### C. Pickup manifest

```text
Label ready (or sweep of LABEL_READY / MANIFEST_PENDING / MANIFEST_READY)
  → assignToDraft → RPC manifest_add_shipments
  → one open DRAFT per organization + IST date + office
  → close assigns MF-YYYYMMDD-OFFICE-NN
  → handover + optional PDF/JPEG/PNG proof
  → GET export builds Manifest/Summary xlsx, csv, or pdf on the fly
```

Unbooked shipments are not eligible: the RPC requires a barcode and a booked/label status (`20261027100000_manifests_lifecycle.sql`). A shipment can belong to only one manifest (`manifest_shipments_shipment_uidx` on `shipment_id`).

### D. ArticleDetails export of already booked shipments

```text
Booking queue → Export booked shipments
  → POST /api/v1/booking-queue/export
  → shipments where booked_at is not null, this organization only
  → articleDetailsWorkbook
  → download {count}_{store}_{date}_postbus.xlsx
```

No status update. No barcode allocation. No India Post call. **VERIFIED** in `bookedArticleDetailsExport`.

### Phase 2 answers (pickup manifest)

| # | Question | Result |
|---|---|---|
| 1–3 | Where / how created | `/dashboard/manifests`. POST sweeps labelled shipments onto today’s draft. Auto job does the same after label when `auto_manifest` is on. |
| 4 | Multi-select | API `POST /manifests/{id}/shipments` accepts up to 500 ids. List page button sweeps all eligible; it is not a checkbox of orders. |
| 5 | Multiple shipments | Yes. `manifest_shipments`. |
| 6–7 | Booked only | Sweep uses label-ready statuses. Manual add RPC also allows `BOOKED` and `LABEL_PENDING`. No barcode → excluded. |
| 8 | Automatic | Only when automation `auto_manifest` is true, after the label job. |
| 9 | Approval | Draft → close → handover. Not an India Post approval. |
| 10 | Preview | Detail page loads the manifest. No ArticleDetails preview there. |
| 11 | Download | Yes: xlsx, csv, pdf. xlsx is the 11-column handover file. |
| 12–13 | History / re-download | Rows stay in `manifests`. Export is regenerated. The xlsx is not stored. |
| 14 | Duplicate manifests | One draft per org/date/office. One shipment on one manifest. Re-export does not create another manifest. |
| 15–16 | Merchant + shipment link | `organization_id` on both tables. `manifest_shipments.shipment_id`. |
| 17 | Linked to booking batches | **No** foreign key to `booking_runs` or bulk import batches. Office id on the shipment groups the draft. |
| 18 | Stored file | `manifests.file_path` exists. Application export does not fill it. Proof file is separate. |
| 19 | Configurable format | No. Headers are constants. |
| 20 | Failure | RPC/query errors surface as API errors. Audit insert failure is logged and does not roll back (`MANIFEST_AUDIT_FAILED`). |

Class: pickup manifest **Fully implemented** for handover. ArticleDetails-as-manifest **Missing** on that screen. ArticleDetails export **Fully implemented** on the booking queue for shipments that already have `booked_at`. Coupling “Excel download ⇒ new booking” **not present** on either download. Coupling “Excel confirm ⇒ booking” **is present** on the import wizard.

---

## REPORT 4 — Reference Excel compatibility

### What was actually opened

Bundled template `modules/india-post/templates/article-details.template.xlsx`:

- Sheets, in order: `ArticleDetails`, `Information`. **VERIFIED** in `xl/workbook.xml`.
- ArticleDetails has one row (the header). Dimension `A1:AV1` (48 columns). No data validations, no formulas, no hidden rows in `sheet1.xml`. Customer sample rows were removed (test in `article-details-template.test.ts` asserts a single header row and no 10-digit mobiles).
- Header XML keeps `LENGTH ` with the trailing space (`xml:space="preserve"`). The in-app reader trims headers on read-back (`article-details-template.test.ts`).
- Information dimension `A1:K5`. Headers match the requested 11 names, including `INSTRICTION RTS` and `DELIVERY SLOT format`.
- Information booleans are real Excel booleans (`t="b"`, `1` and `0`), not the strings `TRUE`/`FALSE`.
- Information values (not the same as the booking API enums):

| Column | Rows |
|---|---|
| SHAPE OF ARTICLE | ROLL, NROL, DOC |
| BOOLEAN | true, false |
| DELIVERY INSTRUCTION | ND, OD, SD, **SPDS** |
| DELIVERY INSTRUCTION DESCRIPTION | NORMAL DELIVERY, OPEN DELIVERY, SCHEDULED DELIVERY, SMART PARCEL DELIVERY SYSTEM |
| DELIVERY SLOT format | `02:00-04:00` (repeated) |
| INSTRICTION RTS | RTS, RTA |
| CODR/COD | `codr`, `cod` |
| INSURANCE | DOP |
| PREPAYMENT | **SS, FM, PS** |
| PREPAYMENT DESCRIPTION | SERVICE STAMPS, FRANKING MACHINE, POSTAGE STAMPS |

The Information sheet is cloned unchanged into every generated workbook (`article-details-template.test.ts`: every zip part except `sheet1.xml` stays byte-identical to the template). Nothing in booking or import code reads it as a validation source. **INFERRED:** it is a lookup sheet carried so the file matches the India Post template, not a sheet PostBus validates against. Whether India Post’s importer requires it is **UNVERIFIED**. The approach document says file structure must follow shared templates for CSV/Excel/XML, and the file booking API itself is a JSON file (Report 7).

### Structural comparison

| Requirement | Reference requested | Existing PostBus | Status |
|---|---|---|---|
| ArticleDetails sheet | Required | Booking-queue export and import export | Present there. Absent from manifest download. |
| Information sheet | Required | Cloned from template on ArticleDetails export | Present on that export only. |
| 48 columns, header order, `LENGTH ` | Required | `ARTICLE_DETAILS_HEADERS` | Match to the supplied list. **UNVERIFIED** against the missing 118-row file. |
| Barcode | Booked article number | `tracking_number` or `barcode` | Mapped on booked export. |
| Weight grams | Number | Shipment `weight_grams`, rounded | Mapped. 0 becomes a blank cell. |
| COD | `cod` / amount | Sheet uses lowercase `cod`/`codr`. API uses `COD`/`CODR`. | Split. See below. |
| Sender | Sheet columns | Organization, else default pickup. Not the Excel sender. | Partial. |
| Receiver | Address row | `addresses` via `shipping_address_id` | Mapped, then reflowed to 3×80. |
| Booleans | Excel boolean in the template | REG/OTP/ACK/PRIORITY are `t="b"`. ALT ADDRESS FLAG is text kind; false becomes an empty cell, not FALSE. | Partial. |
| Reuse existing booking | Target | Booked export requires `booked_at` and does not POST | Met on that endpoint. |
| No duplicate booking on export | Target | Manifest export and booked export do not call the provider | Met. Import **confirm** does book. |

### 48-column mapping

Sources for the **booked ArticleDetails export** (`bookedShipmentRow` → `mapShipmentToArticle` → `articleDetailsRow`). The pickup manifest xlsx does not use these columns.

| Excel column | Source table | Source field | Transformation | Current mapping | Issue | Recommendation |
|---|---|---|---|---|---|---|
| SERIAL NUMBER | none | generated | 1..n per file | Yes | Renumbered inside each split file | Keep |
| BARCODE NO | shipments | `tracking_number`, else `barcode` | uppercased | Yes, if booked | Empty string if both null; export does not require a barcode, only `booked_at` | Refuse the row when barcode is missing |
| PHYSICAL WEIGHT | shipments | `weight_grams` | `Math.round`; blank if ≤ 0 | Yes | Not volumetric. Chargeable weight is label-only | Keep physical grams. Do not substitute volumetric |
| REG | none on shipment | hard-coded `false` | Excel boolean false | Always false | Excel `reg` is not stored | Persist and send the imported flag |
| OTP | service code | `indiaPostRequiresOtp` | true only for `24_SPP_PARSPL` | Overrides sheet OTP | Other services always false | Same as REG, plus the NDD rule |
| RECEIVER CITY | addresses | `city` | trim | Yes | | Keep |
| RECEIVER PINCODE | addresses | `pincode` | text cell | Yes | Invalid PIN still exported; booking validates | Validate before export |
| RECEIVER NAME | addresses | `name` | trim, then address wrap does not change the name | Yes | | Keep |
| RECEIVER ADD LINE 1–3 | addresses | `line1`,`line2`,`line3` | `wrapIndiaPostAddressLines` | Yes | Overflow past 3×80 is concatenated and can exceed 80. API slices to 80; Excel does not | One wrap function for both, and surface truncation |
| ACK | none | hard-coded false | boolean | Always false | Dropped after Excel import | Persist |
| SENDER MOBILE NO | organizations, else pickup_locations | `phone` | 10-digit `6–9` extract | Yes | Sheet sender mobile ignored at booking and re-export | Use saved India Post sender, and say so in the UI |
| RECEIVER MOBILE NO | addresses | `phone` | same extract; if extract fails, raw text remains on the draft via `party()` | Yes | Invalid numbers can be written into the sheet | Validate |
| PREPAYMENT CODE | none | empty | | Blank | `QR`/`SQ` from Excel not stored | Persist or keep blank |
| VALUE OF PREPAYMENT | none | empty | blank unless > 0 | Blank | | Persist |
| CODR/COD | shipments | `payment_mode`, `cod_amount` | `cod` if COD and amount > 0, else blank. Kind is always `COD` from shipment mapping, so `codr` is never written on this export | Partial | Case is `cod` in Excel and `COD` in JSON. CODR lost | One canonical value, confirmed with India Post |
| VALUE FOR CODR/COD | shipments | `cod_amount` | number if COD and > 0, else blank | Yes for shipment COD | Prepaid blank, not 0. Partial-paid orders become COD only when the shipment was stored that way | Keep shipment amount; do not recompute from order total at export |
| INSURANCE TYPE | none | empty | | Blank | DOP dropped | Persist |
| VALUE OF INSURANCE | none | empty | | Blank | | Persist |
| SHAPE OF ARTICLE | service + weight | `indiaPostShapeOfArticle` | NROL for parcel products, DOC for document products | Yes | Excel shape not stored | Persist when the sheet set it |
| LENGTH  | shipments | `length_cm` | number; blank if ≤ 0 | Yes | Header trailing space preserved in XML | Keep the space |
| BREADTH/DIAMETER | shipments | `width_cm` | same | Yes | | Keep |
| HEIGHT | shipments | `height_cm` | same | Yes | | Keep |
| PRIORITY FLAG | none | false (`priorityFlag` empty → not `"TRUE"`) | boolean false | Always false | | Persist |
| DELIVERY INSTRUCTION | none | empty | | Blank | ND/OD/SD dropped | Persist |
| DELIVERY SLOT | none | empty | | Blank | | Persist |
| INSTRUCTION RTS | none | empty | | Blank | | Persist |
| SENDER NAME | organizations, pickup_locations, shopify_stores | `organizationLabelSender` | org name, else pickup contact, else shop, else `"Merchant"` | Yes | Not `india_post_connections` and not the Excel sender | Document the source; do not silently prefer the sheet |
| SENDER COMPANY NAME | organizations, else pickup name, else sender name | `exportContext` | | Yes | | Keep org name |
| SENDER CITY | organizations, else pickup | `city` | | Yes | | Keep |
| SENDER STATE/UT | organizations, else pickup | `state` | | Yes | | Keep |
| SENDER PINCODE | organizations, else pickup | `pincode` | text | Yes | Booking uses origin office PIN, which can differ from this export PIN | Use the same origin the booking used (`booking_office` / origin pin) |
| SENDER EMAILID | none passed | | blank | Missing | Org email is not selected | Map it if the product needs it |
| SENDER ALT CONTACT | none | | blank | Missing | | Optional |
| SENDER KYC | none | | blank | Missing | | Optional |
| SENDER TAX | none | | blank | Missing | | Optional |
| RECEIVER COMPANY NAME | addresses | `company_name` | blank when it equals the person name | Partial | | Keep |
| RECEIVER STATE/UT | addresses | `state` | trim | Yes | | Keep |
| RECEIVER EMAILID | addresses | `email` | trim | Yes | | Keep |
| RECEIVER ALT CONTACT | none on export | | blank | Missing | Excel column not copied to `addresses` | Persist if required |
| RECEIVER KYC | none | | blank | Missing | | Optional |
| RECEIVER TAX REF | none | | blank | Missing | | Optional |
| ALT ADDRESS FLAG | none | `altAddressEnabled` false | null → empty cell, not FALSE | Not a boolean FALSE | Template column kind is text | Match the template’s boolean style after India Post confirms |
| BULK REFERENCE | orders | `order_number` | trim, no 50-char cut on this path | Yes | Excel import stores the sheet reference as the order number, so it round-trips that way. Shopify order names are used for Shopify. Longer than 50 can be exported; the API slices to 50 | Slice to 50 and keep order number |
| SENDER ADD LINE 1–2 | organizations, else pickup | `line1`, `line2` | skips the literal `Registered pickup` | Yes | Line 3 is never set | Add line 3 only if a real third line exists |
| SENDER ADD LINE 3 | none | | blank | Missing | | Leave blank |

`shipment_packages` is not read by the export. Dimensions are shipment-level, not product-level. **VERIFIED** by the export `select` list.

COD is not “every unpaid order”. `settleOrderPayment` gives COD amount 0 for `PENDING`. `PARTIAL` becomes a COD shipment only when a remaining amount is stored (`shipmentCollectFromOrder`). Shopify classification uses financial status, gateways, and outstanding (`modules/shopify/payment.ts`). The export then trusts `shipments.payment_mode` and `shipments.cod_amount`.

---

## REPORT 5 — Bugs and risks

### P0

No verified defect that, by itself, makes a manifest download or a booked-shipment Excel download submit a second India Post booking.

Import **Confirm** is a booking action. That is intended, and it is a different button from download.

### P1

```text
Issue ID: PB-XL-01
Title: Excel optional article fields are validated and then discarded before booking
Severity: P1
Affected Component: Bulk Excel booking
File Path: modules/india-post/bulk-excel-import.ts (materializeRow shipment insert); modules/india-post/article-mapper.ts mapShipmentToArticle; modules/india-post/booking-run.ts
Line Reference: bulk-excel-import.ts shipment insert (~868–896); article-mapper.ts ack/reg/insurance defaults (~132–138); booking-run.ts mapShipmentToArticle (~692–729 and ~820)
Current Behavior: REG, ACK, OTP (except 24_SPP_PARSPL), insurance, prepayment, priority, delivery instruction, slot, RTS, KYC, tax, and alternate address from the sheet are not columns on the shipment. Booking rebuilds the payload with those flags false or blank and with the workspace sender.
Expected Behavior: A confirmed Excel row should book the article fields that passed validation.
Root Cause: materializeRow persists barcode, weight, dimensions, COD, and address only. booking-run always calls mapShipmentToArticle.
Production Impact: India Post receives a thinner article than the sheet the merchant validated. Insurance, acknowledgement, and delivery instructions will not be booked.
Recommended Fix: Persist the validated article snapshot on the shipment (or booking record) and have both the booking serializer and the ArticleDetails exporter read that snapshot.
```

```text
Issue ID: PB-XL-02
Title: COD token differs between the JSON API and the ArticleDetails sheet
Severity: P1
Affected Component: Booking payload vs Excel
File Path: modules/india-post/booking-payload.ts; modules/india-post/article-details-sheet.ts
Line Reference: booking-payload.ts codr_cod (~94); article-details-sheet.ts CODR/COD (~120)
Current Behavior: JSON sends COD or CODR. The sheet sends cod or codr. Shipment mapping never sets CODR, so re-export cannot emit codr.
Expected Behavior: One value India Post accepts in each channel.
Root Cause: Two writers. The approach document’s field table says “COD”. The bundled Information sheet says “cod” and “codr”. The sample JSON uses an empty string for non-COD.
Production Impact: A workbook generated for portal upload may not match the JSON already accepted by process-articles. UNVERIFIED which spelling the Excel importer requires.
Recommended Fix: Confirm with India Post. Do not change the live JSON spelling until that confirmation.
```

```text
Issue ID: PB-MF-01
Title: Manifest Excel is not the 48-column ArticleDetails file
Severity: P1 (product gap, not a crash)
Affected Component: Manifest download
File Path: modules/manifests/export.ts; app/(site)/dashboard/manifests/page.tsx
Line Reference: export.ts MANIFEST_EXPORT_HEADERS (lines 4–16); page.tsx Excel link (~134)
Current Behavior: Download is sheets Manifest and Summary, 11 columns (barcode, order, consignee, city, PIN, service, weight, payment, COD, tariff).
Expected Behavior: The requested deliverable is the ArticleDetails workbook. That file already exists on the booking-queue export, not on this button.
Root Cause: Two products share the word manifest/excel.
Production Impact: A merchant who uploads the manifest download to India Post will not get a valid bulk file. The click does not create a booking.
Recommended Fix: Add an ArticleDetails download for the manifest’s shipments using bookedArticleDetailsExport. Leave the handover spreadsheet in place.
```

### P2

```text
Issue ID: PB-XL-03
Title: Booked ArticleDetails export does not run India Post validation
Severity: P2
Affected Component: modules/booking-queue/export.ts bookedShipmentRow
Line Reference: ~69–108
Current Behavior: Invalid PIN, phone, or missing barcode can still be written. Weight 0 becomes a blank cell.
Expected Behavior: Export rejects or flags rows that cannot form a legal article.
Root Cause: The function maps and writes. validateIndiaPostArticle is only on the booking path.
Production Impact: A file can look complete and still fail an India Post import.
Recommended Fix: Run the existing validator and return a row-level error sheet. Do not invent defaults.
```

```text
Issue ID: PB-XL-04
Title: Sender PIN on the sheet can differ from the PIN used to book
Severity: P2
Affected Component: export vs booking-run
File Path: modules/booking-queue/export.ts exportContext; modules/india-post/booking-run.ts
Current Behavior: Export uses organization or pickup PIN. Booking uses the resolved origin office PIN.
Expected Behavior: The sheet should show the sender identity that was booked.
Root Cause: Export does not read booking provenance / office PIN.
Production Impact: Portal re-upload would not match the booked article’s origin.
Recommended Fix: Prefer the stored booking origin when present.
```

```text
Issue ID: PB-MF-02
Title: Manifest sweep stops at 1,000 shipments
Severity: P2
Affected Component: modules/manifests/service.ts unmanifestedShipments
Line Reference: .limit(1000) (~326)
Current Behavior: One sweep or auto-manifest pass considers at most 1,000 eligible rows.
Expected Behavior: A large booked day should still be manifested, or the UI should say the rest is waiting.
Root Cause: Hard limit, no paging loop.
Production Impact: Shipments past the limit stay off the draft until another run. They are not booked again by this path.
Recommended Fix: Page until a time budget, or report the remainder.
```

```text
Issue ID: PB-XL-05
Title: Information sheet enums disagree with the API field table
Severity: P2
Affected Component: Template vs approach document vs article-validator
Current Behavior: Template prepayment SS/FM/PS; API and validator QR/SQ. Template slot 02:00-04:00; API 9am-2pm, 2pm-5pm, 5pm-8pm. Template instruction SPDS; validator allows only ND, OD, SD.
Expected Behavior: Lookup sheet and validator should not teach different codes.
Root Cause: The template was preserved byte-for-byte. The validator follows the approach document’s field table.
Production Impact: A merchant who copies an Information-sheet code into a sheet can fail validation. PostBus does not write SPDS or SS/FM/PS itself.
Recommended Fix: Do not “fix” the template until India Post says which list the importer uses. Show the conflict in the wizard.
```

```text
Issue ID: PB-XL-06
Title: Long addresses can be truncated differently in Excel and in JSON
Severity: P2
Affected Component: address-lines.ts; booking-payload.ts streetFields; articleDetailsRow
Current Behavior: Wrap packs into three lines and appends leftovers onto the last line. JSON then slices each line to 80. Excel writes the wrapped string with no slice.
Expected Behavior: Same text in both outputs, with an error when characters are dropped.
Root Cause: Two different finalizers.
Production Impact: Silent loss on the API; an over-long cell in Excel.
Recommended Fix: Share one finalizer.
```

```text
Issue ID: PB-DOC-01
Title: Approach document contradicts itself on several booking rules
Severity: P2 (external)
Affected Component: India Post document, not PostBus code
Current Behavior: Field table: barcode 13 characters; error list: 5–50 characters. Field table: SP_INLAND_PARCEL / BUSINESS_PARCEL; error list: article type must be SP or BP. Sample payload uses article_type "SP " and pickup_or_dropoff "dropoff"; validation text says PICKUP or DROPOFF. Sample booleans are the strings TRUE/FALSE; the field table says Boolean. JSON limit “below 1000”; error text “1 to 100,000”; file endpoint “up to 5000” as a JSON file. Address lines described as both 240 per line and varchar(80), with a 240 combined cap. physical_weight described as length 3,3 and also as a whole number 1–35000.
Expected Behavior: One rule per field.
Root Cause: The document mixes a field table, samples, and a later error catalogue.
Production Impact: PostBus follows the stricter field table for article_type (product codes, not bare SP) and 1–35000 g. Live CEPT may still enforce the error-catalogue wording. UNVERIFIED against production CEPT.
Recommended Fix: Ask India Post which section wins before changing article_type or barcode length.
```

### P3

```text
Issue ID: PB-MF-03
Title: manifests.file_path is unused by the exporter
Severity: P3
File Path: supabase/migrations/20260919090100_commerce_shipping.sql manifests.file_path; modules/manifests/export.ts
Current Behavior: Every download is rebuilt. History of the exact bytes is not kept.
Expected Behavior: Only required if merchants must re-download a byte-identical file.
Recommended Fix: Store the ArticleDetails bytes only if audit/replay is a requirement.
```

```text
Issue ID: PB-XL-07
Title: Generated filename uses postbus, not postbridge
Severity: P3
File Path: modules/india-post/article-details-sheet.ts articleDetailsFilename
Current Behavior: `{count}_{slug}_{date}_postbus.xlsx`, with `_partN` when split.
Expected Behavior: The missing sample is named `118_kltrends_2026-10-01_postbridge(3).xlsx`.
Recommended Fix: Treat filename as non-contractual unless India Post matches on it. Do not copy the `(3)` suffix.
```

### Edge scenarios

| # | Scenario | Current behavior | Expected | Risk | Cause |
|---|---|---|---|---|---|
| 1 | No AWB | Manifest RPC skips it. Booked export can still emit a blank barcode if `booked_at` is set and both barcode fields are empty. | Omit or fail the row | P2 | Export filter is `booked_at`, not barcode |
| 2 | Selected twice | Id list is de-duplicated. One shipment row cannot be inserted twice | One row | Low | `Set` in export; PK on shipment |
| 3 | Two manifests | Prevented. Unique index on `manifest_shipments.shipment_id`. Insert `on conflict do nothing` | One manifest per shipment | None for duplicates | Migration `20261027100000` |
| 4 | Many products | One ArticleDetails row per shipment, using shipment weight and dimensions. Line items are not columns | Shipment-level article | Medium if weight was summed wrong at booking | Export select has no line items |
| 5 | Partial payment | Shipment COD amount is the stored remainder when status is COD or PARTIAL with a positive remainder. Export does not re-read Shopify outstanding | Remaining collect, not order total | Medium if the shipment was stored before the partial-payment fix | `shipmentCollectFromOrder` |
| 6 | Partial fulfillment | Export does not expand products. It exports each shipment once. Allocation logic was not re-audited line by line in this pass | One row per booked parcel | UNVERIFIED for a split fulfillment that created two shipments | Not in the Excel writer |
| 7 | Long address | Reflow, then possible truncation on the API only | Keep text or show an error | P2 | PB-XL-06 |
| 8 | Bad phone | Booking returns a validation error and does not POST. Booked export still writes the cell | Clear error on both paths | P2 | PB-XL-03 |
| 9 | Partial booking success | `classifyMultiArticleOutcome` splits accepted, rejected, and unproven. Unproven articles are not posted again | Distinguish them | Low if CEPT returns barcodes | `booking-apply.ts` |
| 10 | Export twice | New xlsx bytes. No booking request | No second booking | None on export | export.ts has no provider import |
| 11 | Cancelled after booking | Manifest eligibility is shipment status. Cancel does not by itself delete `manifest_shipments`. A later sweep will not add `CANCELLED` because it is outside the status list. An already linked row stays. Booked export still includes it if `booked_at` is set | Decide whether cancelled booked articles stay on the handover list | Medium | No cancel hook in `modules/manifests` |
| 12 | Two merchants | Queries and RLS use `organization_id`. Unique barcode is per organization | Isolation | See Report 10 | Service methods take `organizationId` |

---

## REPORT 6 — Database assessment

Core tables (`20260919090100_commerce_shipping.sql` plus later migrations):

- `orders` → `addresses`, `customers`, `order_line_items`
- `shipments` → `orders`, `addresses` (`shipping_address_id`), `pickup_locations`. Unique `(organization_id, barcode)` where barcode is not null
- `manifests` → `organizations`. Lifecycle columns in `20261027100000_manifests_lifecycle.sql`: `manifest_number`, `manifest_date`, `office_id`, `office_name`, status `DRAFT|CLOSED|HANDED_OVER`, close/handover actors
- `manifest_shipments` → manifest + shipment. Unique `(manifest_id, shipment_id)` and unique `(shipment_id)`
- One open draft per `(organization_id, manifest_date, office)` 
- `india_post_connections.excel_booking_limit` 1–5000 (`20261101150000`)
- `bulk_import_batches` / `bulk_import_rows` (used by the Excel wizard; row idempotency key `bulkImportRowId` on order and shipment metadata)
- `booking_runs`, `booking_queue_items` (`20261101180000_booking_queue.sql`)
- `orders.cod_amount_mode` `auto|manual` (`20261108090000`)
- `addresses.line3`, `company_name`, `email`

| Question | Supported now? |
|---|---|
| One manifest, many shipments | Yes |
| One shipment, one manifest | Yes (unique `shipment_id`) |
| Several export attempts | Yes, regenerated. Bytes not stored |
| Historical download | Yes, while the manifest row exists |
| Partial booking success | Yes, in application state on the shipment, not as a manifest status |
| Duplicate manifest prevention | Yes for the draft key and for shipment membership |
| Merchant access | Yes, `organization_id` + RLS |
| Failed export recovery | No stored file. The request can be repeated |
| Manifest status | DRAFT / CLOSED / HANDED_OVER |
| Concurrent create | RPC locks the draft row; close takes an advisory lock per org for the number |

No migration is proposed for execution. A later change would be justified only if optional article fields must survive booking: a snapshot jsonb on the shipment, or columns for the flags the sheet already validates. A new manifest file table is optional and only needed for byte history.

`manifests.file_path` is not a relationship to India Post batches. There is no `manifest_id` on `booking_runs`.

---

## REPORT 7 — India Post API assessment

**VERIFIED** in `endpoints.ts`, `spec.ts`, `booking-batch.ts`, `provider.ts`.

| Topic | Behavior |
|---|---|
| JSON booking | `POST {root}/process-articles/{bulkCustomerId}` with `{ articles }`. Root is `/beextcustomer` with a trailing `/v1` stripped. |
| File booking | `POST {root}/process-articles-file/{bulkCustomerId}`. Body is multipart field `file` = `articles.json`, `JSON.stringify({ articles })`. Not an xlsx. |
| When file is used | `indiaPostBookingTransport`: file only when `articleCount > 999`. JSON otherwise, including 999. |
| Documented limits | Approach doc: JSON “below 1000”; file “up to 5000” as a JSON file. Error sample also says 100,000. PostBus caps file transport at 5,000 (`INDIA_POST_FILE_BOOKING_MAX`) and will not put more than that in one file call because `indiaPostBookingBatchSize` is clamped to 5,000. Actual batch size is env `indiaPostBookingBatchSize` (default 1). |
| Auth | Bearer access token. Login/refresh under `/v1`. Tokens are encrypted on the connection. This audit did not print them. |
| Payload | `serializeIndiaPostBookingArticle`. Booleans as the strings `TRUE`/`FALSE`. PINs as strings. `pickup_or_dropoff` `PICKUP` or `DROPOFF`. `article_type` product code (`SP_INLAND_PARCEL`, `BUSINESS_PARCEL`, NDD codes), not the sample’s `"SP "`. |
| COD in JSON | `COD` / `CODR` or `""`. Amount is the number, or `""` when not COD. |
| Validation before POST | `validateIndiaPostArticle`: 6-digit PIN, mobile `^[6-9][0-9]{9}$`, S10 barcode when present, weight 1–35000 g, office id 8 digits, dimensions for parcels, COD amount > 0 when mode is COD. |
| Response | `valid_articles`, `error_articles`, `batch_id`, `correlation_id`. |
| Partial success | Accepted vs rejected vs not mentioned. Not-mentioned → recovery, no automatic re-POST (`booking-run.ts` duplicate handling and `classifyMultiArticleOutcome`). |
| Duplicate protection | Claim requires `booked_at` null. Submit intent stored before POST. Duplicate CEPT message can be recorded as already booked when the barcode is named. |
| Timeouts | `indiaPostBookingTimeoutMs` by count and transport. Not load-tested here. |
| Excel vs API | The xlsx is never the HTTP body. |

`provider.createManifest` throws: “India Post has no separate manifest REST endpoint. Booking submits articles.” **VERIFIED.**

---

## REPORT 8 — UI/UX assessment

| Surface | What the merchant sees | Booking? |
|---|---|---|
| `/dashboard/manifests` | Drafts, close, handover, Excel/PDF/CSV | Excel does not book |
| `/dashboard/automation` | “Auto manifest” after booking and label | Adds to the draft. Does not book |
| Booking queue actions | “Book with India Post” | Yes |
| Export booked dialog | “Export booked shipments” → ArticleDetails | No |
| Bulk Excel wizard | Upload, map, validate, preview ArticleDetails, confirm | Confirm books. Download of the sheet does not |

The two actions are separate controls. The risk is naming: the manifest page’s “Excel” is the handover list. A merchant can believe that file is the India Post upload. They cannot create a second booking by clicking it.

Gaps: no ArticleDetails action on the manifest page; no in-grid select-all for “make an ArticleDetails file from these manifest lines”; import wizard does not warn that REG/insurance/delivery instructions will not be sent (PB-XL-01). Mobile layout of these screens was not re-tested in a browser in this audit.

---

## REPORT 9 — Recommended architecture

Keep booking and Excel generation apart. The safe version is already how the booking-queue export works. Extend that, and do not route it through `bookShipment`.

```text
Orders / shipments (already booked)
  → select manifest lines or an explicit shipment list
  → load stored booking snapshot (barcode, COD, weight, dims, sender actually used)
  → validateIndiaPostArticle
  → articleDetailsWorkbook (ArticleDetails + Information)
  → optional storage of the bytes
  → download / history

India Post booking stays on its own path:
  Orders → queue → validate → process-articles or process-articles-file (JSON)
  → booked_at
  → later, the export above
```

Reuse:

- `articleDetailsWorkbook` / template clone
- `bookedShipmentRow` once it reads a persisted snapshot
- `validateIndiaPostArticle`
- organization filter and `booked_at` guard

Do not reuse:

- `manifestXlsx` as the India Post file
- `confirmImportBatch` inside any download handler
- `provider.bookShipmentFile` for `.xlsx`

New service: a thin “manifest ArticleDetails” function that passes the manifest’s shipment ids into the existing booked export. A new booking service is not required.

Refactor of the whole manifest stack (Option C) is not required to get a compatible workbook.

---

## REPORT 10 — Implementation roadmap

Not started. Estimates are engineering judgment, not measured.

### Option A — Change `manifestXlsx` into ArticleDetails

- Advantage: one button.
- Disadvantage: removes the handover spreadsheet. Mixes pickup operations with the India Post template.
- Risk: high for current users of that download.
- Database: none.
- Effort: small code change, high product risk.

### Option B — Manifest-scoped ArticleDetails export (recommended)

- Advantage: reuses a tested generator. Download cannot book. Handover file stays.
- Disadvantage: two downloads until the UI labels them clearly. Still wrong until PB-XL-01 persistence exists if the sheet must echo insurance and similar flags.
- Database: none for a first slice that only mirrors what booking actually sent. A snapshot column is needed for the optional flags.
- Production impact: new read-only endpoint. No status writes.
- Effort: about 3–5 days for the endpoint, UI label, and tests; plus 3–5 days if the snapshot and booking path must keep optional fields.

### Option C — Split booking, manifest, and Excel into new services

- Advantage: cleaner boundaries on paper.
- Disadvantage: those boundaries already exist. A rewrite risks the idempotency and partial-success path.
- Effort: several weeks. Not justified by the gap.

### Phases (Option B)

**Phase A — Critical fixes (no format change yet)**  
Persist the validated article fields and feed them to `serializeIndiaPostBookingArticle`. Confirm COD spelling with India Post before changing the live JSON. Stop the booked export from emitting a blank barcode.

**Phase B — Excel compatibility**  
Point a manifest action at `articleDetailsWorkbook` for that manifest’s shipments. Keep header order, `LENGTH `, text PINs, boolean flags, and the Information sheet. Do not submit the xlsx.

**Phase C — Workflow**  
Label the buttons “Handover list” and “India Post Excel”. Preview row errors from the validator. Do not add a second booking button.

**Phase D — History**  
Store bytes only if re-download must be byte-identical. Page the 1,000-row sweep if operations need it.

**Phase E — Verification**  
Tests below. No live CEPT booking. Compare a generated file to `118_kltrends_2026-10-01_postbridge(3).xlsx` once that file is in the workspace.

---

## Test plan (proposed, not executed)

### Excel

- Sheet names `ArticleDetails`, `Information`, in that order.
- 48 columns, header strings including `LENGTH ` and no extra columns.
- Information headers including `INSTRICTION RTS`.
- Row count equals selected booked shipments.
- PIN and mobile are text (`t="str"`), including a leading zero.
- REG/OTP/ACK/PRIORITY are Excel booleans.
- Empty optional money fields are empty, not 0, matching `articleDetailsRow`.
- COD row: `cod` or the confirmed token, amount equal to `shipments.cod_amount`, not `orders.total_amount`.
- Prepaid: COD columns blank.
- Barcode equals the booked barcode.
- Sender matches the booking origin, not another merchant.

### Integration

- Booking still uses JSON or JSON-file, never the xlsx.
- `valid_articles` and `error_articles` still split.
- Export handler has no call to `bookShipment` or `bookShipmentFile`.
- Second export does not change `booked_at` or status.

### Business

- Prepaid, COD, partial with a remainder, partial with no remainder.
- Multi-line order → one shipment row.
- Cancelled shipment: defined expected membership (product decision).
- Previously booked shipment exports the existing barcode.

### Security

- Organization A’s manifest id returns 404 for organization B (`loadManifestRow` filter).
- Export query `.eq("organization_id", ctx.organizationId)`.
- India Post tokens not present in the workbook.

### Performance (inspect or fixture, not production)

- 10, 50, 100 rows: request completes in the test process.
- 5,000: memory of one workbook in the request. Note the absence of a job.
- 10,000: export throws above 5,000 (`BOOKED_EXPORT_MAX`). Manifest line query is capped at 5,000 (`getManifest`).

### Explicitly out of scope

Live `process-articles`, real AWB consumption, production status updates, migrations.

---

## Feasibility note

Separation is already true for the two downloads. The work is to aim the manifest UI at the existing ArticleDetails generator and to stop losing optional fields between Excel validation and JSON booking. That does not require a new booking integration.
