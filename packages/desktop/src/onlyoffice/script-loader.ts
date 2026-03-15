const pendingScripts = new Map<string, Promise<void>>()

function normalizeDocServerUrl(docServerUrl: string) {
  return docServerUrl.trim().replace(/\/+$/, "")
}

export function getOnlyOfficeApiScriptUrl(docServerUrl: string) {
  return `${normalizeDocServerUrl(docServerUrl)}/web-apps/apps/api/documents/api.js`
}

function ensureLink(rel: string, href: string) {
  const selector = `link[rel="${rel}"][href="${href}"]`
  if (document.head.querySelector(selector)) return

  const link = document.createElement("link")
  link.rel = rel
  link.href = href
  document.head.appendChild(link)
}

function preconnect(docServerUrl: string) {
  const normalized = normalizeDocServerUrl(docServerUrl)
  if (!normalized) return

  try {
    const { origin, hostname } = new URL(normalized)
    ensureLink("preconnect", origin)
    ensureLink("dns-prefetch", `//${hostname}`)
  } catch {
    return
  }
}

export function ensureOnlyOfficeApiScript(docServerUrl: string): Promise<void> {
  const scriptUrl = getOnlyOfficeApiScriptUrl(docServerUrl)
  const existing = pendingScripts.get(scriptUrl)
  if (existing) return existing

  preconnect(docServerUrl)

  const promise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${scriptUrl}"]`) as HTMLScriptElement | null
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve()
        return
      }
      existingScript.addEventListener("load", () => resolve(), { once: true })
      existingScript.addEventListener("error", () => reject(new Error("Failed to load OnlyOffice API script")), {
        once: true,
      })
      return
    }

    const script = document.createElement("script")
    script.src = scriptUrl
    script.async = true
    script.onload = () => {
      script.dataset.loaded = "true"
      resolve()
    }
    script.onerror = () => reject(new Error("Failed to load OnlyOffice API script"))
    document.head.appendChild(script)
  }).catch((error) => {
    pendingScripts.delete(scriptUrl)
    throw error
  })

  pendingScripts.set(scriptUrl, promise)
  return promise
}

export function preloadOnlyOfficeApiScript(docServerUrl: string) {
  const normalized = normalizeDocServerUrl(docServerUrl)
  if (!normalized || typeof window === "undefined") return

  preconnect(normalized)

  const warm = () => {
    void ensureOnlyOfficeApiScript(normalized).catch(() => undefined)
  }

  if ("requestIdleCallback" in globalThis) {
    globalThis.requestIdleCallback(warm, { timeout: 1500 })
    return
  }

  setTimeout(warm, 0)
}
