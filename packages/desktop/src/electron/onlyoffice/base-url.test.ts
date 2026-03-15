import { describe, expect, test } from "bun:test"
import { resolveEditorBaseUrl } from "./base-url"

describe("resolveEditorBaseUrl", () => {
  test("uses manual callback URLs for remote document servers", async () => {
    const result = await resolveEditorBaseUrl(
      {
        callbackBaseUrl: "https://callback.example.com",
        documentServerUrl: "https://docs.example.com",
        localPort: 31339,
        autoTunnelEnabled: true,
      },
      {
        ensureTunnelReady: async () => ({ baseUrl: "https://ignored.example.com" }),
      },
    )

    expect(result).toEqual({
      ok: true,
      baseUrl: "https://callback.example.com",
      mode: "manual",
      docHost: "docs.example.com",
    })
  })

  test("uses the local ingress server for local document servers", async () => {
    const result = await resolveEditorBaseUrl(
      {
        callbackBaseUrl: "",
        documentServerUrl: "http://127.0.0.1:8080",
        localPort: 31339,
        autoTunnelEnabled: true,
      },
      {
        ensureTunnelReady: async () => ({ baseUrl: "https://ignored.example.com" }),
      },
    )

    expect(result).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:31339",
      mode: "local",
      docHost: "127.0.0.1",
    })
  })

  test("requires a callback URL or tunnel for remote document servers", async () => {
    const result = await resolveEditorBaseUrl(
      {
        callbackBaseUrl: "",
        documentServerUrl: "https://docs.example.com",
        localPort: 31339,
        autoTunnelEnabled: false,
      },
      {
        ensureTunnelReady: async () => ({ baseUrl: "https://ignored.example.com" }),
      },
    )

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "EDITOR_CALLBACK_REQUIRED",
    })
  })

  test("falls back to an auto tunnel for remote document servers", async () => {
    const result = await resolveEditorBaseUrl(
      {
        callbackBaseUrl: "",
        documentServerUrl: "https://docs.example.com",
        localPort: 31339,
        autoTunnelEnabled: true,
      },
      {
        ensureTunnelReady: async () => ({ baseUrl: "https://tunnel.example.com/" }),
      },
    )

    expect(result).toEqual({
      ok: true,
      baseUrl: "https://tunnel.example.com",
      mode: "auto-tunnel",
      docHost: "docs.example.com",
    })
  })
})
