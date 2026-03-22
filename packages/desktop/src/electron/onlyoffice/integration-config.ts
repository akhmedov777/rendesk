// Minimal editor integration config for the x2t/offline approach.
// No Document Server URL or JWT needed — the editor runs locally.

export type EditorConfig = {
  enabled: boolean
}

export const defaultEditorConfig = (): EditorConfig => ({
  enabled: true,
})
