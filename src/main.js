import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
// SDK styles first so this app's global rules in main.css win where the two
// collide — the form then picks up the app's Inter font and orange focus ring
// instead of the SDK's defaults.
import '@frappe-vue-sdk/vue/dist/style.css'
import './assets/main.css'
// Retunes the SDK's custom properties to this app's design language. Must come
// after both of the above.
import './assets/frappe-form.css'

createApp(App).use(createPinia()).use(router).mount('#app')
