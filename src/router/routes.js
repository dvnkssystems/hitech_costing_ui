import HomeView from '@/views/HomeView.vue'

// Lazy on purpose: every one of these pulls in @frappe-vue-sdk/vue, which is
// tens of kB gzipped. Statically importing any of them drags the whole SDK
// into the entry chunk and slows down every screen that doesn't render a form.
const DocFormView = () => import('@/views/DocFormView.vue')
const ProfileView = () => import('@/views/ProfileView.vue')
// Resolves the mapped list template, falling back to DocListView.
const DocListHost = () => import('@/views/DocListHost.vue')
const LoginView = () => import('@/views/LoginView.vue')
const MastersView = () => import('@/views/MastersView.vue')
const CostingWorksheetWizard = () => import('@/views/CostingWorksheetWizard.vue')
const QuotationNewView = () => import('@/views/QuotationNewView.vue')

// `meta.nav` drives the sidebar highlight. `meta.chrome: false` opts a route
// out of the staff shell entirely.
export const routes = [
  { path: '/', name: 'home', component: HomeView, meta: { nav: 'home' } },
  { path: '/masters', name: 'masters', component: MastersView, meta: { nav: 'masters' } },
  { path: '/login', name: 'login', component: LoginView, meta: { nav: 'login', chrome: false, public: true } },
  { path: '/profile', name: 'profile', component: ProfileView, meta: { nav: 'profile' } },
  // SDK-rendered Frappe forms. Generic on purpose: any DocType the backend
  // exposes renders here without a bespoke screen. Omit :name for a new doc.
  // Generic list for any DocType; query params become field filters.
  // `/ui/:doctype` is the route `Custom UI Sidebar Item` derives for a Link
  // entry. Aliased rather than replaced so existing /list links keep working.
  {
    path: '/list/:doctype',
    alias: '/ui/:doctype',
    name: 'doc-list',
    component: DocListHost,
    props: true,
    meta: { nav: 'form' }
  },
  {
    path: '/form/:doctype/:name?',
    name: 'doc-form',
    component: DocFormView,
    props: true,
    meta: { nav: 'form' }
  },
  // Phone-setup-style step wizard for authoring a Costing Worksheet, as an
  // alternative front door to the generic /form/Costing Worksheet page.
  {
    path: '/wizard/costing-worksheet/:name?',
    name: 'costing-worksheet-wizard',
    component: CostingWorksheetWizard,
    props: true,
    meta: { nav: 'form' }
  },
  // "What kind of quotation?" — sits in front of the wizard above. Its own
  // route rather than a step of the wizard, since it's the one screen a doc
  // name can never apply to.
  {
    path: '/quotation/new',
    name: 'quotation-new',
    component: QuotationNewView,
    meta: { nav: 'form' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]
