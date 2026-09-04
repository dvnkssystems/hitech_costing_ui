import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
// Brand tokens first — colors, fonts and radii every other stylesheet below
// builds on (see src/assets/brand.css for the Hi-Tech Radiators brandbook).
import './assets/brand.css'
// SDK styles next so this app's global rules in main.css win where the two
// collide — the form then picks up the app's Raleway font and navy focus ring
// instead of the SDK's defaults.
import '@frappe-vue-sdk/vue/style.css'
import './assets/main.css'
// Retunes the SDK's custom properties to this app's design language. Must come
// after both of the above.
import './assets/frappe-form.css'

createApp(App).use(createPinia()).use(router).mount('#app')
