const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function backendBase() {
  const value = process.env.FRAPPE_URL || process.env.VITE_FRAPPE_URL
  if (!value) return null
  return value.replace(/\/+$/, '')
}

function proxyPath(req) {
  const path = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path
  return path ? `/api/${path}` : '/api'
}

function targetUrl(req) {
  const base = backendBase()
  if (!base) return null

  const url = new URL(proxyPath(req), base)
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === 'path') continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item)
    } else if (value != null) {
      url.searchParams.set(key, value)
    }
  }
  return url
}

function requestHeaders(req) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
    if (lower.startsWith('x-forwarded-')) continue
    if (lower.startsWith('x-vercel-')) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

async function requestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body
    return JSON.stringify(req.body)
  }

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function responseHeaders(response, res) {
  for (const [key, value] of response.headers) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    if (key.toLowerCase() === 'set-cookie') continue
    res.setHeader(key, value)
  }

  const cookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie')]
        : []
  if (cookies.length) res.setHeader('set-cookie', cookies)

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Frappe-CSRF-Token, Authorization')
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Frappe-CSRF-Token, Authorization')
    res.statusCode = 200
    res.end()
    return
  }

  const url = targetUrl(req)
  if (!url) {
    res.statusCode = 500
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end('FRAPPE_URL or VITE_FRAPPE_URL is required.')
    return
  }

  const response = await fetch(url, {
    method: req.method,
    headers: requestHeaders(req),
    body: await requestBody(req),
    redirect: 'manual'
  })

  responseHeaders(response, res)
  res.statusCode = response.status
  res.end(Buffer.from(await response.arrayBuffer()))
}
