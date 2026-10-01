import { definePrivacyScopes } from '../../main/process/privacy'

export const P = definePrivacyScopes('toolbox', {
  content: {
    level: 'sensitive',
    label: 'toolbox.privacy.content',
    description: 'toolbox.privacy.contentDescription'
  }
})
