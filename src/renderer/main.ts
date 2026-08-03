import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import App from './App.vue'
import { dark, pureblack } from './styles/theme'

const vuetify = createVuetify({
  theme: {
    defaultTheme: 'dark',
    themes: { dark, pureblack }
  },
  defaults: {
    global: {
      density: 'compact'
    },
    VCard: { rounded: 'lg' },
    VDialog: { rounded: 'lg' }
  }
})

createApp(App).use(vuetify).mount('#app')
