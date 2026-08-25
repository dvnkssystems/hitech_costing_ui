const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function decimal(n) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

export function money(n) {
  return `₹${decimal(n)}`
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
