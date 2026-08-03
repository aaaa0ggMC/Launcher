import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import './styles/global.css'
import App from './App.vue'
import { dark, pureblack } from './styles/theme'

const vuetify = createVuetify({
  components,
  directives,
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
