/**
 * @deprecated The color schemes now live in `color_schemes/*.json` and are
 * registered by `color_schemes/index.ts`. This module keeps the historical
 * `theme.ts` import path working as a thin re-export.
 */
export {
  schemeList,
  schemeMap,
  getSchemeMeta,
  resolveSchemeId,
  buildThemeDefinitions,
  DEFAULT_SCHEME_ID
} from '../color_schemes'
