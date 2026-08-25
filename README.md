# Hitech Costing UI

Standalone Vue 3 console for the `hitech_costing` Frappe app (tank & radiator
costing worksheets, masters and settings), built on **`@frappe-vue-sdk/vue`** —
the same generic Frappe-form/list SDK and app shell as `freight-lcs-vue`. Lives
outside the bench, in `workspace/`.

## Stack

Vue 3, Vue Router, Pinia, [`@frappe-vue-sdk/vue`](../frappe-vue-sdk) (consumed
from the local monorepo checkout — see below), lucide-vue-next.

## Setup

```
pnpm install
cp .env.example .env.local   # adjust VITE_FRAPPE_URL if needed
pnpm dev
```

Assumes `frappe-bench-v16` is running (`bench start`) with the `hitech.localhost`
site (webserver on `:8001`). The dev server proxies `/api`, `/files`,
`/private`, `/assets` and `/printview` to that bench, forcing the `Host` header
to `hitech.localhost` so Frappe's multi-tenant router resolves the right site
and its session cookie/CSRF token work with no CORS setup.

Open the URL Vite prints (defaults to `:8094`, picks the next free port if taken).

### The SDK is consumed from a local sibling checkout

`package.json` points `@frappe-vue-sdk/vue` at
`link:../frappe-vue-sdk/packages/vue` — the same package `freight-lcs-vue`
installs from `git+https://github.com/aniketdvnks/frappe-vue-sdk.git`, but
resolved locally instead of over a private git URL (no credentials needed).
`pnpm install` symlinks it in; Node's module resolution then finds its own
`@frappe-vue-sdk/frm-core` / `runtime-core` dependencies inside
`../frappe-vue-sdk/packages/vue/node_modules` by walking up from the real
(symlinked-to) path, so nothing else needs linking by hand. If `frappe-vue-sdk`
moves or this app is deployed elsewhere, switch that line to the git dependency
freight-lcs-vue uses instead.

## Backend: `custom_ui`

The sidebar, and any per-DocType list/form layout override, is served by the
`custom_ui` Frappe app (`custom_ui.api.get_sidebar` / `get_layout_map` /
`get_list_layout` / ...) — installed on `hitech.localhost` for this app.
Nothing is mapped in `Custom UI Doctype Layout` / `Custom UI List Layout` yet,
so every DocType falls back to the generic meta-driven list and form (this is
by design in the SDK's own fallback path, not a gap). Only
`Custom UI Sidebar Item` records exist, under a `Main` group:

- **Home** (`/`)
- **Costing Worksheets** (`/ui/Costing Worksheet`) + **New Worksheet**
- **Masters** group: Tank Type, Costing Department, Material Rate, Paint Make,
  Paint System Rate, Order Complexity Question
- **Costing Settings** (`/form/Costing Settings/Costing Settings`)

Add a bespoke list/form template for a DocType by writing the component under
`src/views` or `src/components`, registering it in `src/lib/layouts.js`, and
pointing a `Custom UI Doctype Layout` record at it — same mechanism
freight-lcs-vue uses for its Jobs/Quotes/Leads screens.

## What's generic vs. what's hitech-specific

Almost everything under `src/lib`, `src/components` and the SDK-backed views
(`DocListView`, `DocListHost`, `DocFormView`, `LoginView`, `ProfileView`) is
carried over from `freight-lcs-vue` unchanged or near-unchanged — it renders
**any** DocType generically off its Frappe meta (sections, tabs, Client
Scripts, child-table drawers, connections, activity/comments, print, global
search, notifications). The hitech-specific pieces are:

- `src/lib/home.js` — dashboard KPIs and the status pipeline, built from
  `Costing Worksheet` instead of freight's Jobs/Quotes.
- `src/views/HomeView.vue`, `src/views/MastersView.vue` — the dashboard and the
  masters hub, wired to hitech's doctypes.
- `src/router/routes.js` — home / masters / login / profile / generic
  doc-list / doc-form, no Jobs/Quotes/Leads/Finance/Payments/Portal routes.
- `src/stores/app.js` — trimmed to branding + notifications + sidebar-open
  state (freight's job/quote/portal state dropped).
- Branding text in `LoginView.vue` / `AppSidebar.vue` and the accent copy in
  `utils/styles.js` (`worksheetStatusStyle` replaces the Job/Quote status maps).

Client Scripts already on `Costing Worksheet` / `Tank Type` etc. in the
`hitech_costing` app run for real here (see `src/lib/clientScripts.js`) — the
SDK renders forms, this app loads their native JS the way the Frappe desk does.

## Costing figures are placeholder data

Every rate, band and multiplier behind these worksheets is seed data pending
the real workbook (see `hitech_costing`'s `docs/cost-model.md`). The dashboard
and worksheet screens show whatever is in the DocType — treat computed margins
as illustrative, not a real quote, until that's replaced.

## Build

```
pnpm build
```

Outputs to `dist/`, with the app's own bundles under `dist/app/` rather than
`dist/assets/` — that path is reserved for Frappe's own static assets when this
is deployed behind a proxy that forwards `/assets/**` to the bench (see
`vite.config.js`).
