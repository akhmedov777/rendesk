export type ManagedDesktopConfig = {
  anthropicApiKey: string
}

const trim = (value: string | undefined) => value?.trim() ?? ""

export const readManagedDesktopConfig = (): ManagedDesktopConfig => ({
  anthropicApiKey: trim(process.env.ANTHROPIC_API_KEY),
})

export const missingManagedDesktopConfigKeys = (config = readManagedDesktopConfig()) => {
  const missing: string[] = []
  if (!config.anthropicApiKey) missing.push("ANTHROPIC_API_KEY")
  return missing
}

export const assertManagedDesktopConfig = (input: { packaged: boolean }) => {
  const config = readManagedDesktopConfig()
  const missing = missingManagedDesktopConfigKeys(config)
  if (input.packaged && missing.length > 0) {
    throw new Error(
      `Managed infrastructure keys are missing in packaged desktop runtime: ${missing.join(
        ", ",
      )}. This build must be produced with internal CI/package-time env injection.`,
    )
  }
  return config
}
