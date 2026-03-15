export const APP_NAME = "Rendesk"

export function displayProviderName(id: string, fallback: string) {
  if (id === "opencode") return APP_NAME
  if (id === "opencode-go") return `${APP_NAME} Go`
  return fallback
}
