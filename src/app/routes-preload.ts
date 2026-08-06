/**
 * The two route chunks, and a way to start fetching one before it is needed.
 *
 * `lazy()` only begins the download when the route renders, which puts a network round trip between
 * the click and the screen. Pointing at a control that leads somewhere is a reliable signal that the
 * user is about to go there, so the same `import()` runs on hover and focus. Repeat calls are free:
 * a dynamic import resolves from the module cache after the first one.
 */
export const preloadSettingsPage = () => import('../components/settings/SettingsPage')
export const preloadWorkspace = () => import('../components/workspace/Workspace')
