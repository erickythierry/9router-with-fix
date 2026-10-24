import { describe, it, expect } from "vitest";
import { parseDeepSeekToolCalls } from "../../open-sse/translator/deepseekWebTools.js";
import { hasMalformedDeepSeekToolIntent } from "../../open-sse/translator/deepseekWebToolBinding.js";
import { getToolNonce } from "../../open-sse/translator/webTools.js";

const tools = [
  {
    type: "function",
    function: {
      name: "edit",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: { type: "array", items: { type: "object" } },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
        required: ["command"],
      },
    },
  },
];
const nonce = getToolNonce(tools);
const D = "｜｜DSML｜｜";
const dsml = (name, params) =>
  `<${D} calls>\n<${D} invoke name="${name}">\n` +
  params
    .map(([k, v, s]) => `<${D} parameter name="${k}" string="${s}">${v}</${D} parameter>`)
    .join("\n") +
  `\n</${D} invoke>\n</${D} calls>`;

describe("deepseek-web tool parsing", () => {
  it("accepts a raw newline inside a <tool> JSON string", () => {
    const text = `<tool>{"name":"edit","arguments":{"path":"a.js","edits":[{"oldText":"a\nb"}]},"_nonce":"${nonce}"}</tool>`;
    const p = parseDeepSeekToolCalls(text, "c", tools);
    expect(p.toolCalls).toHaveLength(1);
    expect(JSON.parse(p.toolCalls[0].function.arguments).edits[0].oldText).toBe("a\nb");
    expect(hasMalformedDeepSeekToolIntent(p.content, tools)).toBe(false);
  });

  it("decodes DSML array and number parameters by schema", () => {
    const text = dsml("edit", [
      ["path", "a.js", "true"],
      ["edits", '[{"oldText":"a","newText":"b"}]', "false"],
      ["_nonce", nonce, "true"],
    ]);
    const p = parseDeepSeekToolCalls(text, "c", tools);
    expect(JSON.parse(p.toolCalls[0].function.arguments).edits).toHaveLength(1);

    const t2 = dsml("bash", [
      ["command", "ls", "true"],
      ["timeout", "30", "true"],
      ["_nonce", nonce, "true"],
    ]);
    const p2 = parseDeepSeekToolCalls(t2, "c", tools);
    expect(JSON.parse(p2.toolCalls[0].function.arguments).timeout).toBe(30);
  });

  it("repairs a DSML _nonce parameter written as name=\"_nonce\": \"value\" without '>'", () => {
    const bad = (cmd) =>
      `<${D} invoke name="bash">\n<${D} parameter name="command" string="true">${cmd}</${D} parameter>\n` +
      `<${D} parameter name="_nonce": "${nonce}"</${D} parameter>\n</${D} invoke>`;
    const text = `<${D} calls>\n${bad("ls -la")}\n${bad("pwd")}\n</${D} calls>`;
    const p = parseDeepSeekToolCalls(text, "c", tools);
    expect(p.toolCalls.map((c) => JSON.parse(c.function.arguments).command)).toEqual(["ls -la", "pwd"]);
    expect(hasMalformedDeepSeekToolIntent(p.content, tools)).toBe(false);
  });
});
