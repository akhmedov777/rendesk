const CALLBACK_PROBE_TIMEOUT_MS = 8_000
const DOWNLOAD_PROBE_TIMEOUT_MS = 12_000

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type EndpointProbeResult =
  | {
      ok: true
    }
  | {
      ok: false
      error: string
    }

function getFetcher(fetcher?: FetchLike) {
  return fetcher ?? fetch
}

function normalizeContentType(value: string | null) {
  return (value ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase()
}

export async function probeCallbackEndpoint(baseUrl: string, fetcher?: FetchLike): Promise<EndpointProbeResult> {
  try {
    const response = await getFetcher(fetcher)(`${baseUrl.replace(/\/+$/, "")}/api/editor/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: 1 }),
      signal: AbortSignal.timeout(CALLBACK_PROBE_TIMEOUT_MS),
    })

    if (!response.ok) {
      return { ok: false, error: `Callback probe failed with HTTP ${response.status}` }
    }

    const payload = await response.json().catch(() => null)
    if (!payload || (payload as { error?: unknown }).error !== 0) {
      return { ok: false, error: "Callback probe returned an unexpected response body." }
    }

    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function probeDownloadEndpoint(
  url: string,
  expectedMimeType: string,
  fetcher?: FetchLike,
): Promise<EndpointProbeResult> {
  try {
    const response = await getFetcher(fetcher)(url, {
      headers: {
        range: "bytes=0-0",
      },
      signal: AbortSignal.timeout(DOWNLOAD_PROBE_TIMEOUT_MS),
    })

    if (![200, 206].includes(response.status)) {
      return { ok: false, error: `Download probe failed with HTTP ${response.status}` }
    }

    const contentType = normalizeContentType(response.headers.get("content-type"))
    if (contentType === "text/html") {
      return { ok: false, error: "Download probe returned HTML instead of the requested document." }
    }

    if (
      contentType &&
      expectedMimeType &&
      contentType !== "application/octet-stream" &&
      contentType !== normalizeContentType(expectedMimeType)
    ) {
      return {
        ok: false,
        error: `Download probe returned unexpected content type ${contentType}.`,
      }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 && response.status !== 200) {
      return { ok: false, error: "Download probe returned no document bytes." }
    }

    const prefix = bytes.toString("utf8", 0, Math.min(bytes.length, 48)).trim().toLowerCase()
    if (prefix.startsWith("<!doctype") || prefix.startsWith("<html")) {
      return { ok: false, error: "Download probe returned an HTML page instead of the requested document." }
    }

    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
