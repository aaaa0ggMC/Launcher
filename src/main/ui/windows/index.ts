/**
 * Child-window view registry — every `.vue` in this folder is a possible root
 * for a managed child window. The main process passes `?view=<key>` and the
 * renderer mounts the matching component here (never an arbitrary path).
 *
 * Keys are compile-time glob names, e.g. `./LyricsWindow.vue` ↔ `view: 'LyricsWindow'`.
 */
export const windowViews = import.meta.glob('./*.vue')
