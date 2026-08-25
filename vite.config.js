import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// Paths that belong to the Frappe backend rather than this app. Proxying them
// in dev keeps the browser on one origin, so Frappe's session cookie and CSRF
// token work without any CORS configuration on the server.
//
// `/printview` is Frappe's own print page, which src/lib/print.js loads to print
// a document with its default print format. It has to be same-origin: the app
// reads the response to check permissions before printing, and the page's
// stylesheet and letterhead URLs are root-relative.
const BACKEND_PATHS = ['/api', '/files', '/private', '/assets', '/printview']

/**
 * Build the proxy entry for one backend path.
 *
 * Bench sites are usually named `<site>.localhost`. curl and browsers resolve
 * those, but Node's getaddrinfo does not unless they're in /etc/hosts — the
 * proxy would die with ENOTFOUND. So for `.localhost` hosts we dial the
 * loopback address directly and pass the real site name through as the Host
 * header, which is what Frappe uses to pick the site. No /etc/hosts edit needed.
 */
function backendProxy(target) {
  const url = new URL(target)
  const isBenchLocalhost = url.hostname.endsWith('.localhost')

  return {
    target: isBenchLocalhost ? `${url.protocol}//127.0.0.1:${url.port || '80'}` : target,
    // changeOrigin would overwrite Host with the proxy target (127.0.0.1) and
    // Frappe would fail to resolve the site — so set Host explicitly instead.
    changeOrigin: !isBenchLocalhost,
    headers: isBenchLocalhost ? { Host: url.host } : undefined,
    // Let the Frappe `sid` cookie stick on localhost.
    cookieDomainRewrite: ''
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_FRAPPE_URL

  return {
    plugins: [vue()],
    build: {
      // Not the default `assets`: that path belongs to Frappe. A deployment
      // that proxies the backend has to forward `/assets/**` for the print
      // view's stylesheets and letterhead images, which would then shadow this
      // app's own bundles and leave a blank page. Ours live under `/app`.
      assetsDir: 'app'
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      // @frappe-vue-sdk/vue declares vue as a peer dependency. Without this, a
      // hoisting quirk can give the SDK its own Vue copy — two reactivity
      // systems, and the form silently stops updating.
      dedupe: ['vue']
    },
    server: {
      port: 8094,
      proxy: target
        ? Object.fromEntries(BACKEND_PATHS.map((path) => [path, backendProxy(target)]))
        : undefined
    }
  }
})
