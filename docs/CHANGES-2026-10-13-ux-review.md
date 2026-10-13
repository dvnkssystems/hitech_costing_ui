# Quotation wizard and console: UX review fixes (13 Oct 2026)

Source: two end-to-end gstack QA runs on the local site (hitech.localhost via
localhost:8094), the second creating and submitting a real quotation
(SAL-QTN-2026-00009). Reports and screenshots:
`.gstack/qa-reports/run-20261013T095138Z/` and `.gstack/qa-reports/run-20261013T101107Z/`
(verification shots for this change set in `…101107Z/verify/`).

Status: fixed on local, verified in the browser with gstack. Not yet deployed.

Repositories touched:

- **hitech_costing_ui** (this repo): the wizard, lists, Home, formatting.
- **hitech_costing** (`apps/hitech_costing`, branch `version-16`): quotation submit/save, Home dashboard methods, wizard-layout defaults.
- **custom_ui**: `get_wizard_layout` now returns each row's position (`idx`). This was done earlier the same day; it is uncommitted on the local checkout and still has to go onto custom_ui `main`.

---

## Round 0: found in the second test run, fixed first

| # | Problem | Fix | Where |
|---|---|---|---|
| B1 | The costing sheet could be clicked through with no materials, 0 kg and 0 mm; the item priced at ₹0. | Dimensions (all six sizes above 0) and Volumes (at least one material row with a weight) block Next. Save item and Submit run the same checks, so jumping ahead with the sub-step tabs does not skip them. | `costingInputsError()` in `src/lib/costingWorksheetWizard.js`; `itemNext()` and `submitAll()` in `CostingWorksheetWizard.vue` |
| B2 | An export quote was submitted with ₹0 freight and no address; the warning appeared only after Submit. | A "Before you submit" box on Review covers export freight at ₹0, no customer address, no payment terms, and conflicting terms (A2). Each warning has a **Fix** link. Submit stays disabled until "Submit anyway" is ticked, and the disabled button has a tooltip explaining why. | `submitWarnings`, `submitAnyway` in the wizard |
| B3 | On a new quote, picking a Terms template left Term Details empty, and the submitted quote had 0 checklist terms. | The template watcher ignored the first pick on a new quote; it now skips only when the whole quotation is swapped. The backend also fills both on Submit: the default checklist if the quote has none, and Term Details from the chosen template if empty. Save no longer lets an empty checklist from the page wipe a saved one. | Wizard `tc_name` watcher; `ensure_terms_checklist`, `fill_term_details`, `save_draft_quotation` in `hitech_costing/quotation.py` |
| B4 | On a new quote, picking a Payment Terms Template did not fill the schedule. | Same watcher fix as B3. | Wizard `payment_terms_template` watcher |

## Round 1: what the customer sees and pays

| # | Problem | Fix |
|---|---|---|
| A1 | Review never showed the total. | A **Quote total** box at the top of Review lists Items, Discount (if any), Freight & logistics, Taxes "As applicable" and the Grand total. It shows INR, plus the quote's currency when that differs. Built by `quoteTotals` in the wizard. |
| A2 | Ticked terms could contradict the quote. | `termConflicts` checks two things: a ticked "Validity N days" term that differs from Date → Valid Till by more than a day, and payment-type terms (payment / advance / balance / proforma / LC) ticked while a Payment Terms template is set. Conflicts appear on the Terms step and in "Before you submit". |
| B5 | Deal Price started equal to cost and reaching 20% took guessing. | Commercials shows "Minimum deal price for a 20% margin: ₹X/kg", using the backend formula (FG cost + yield cost) ÷ 0.8, rounded up. The blocking margin message now names that price. `minDealPriceForMargin()` |
| B7 | Export quotes started with no Mode of Transport, and an empty address went unexplained. | Export defaults every item's Mode of Transport to Sea (never overwriting a choice). The Address step says when the customer has no address on file, with a link to the customer. Address auto-fill itself already existed; the test customer simply had no address. |
| B6 | "Doesn't fit the container" when the real cause was missing dimensions. | When the dimensions are missing, the messages say "Add dimensions" or "Enter the tank's dimensions first (Costing Sheet → Dimensions)". |

## Round 2: one language across the app

| # | Problem | Fix |
|---|---|---|
| A3 | Status words differed: Home said Lost, the list chips said Rejected, list rows said Submitted, and drafts showed "—". | Draft / Pending approval / Approved / Quoted / Lost everywhere. List rows show the costing stage, or "Cancelled" for cancelled quotes. Drafts with no worksheet show "Draft" in the list, on Home, and in the backend `get_recent_quotations`. |
| A12 | Money formats were mixed (₹15,677,003.8152 and 1438765). | All numbers use Indian grouping (`NUMBER_LOCALE = 'en-IN'` in `src/utils/format.js`). A new `moneyTotal()` shows amounts at 2 decimals (list Grand Total, step 03 amounts, Quote total). Per-kg costing figures keep `money()`'s 4 decimals; that is a documented choice. |
| A13 | Developer wording on screen. | The type picker, Tank type note and Quotation list subtitle are rewritten in plain language. Save and submit errors pass through `plainError()`, so "Error: Value missing for Costing Worksheet: Customer" becomes "Please fill in: Customer." |

## Round 3: wizard ease of use

| # | Problem | Fix |
|---|---|---|
| A4 | Step 01 Next was greyed out with no reason. | Next is clickable and says "Please fill in: Customer." (`customerStepNext`, `customerStepMissing`). |
| A5 | Required fields were red before anything was typed. | The red styling for empty required fields is held back (`.qw-quiet-required` in `src/assets/frappe-form.css`) until a Next or Save attempt on that step (`showRequired`). The asterisk still marks the field. |
| A6 | Step names were cut off ("03 Items & Prici…"). | Step names wrap onto two lines, have a tooltip, and the bar never splits into two rows (`WizardProgress.vue`). |
| A7 | Step 02 had a step bar inside the step bar. | A line above the item's sub-steps: "Item 1 of 1 · CRG · step 3 of 6: Volumes & Weights". |
| A8 | Step 03 showed numbers without units and with long decimals, and repeated the same total four times. | Column headers say "Deal price (₹/kg)" and "Built-up cost (₹/kg)". Margin % in the table shows 2 decimals. Other percentages on screen show 2 decimals, except Pure Margin %, which keeps every digit because it is checked against the 20% floor. Totals are Items / Discount / Freight / Grand total, the same figures as Review. The sticky Back/Save/Next bar is kept on purpose, and content scrolls clear of it. |
| A9 | Discount % sat on the Address step. | It moved to Items & Pricing, under Totals (new `PRICING_HEADER_FIELDS` and Wizard Layout section `pricing_header`), and the discount is included in the Quote total. |
| A10 | Review numbered its sections 01–05 while the step bar ran 01–08. | Review uses the step bar's numbers (01, 04, 05, 06, 07). |
| A11 | Two fields were both labelled "Shipping Address". | The address texts read "Billing address" and "Ships to". These labels are set through the Wizard Layout record, so they stay editable in the desk. |

## Round 4: smaller fixes

| # | Problem | Fix |
|---|---|---|
| B9 | A refresh lost the quote. | After the first Save, the page address gets `?quotation=SAL-QTN-…` (`history.replaceState`, so the screen does not reload). |
| B8 | Port lists were not filtered by region. | The Port of Discharge picker offers only ports that have an International Freight Rate in the selected Freight Region. |
| B10 | Duplicate left Valid Till blank, and the step bar wrapped. | A copy gets today's date and Valid Till one month on. The step bar fix (A6) also stops the wrap. |
| B13 | Gross weight showed 0 on Exim. | Opening Exim re-runs the freight preview. |
| A14 | Customers list said "2+ records" and repeated the name in the ID column. | A search whose first page is not full reports an exact count. A list whose names turn out to equal the title field (Customer named by Customer Name) shows one column, headed with that field's label ("Customer Name"). `src/lib/docList.js`, `DocListView.vue` |
| A15 | Home's "Modified" column was cut off. | Tighter cell padding, customer names wrap, and the date column never wraps. |

## Round 5: technical

| # | Problem | Fix |
|---|---|---|
| T2 | Every saved quote logged a 404 "Workflow not found" console error. | Workflow transitions are only requested when the DocType has an active Workflow. This is checked once per page load (`src/lib/frmCompat.js`). |
| T1 | Wizard step tabs were invisible to keyboard and screen readers. | The tabs are now a real list of real buttons; `role="listitem"` on the button had replaced its button role. |
| B12 | Child-table cells had no labels. | Every unnamed input in a table body gets its column header as `aria-label` (`src/lib/formEnhance.js`). |
| B11 | The PDF error showed a raw message. | `pdfErrorMessage()` explains it in plain words and suggests Print. **Open item:** locally, wkhtmltopdf cannot resolve `hitech.localhost`, so PDF download fails on this machine. It needs checking on production before anyone relies on it. |

## Also in this change set (same day, before the rounds)

- **Step 01 field order:** follows the Wizard Layout table's row order across its two sections (`customer` and `customer_dates`), using the new `idx` from custom_ui. The parts of the step have even spacing between them.

## Backend changes (hitech_costing)

- **`quotation.py`:**
  - `ensure_terms_checklist` and `fill_term_details` run in `submit_quotation`.
  - `save_draft_quotation` ignores an empty checklist list sent from the page.
- **`dashboard.py`:** `get_recent_quotations` returns "Draft" for a quote with no worksheet.
- **`setup/wizard_layout_defaults.json` and `setup/wizard_layout.py`:**
  - new `pricing_header` section;
  - discount removed from `address`;
  - default labels for the address texts (a new `labels` key in the defaults file).
- **The local Wizard Layout record** was updated to match. Production creates its record from the defaults on first migrate.

## Verified (gstack, local)

- **Home:** 0 console errors. The draft shows "Draft".
- **Quotation list:** chips read Draft / Pending approval / Approved / Quoted / Lost, no row says "Submitted", and amounts look like ₹14,38,764.79.
- **Customers:** search "volt" gives "2 records… Showing 2 of 2", in one "Customer Name" column.
- **New quote:** plain wording. Customer starts white; Next says "Please fill in: Customer." and only then turns it red. Step tabs are buttons.
- **Saved draft (SAL-QTN-2026-00010):**
  - 0 console errors (no Workflow 404).
  - Quote total box shown; Review numbering 01 / 04 / 05 / 06 / 07.
  - Address note shown; payment-term conflict listed.
  - Item position line shown; "Minimum deal price for a 20% margin: ₹82.78/kg".
  - Export sets Mode of Transport to Sea.
  - Europe ports only.
- **Earlier in the day:**
  - Dimensions and Volumes blocks.
  - "Before you submit", with "Submit anyway" enabling Submit and Fix navigating.
  - A new quote fills Term Details and the payment schedule.
  - Backend submit-time fill (26 rows plus template text).
- **Backend tests:** test_quotation_customizations 11/11, test_quotation_print 12/12, test_exim 21/21, test_costing_module 79/80. The one failure (95.85 ≠ 83.0) was failing before this work.

## Test records left on the local site

- **SAL-QTN-2026-00009:** submitted before the B3 fix, so it has no terms.
- **SAL-QTN-2026-00010:** draft.
- **CW-2026-00041:** the worksheet behind 00009.
- The worksheet behind 00010.

Delete or keep as you like.

## Not done / follow-ups

- **PDF on production:** check the wkhtmltopdf host setting.
- **Payment amounts:** the schedule's Payment Amount is an editable number box drawn by the UI library, so it still shows plain digits (1438765) rather than ₹ formatting.
- **Conflict checks:** A2 only checks validity days and payment terms; free-text clauses in Term Details are not compared.
