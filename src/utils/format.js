const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function decimal(n) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  })
}

/**
 * `money(1234.5)` -> '₹1,234.5000'; `money(1234.5, 'USD')` -> 'USD 1,234.5000'.
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
