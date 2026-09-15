/**
 * Global search, backed by Frappe's own.
 *
 * The header search box is the desk awesomebar's equivalent, and it works the
 * way that one does: results come from `frappe.utils.global_search.search`,
 * which queries the `__global_search` full-text table rather than any single
 * DocType. So one query reaches every DocType enabled in Global Search Settings,
 * already filtered to what the signed-in user may read.
 *
 * Two things are layered on top, both mirroring the awesomebar:
 *
 *   - Page results. Typing "quote" should offer the Quotes screen, not only
 *     documents whose text happens to contain the word.
 *   - A name fallback. `__global_search` is a *built* index: a DocType absent
 *     from Global Search Settings, or a site whose index was never rebuilt,
 *     returns nothing at all. Searching this app's own DocTypes by name keeps a
 *     job or quote number findable regardless of index state — which matters,
 *     because typing a document number is the single most common search here.
 */

import { call } from './frappe'
import { db } from './frappeDb'
import { formRouteFor } from './frappeRouting'

/** In-app screens, searched locally. Mirrors the sidebar. */
const PAGES = [
  { label: 'Home', route: '/', icon: 'layout-dashboard', keywords: 'home dashboard overview' },
  { label: 'Costing Worksheets', route: '/ui/Costing Worksheet', icon: 'calculator', keywords: 'worksheet worksheets costing quote quotation' },
  { label: 'Masters', route: '/masters', icon: 'database', keywords: 'tank type material paint rate masters' },
  { label: 'Costing Settings', route: '/form/Costing Settings/Costing Settings', icon: 'settings', keywords: 'settings rates scrap bands complexity' },
  { label: 'Packing Settings', route: '/form/Packing Settings/Packing Settings', icon: 'package', keywords: 'packing settings gap pallet thickness container' },
  { label: 'Currency Exchange Rates', route: '/list/Currency Exchange Master', icon: 'coins', keywords: 'currency exchange rate master cif dap item quarter usd eur forex' },
  { label: 'International Freight Rates', route: '/list/International Freight Rate Master', icon: 'ship', keywords: 'international freight rate master sea air sector port container' },
  { label: 'Container Types', route: '/list/Container Type', icon: 'container', keywords: 'container type 20ft 40ft dimensions payload' },
  { label: 'Container Fit Plans', route: '/list/Container Fit Plan', icon: 'box', keywords: 'container fit plan packing tanks layers variance' },
  { label: 'Profile', route: '/profile', icon: 'user', keywords: 'profile account sign out logout' }
]

/**
 * DocTypes searched by name when the full-text index yields nothing.
 * Deliberately short — this is a safety net, not a second search engine.
 */
const NAME_FALLBACK_DOCTYPES = ['Costing Worksheet']

/** Frappe joins each indexed field into one string with this separator. */
const CONTENT_SEPARATOR = '|||'

/**
 * Turn the packed `content` column into a one-line description.
 *
 * Prefers the fragments that actually mention the search term — showing "Naming
 * Series: QT.YY..####" because it happened to be indexed first tells the user
 * nothing about why the row matched.
 */
function describe(content, term) {
  const parts = String(content ?? '')
    .split(CONTENT_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean)
  if (!parts.length) return ''

  const needle = term.toLowerCase()
  const matching = parts.filter((part) => part.toLowerCase().includes(needle))
  return (matching.length ? matching : parts).slice(0, 3).join(' · ')
}

function toResult({ doctype, name, title, content }, term) {
  return {
    // Doc names are unique per DocType, so this is stable for :key and for
    // keyboard navigation across a merged, grouped list.
    id: `${doctype}:${name}`,
    doctype,
    name,
    label: title && title !== name ? `${title} — ${name}` : name,
    description: describe(content, term),
    route: formRouteFor(doctype, name)
  }
}

/** Frappe's full-text global search. */
async function searchDocuments(term, limit) {
  const rows = await call('frappe.utils.global_search.search', { text: term, limit })
  return (Array.isArray(rows) ? rows : []).map((row) => toResult(row, term))
}

/**
 * Name-prefix search over this app's core DocTypes.
 *
 * `like %term%` rather than `term%`: job and quote numbers are prefixed by
 * series (`R-IM-T-26-07020`), so users routinely search the tail of a number.
 */
async function searchNames(term, limit) {
  const perDoctype = Math.max(1, Math.floor(limit / NAME_FALLBACK_DOCTYPES.length))
  const groups = await Promise.all(
    NAME_FALLBACK_DOCTYPES.map((doctype) =>
      db
        .get_list(doctype, {
          fields: ['name'],
          filters: [[doctype, 'name', 'like', `%${term}%`]],
          limit_page_length: perDoctype,
          order_by: 'modified desc'
        })
        // One DocType the user cannot read must not sink the whole search.
        .catch(() => [])
        .then((rows) =>
          (rows ?? []).map((row) => toResult({ doctype, name: row.name, content: '' }, term))
        )
    )
  )
  return groups.flat()
}

/** In-app screens whose label or keywords contain the term. */
export function searchPages(term) {
  const needle = term.toLowerCase()
  return PAGES.filter(
    (page) =>
      page.label.toLowerCase().includes(needle) || page.keywords.includes(needle)
  ).map((page) => ({ id: `page:${page.route}`, ...page, kind: 'page' }))
}

/**
 * Run a global search.
 *
 * Resolves to `{ pages, documents, indexEmpty }`. `indexEmpty` reports that the
 * full-text search found nothing but the name fallback did — the signal that
 * `__global_search` needs rebuilding on the bench, which is worth surfacing
 * rather than leaving as a mystery.
 *
 * Never rejects for a partial failure: pages are local and always available, so
 * a backend that is down still returns useful navigation.
 */
export async function globalSearch(term, { limit = 20 } = {}) {
  const text = String(term ?? '').trim()
  if (!text) return { pages: [], documents: [], indexEmpty: false }

  const pages = searchPages(text)

  let documents = []
  let error = null
  try {
    documents = await searchDocuments(text, limit)
  } catch (e) {
    error = e
  }

  let indexEmpty = false
  if (!documents.length) {
    const byName = await searchNames(text, limit).catch(() => [])
    // Only call the index empty if the fallback proves there was something to
    // find. A genuinely unmatched term is not an indexing problem.
    indexEmpty = !error && byName.length > 0
    documents = byName
  }

  if (error && !documents.length && !pages.length) throw error
  return { pages, documents, indexEmpty }
}

/** Group documents by DocType, preserving Frappe's relevance order. */
export function groupByDoctype(documents) {
  const groups = new Map()
  for (const doc of documents) {
    if (!groups.has(doc.doctype)) groups.set(doc.doctype, [])
    groups.get(doc.doctype).push(doc)
  }
  return [...groups.entries()].map(([doctype, items]) => ({ doctype, items }))
}
