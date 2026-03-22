import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

export type PyodideExecuteResult = {
  success: boolean
  result?: string
  stdout: string
  stderr: string
  images: string[]
}

export type SendPyodideRequest = (code: string, options?: { globals?: Record<string, unknown> }) => Promise<PyodideExecuteResult>

export function createPyodideMcpServer(
  sendPyodideRequest: SendPyodideRequest,
  sendEditorToolRequest?: (toolName: string, toolInput: Record<string, unknown>) => Promise<string>,
) {
  return createSdkMcpServer({
    name: "pyodide",
    version: "1.0.0",
    tools: [
      tool(
        "execute_python",
        `Execute Python code using Pyodide (Python in WebAssembly). The environment has pandas, numpy, scipy, and matplotlib pre-loaded. Use this for data analysis, calculations, statistics, and generating charts/visualizations. Matplotlib figures are automatically captured as images. Print output with print() and it will be returned as stdout.`,
        {
          code: z.string().describe("Python code to execute"),
          description: z.string().optional().describe("Brief description of what this code does"),
          install_packages: z.array(z.string()).optional().describe("Additional packages to install via micropip before execution"),
        },
        async (args) => {
          try {
            // Install additional packages if requested
            let code = args.code
            if (args.install_packages && args.install_packages.length > 0) {
              const packageList = args.install_packages.map((p) => `"${p}"`).join(", ")
              code = `import micropip\nawait micropip.install([${packageList}])\n\n${code}`
            }

            const result = await sendPyodideRequest(code)

            const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []

            // Add stdout
            if (result.stdout) {
              content.push({ type: "text" as const, text: result.stdout })
            }

            // Add result value
            if (result.result && result.result !== "None" && result.result !== "undefined") {
              content.push({ type: "text" as const, text: result.result })
            }

            // Add stderr as text (warnings etc.)
            if (result.stderr && result.success) {
              content.push({ type: "text" as const, text: `Warnings:\n${result.stderr}` })
            }

            // Add images
            for (const imageData of result.images) {
              content.push({
                type: "image" as const,
                data: imageData,
                mimeType: "image/png",
              })
            }

            // If no content, provide a default message
            if (content.length === 0) {
              content.push({ type: "text" as const, text: "Code executed successfully (no output)" })
            }

            if (!result.success) {
              return {
                content: [{ type: "text" as const, text: `Error:\n${result.stderr || "Execution failed"}` }],
                isError: true,
              }
            }

            return { content }
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
            }
          }
        },
      ),

      tool(
        "python_load_spreadsheet",
        `Load data from the currently open spreadsheet into a pandas DataFrame for analysis. This reads cells from the active spreadsheet editor and makes them available as a pandas DataFrame variable in the Python environment. Use this before running execute_python to analyze spreadsheet data.`,
        {
          range: z.string().optional().describe("Cell range to read, e.g. 'A1:D100'. Omit to read the used range."),
          sheet_name: z.string().optional().describe("Sheet name to read from. Defaults to active sheet."),
          variable_name: z.string().optional().describe("Python variable name for the DataFrame. Defaults to 'df'."),
        },
        async (args) => {
          if (!sendEditorToolRequest) {
            return {
              content: [{ type: "text" as const, text: "Error: Editor integration is not available" }],
              isError: true,
            }
          }

          try {
            const readArgs: Record<string, unknown> = {}
            if (args.range) readArgs.range = args.range
            if (args.sheet_name) readArgs.sheet_name = args.sheet_name

            // If no range specified, read a large default range
            if (!args.range) {
              readArgs.range = "A1:Z1000"
            }

            const cellData = await sendEditorToolRequest("editor_read_cells", readArgs)
            const variableName = args.variable_name || "df"

            // Parse the cell data and inject into Pyodide as a DataFrame
            const code = `
import pandas as pd
import json

_raw_data = json.loads('''${cellData.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}''')

if isinstance(_raw_data, dict) and 'data' in _raw_data:
    _cells = _raw_data['data']
elif isinstance(_raw_data, dict) and 'cells' in _raw_data:
    _cells = _raw_data['cells']
elif isinstance(_raw_data, list):
    _cells = _raw_data
else:
    _cells = []

if len(_cells) > 0:
    # First row as headers if it looks like headers
    _headers = [str(c) for c in _cells[0]]
    _data = _cells[1:] if len(_cells) > 1 else []
    ${variableName} = pd.DataFrame(_data, columns=_headers)
else:
    ${variableName} = pd.DataFrame()

# Clean up: drop fully empty rows and columns
${variableName} = ${variableName}.dropna(how='all').dropna(axis=1, how='all')

print(f"Loaded DataFrame '{variableName}': {${variableName}.shape[0]} rows × {${variableName}.shape[1]} columns")
print()
print(${variableName}.head(10).to_string())
`

            const result = await sendPyodideRequest(code)

            if (!result.success) {
              return {
                content: [{ type: "text" as const, text: `Error loading spreadsheet data:\n${result.stderr}` }],
                isError: true,
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: result.stdout || `DataFrame '${variableName}' loaded successfully.`,
                },
              ],
            }
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
}
