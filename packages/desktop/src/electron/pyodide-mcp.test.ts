import { describe, test, expect, mock } from "bun:test"
import { createPyodideMcpServer, type SendPyodideRequest } from "./pyodide-mcp"

describe("createPyodideMcpServer", () => {
  const mockSendPyodide: SendPyodideRequest = mock(async (code: string) => ({
    success: true,
    result: "42",
    stdout: "hello world",
    stderr: "",
    images: [],
  })) as unknown as SendPyodideRequest

  const mockSendEditor = mock(async (_toolName: string, _toolInput: Record<string, unknown>) => {
    return JSON.stringify({ data: [["Name", "Value"], ["Alice", "10"], ["Bob", "20"]] })
  }) as unknown as (toolName: string, toolInput: Record<string, unknown>) => Promise<string>

  test("creates server with correct name and tools", () => {
    const server = createPyodideMcpServer(mockSendPyodide) as any
    expect(server).toBeDefined()
  })

  test("execute_python returns text content on success", async () => {
    const sendPyodide: SendPyodideRequest = async () => ({
      success: true,
      result: "42",
      stdout: "computed result",
      stderr: "",
      images: [],
    })

    const server = createPyodideMcpServer(sendPyodide) as any
    const executeTool = server.instance._registeredTools["execute_python"]
    expect(executeTool).toBeDefined()

    const result = await executeTool.handler({ code: "print(42)" }, {})
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content.some((c: { type: string; text: string }) => c.type === "text" && c.text.includes("computed result"))).toBe(true)
    expect(result.isError).toBeUndefined()
  })

  test("execute_python returns error on failure", async () => {
    const sendPyodide: SendPyodideRequest = async () => ({
      success: false,
      stdout: "",
      stderr: "NameError: name 'x' is not defined",
      images: [],
    })

    const server = createPyodideMcpServer(sendPyodide) as any
    const executeTool = server.instance._registeredTools["execute_python"]
    const result = await executeTool.handler({ code: "print(x)" }, {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("NameError")
  })

  test("execute_python returns images when present", async () => {
    const sendPyodide: SendPyodideRequest = async () => ({
      success: true,
      stdout: "",
      stderr: "",
      images: ["iVBORw0KGgoAAAANS"],
    })

    const server = createPyodideMcpServer(sendPyodide) as any
    const executeTool = server.instance._registeredTools["execute_python"]
    const result = await executeTool.handler({ code: "import matplotlib" }, {})

    expect(result.content.some((c: { type: string }) => c.type === "image")).toBe(true)
  })

  test("python_load_spreadsheet reads cells and loads into pyodide", async () => {
    const pyodideCalls: string[] = []
    const sendPyodide: SendPyodideRequest = async (code) => {
      pyodideCalls.push(code)
      return {
        success: true,
        stdout: "Loaded DataFrame 'df': 2 rows × 2 columns",
        stderr: "",
        images: [],
      }
    }

    const server = createPyodideMcpServer(sendPyodide, mockSendEditor) as any
    const loadTool = server.instance._registeredTools["python_load_spreadsheet"]
    expect(loadTool).toBeDefined()

    const result = await loadTool.handler({ range: "A1:B3" }, {})
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain("Loaded DataFrame")
    expect(pyodideCalls.length).toBe(1)
    expect(pyodideCalls[0]).toContain("pandas")
  })

  test("python_load_spreadsheet errors when no editor available", async () => {
    const server = createPyodideMcpServer(mockSendPyodide) as any
    const loadTool = server.instance._registeredTools["python_load_spreadsheet"]
    const result = await loadTool.handler({}, {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Editor integration is not available")
  })
})
