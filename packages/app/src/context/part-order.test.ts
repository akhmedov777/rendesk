import { describe, expect, test } from "bun:test"
import type { Part } from "@rendesk/sdk/v2/client"
import { sortMessageParts } from "./part-order"

const textPart = (id: string, start?: number): Part => ({
  id,
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "text",
  text: id,
  time: start === undefined ? undefined : { start },
})

const toolPart = (id: string, start?: number): Part => ({
  id,
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "tool",
  tool: "bash",
  callID: `${id}_call`,
  state:
    start === undefined
      ? {
          status: "pending",
          input: {},
          raw: "",
        }
      : {
          status: "completed",
          input: {},
          output: "",
          title: id,
          metadata: {},
          time: {
            start,
            end: start + 1,
          },
        },
})

describe("sortMessageParts", () => {
  test("uses execution start time when available", () => {
    const result = sortMessageParts([textPart("a_text", 20), toolPart("z_tool", 10)])
    expect(result.map((part) => part.id)).toEqual(["z_tool", "a_text"])
  })

  test("falls back to part priority when timing is missing", () => {
    const result = sortMessageParts([textPart("a_text"), toolPart("z_tool")])
    expect(result.map((part) => part.id)).toEqual(["z_tool", "a_text"])
  })
})
