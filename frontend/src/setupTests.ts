import '@testing-library/jest-dom/vitest'
import { en } from './i18n/en'
import { registerEnglishCatalog } from './i18n/LocaleContext'

registerEnglishCatalog(en)
