const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Display precision, matched to the Frappe site's own System Settings
 * (`currency_precision = 4`, `float_precision = 6` on hitech.localhost and
 * hitech.dvnks.com). This console formats numbers client-side rather than
 * through `frappe.format_value`, so these two constants are the single place
 * that has to move if System Settings ever change — every money / rate figure
 * on screen resolves to one of them, so the console and the desk agree.
 *
 * Costing numbers here are the end of long chains of per-kg divisions, and
 * rounding them to 2dp for display used to hide real differences (two items
 * whose Total FG Cost differed in the third decimal read as the same rupee
 * figure).
 */
export const CURRENCY_PRECISION = 4
export const FLOAT_PRECISION = 6

/**
 * Money never reads with fewer than 2 decimals, even when the value has none.
 * That mirrors Frappe's own Currency formatter, which floors precision at the
 * currency's fraction-unit width (100 paise -> 2) when the stored value does
 * not actually carry `currency_precision` decimals — so ₹190.88 stays
 * ₹190.88, while ₹190.880321 shows as ₹190.8803.
 */
const CURRENCY_MIN_PRECISION = 2

function grouped(n, minimumFractionDigits, maximumFractionDigits) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: Math.min(minimumFractionDigits, maximumFractionDigits),
    maximumFractionDigits
  })
}

/**
 * Money-grade decimals, no currency glyph: up to `CURRENCY_PRECISION` (4),
 * never fewer than 2 — `1234.5` -> '1,234.50', `190.880321` -> '190.8803'.
 * Pass `digits` only to deliberately narrow a figure (a compact tile).
 */
export function decimal(n, digits = CURRENCY_PRECISION) {
  return grouped(n, CURRENCY_MIN_PRECISION, digits)
}

/**
 * Float-grade decimals: up to `FLOAT_PRECISION` (6), trailing zeros trimmed —
 * `2.5` -> '2.5', `1.2345678` -> '1.234568', `3` -> '3'. Trimming rather than
 * padding keeps a rail of rates readable (the desk pads Float fields out to
 * the full 6, which is the one place this deliberately differs); the digits
 * that carry information are all still there.
 *
 * Use this for anything that is not money: rates, multipliers, exchange rates,
 * scores, weights, areas, ratios.
 */
export function float(n, digits = FLOAT_PRECISION) {
  return grouped(n, 0, digits)
}

/** `float()` with a '%' — `12.5` -> '12.5%'. */
export function percent(n, digits = FLOAT_PRECISION) {
  return `${float(n, digits)}%`
}

/** A count: digit-grouped, never any decimals. `1234` -> '1,234'. */
export function integer(n) {
  return grouped(n, 0, 0)
}

/**
 * Format by Frappe fieldtype, which is how every meta-driven screen should
 * pick its precision — `Currency` -> 4dp money, `Float`/`Percent` -> 6dp,
 * `Int` -> a plain count. Returns a bare number (no currency glyph) so a
 * caller that prefixes its own currency code stays in control; `Currency`
 * callers that want the glyph should use `money()`.
 */
export function numberByFieldtype(value, fieldtype) {
  if (fieldtype === 'Currency') return decimal(value)
  if (fieldtype === 'Percent') return percent(value)
  if (fieldtype === 'Float') return float(value)
  if (fieldtype === 'Int') return integer(value)
  return String(value)
}

/**
 * `money(1234.5)` -> '₹1,234.50'; `money(1234.5, 'USD')` -> 'USD 1,234.50'.
 *
 * Only INR gets the ₹ glyph — every other ISO code is prefixed as-is, so a
 * native-currency amount (a quotation priced in USD, the CIF leg in the
 * freight master's own currency) never reads as rupees. An empty/unknown
 * currency falls back to INR, which is what every caller before this
 * argument existed was assuming anyway.
 */
export function money(n, currency = 'INR') {
  const code = String(currency || 'INR').toUpperCase()
  return code === 'INR' ? `₹${decimal(n)}` : `${code} ${decimal(n)}`
}

/**
 * '46200000' -> '₹4.62 Cr', '850000' -> '₹8.50 L' — Indian-numbering compact
 * form for dashboard tiles, where `money()`'s full decimal runs too wide.
 *
 * Deliberately stays at 2dp of a crore/lakh: this is a headline tile, and a
 * fourth decimal of a crore is ₹100 of noise nobody reads off a dashboard.
 * The precise figure is one click away on the list and the worksheet.
 */
export function moneyCompact(n) {
  const value = Number(n) || 0
  const abs = Math.abs(value)
  if (abs >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `₹${(value / 1e5).toFixed(2)} L`
  return money(value)
}

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigitsInWords(n) {
  if (n < 20) return ONES[n]
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return ones ? `${TENS[tens]} ${ONES[ones]}` : TENS[tens]
}

function threeDigitsInWords(n) {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (!hundreds) return twoDigitsInWords(rest)
  return rest ? `${ONES[hundreds]} Hundred and ${twoDigitsInWords(rest)}` : `${ONES[hundreds]} Hundred`
}

/** Indian-numbering (lakh/crore) integer -> words, e.g. 2350600 -> 'Twenty
 *  Three Lakh, Fifty Thousand, Six Hundred'. */
function integerInWords(value) {
  let n = Math.floor(value)
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 1e7)
  n %= 1e7
  const lakh = Math.floor(n / 1e5)
  n %= 1e5
  const thousand = Math.floor(n / 1e3)
  n %= 1e3
  const hundred = n

  const parts = []
  if (crore) parts.push(`${crore < 100 ? twoDigitsInWords(crore) : integerInWords(crore)} Crore`)
  if (lakh) parts.push(`${twoDigitsInWords(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigitsInWords(thousand)} Thousand`)
  if (hundred) parts.push(threeDigitsInWords(hundred))
  return parts.join(', ')
}

/**
 * '23600' -> 'INR Twenty Three Thousand, Six Hundred only.' — client-side
 * approximation of Frappe's own `money_in_words` (Indian numbering, whole
 * rupees only shown unless there's a paise remainder), for previewing a
 * quotation total before a real doc exists server-side to compute it.
 */
export function moneyInWords(amount, currency = 'INR') {
  const value = Math.max(0, Number(amount) || 0)
  const rupees = Math.floor(value)
  const paise = Math.round((value - rupees) * 100)

  if (rupees === 0 && paise === 0) return `${currency} Zero only.`

  const parts = []
  if (rupees > 0) parts.push(`${currency} ${integerInWords(rupees)}`)
  if (paise > 0) {
    const paiseWords = `${integerInWords(paise)} Paisa`
    parts.push(rupees > 0 ? `and ${paiseWords}` : `${currency} ${paiseWords}`)
  }
  return `${parts.join(' ')} only.`
}

/** '2026-07-22' -> '22 Jul 2026' */
export function formatDate(value) {
  const parts = String(value).split('-')
  if (parts.length !== 3) return value
  return `${parts[2]} ${MONTHS[parseInt(parts[1], 10) - 1]} ${parts[0]}`
}

/**
 * '2026-07-31 09:12:00' -> '3h ago'.
 *
 * Frappe sends naive local datetimes with a space separator, which Safari
 * refuses to parse — swap in the 'T' before handing it to Date.
 */
export function timeAgo(value, now = Date.now()) {
  if (!value) return ''
  const parsed = new Date(String(value).replace(' ', 'T'))
  const then = parsed.getTime()
  if (Number.isNaN(then)) return ''

  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d ago`
  return formatDate(String(value).slice(0, 10))
}
