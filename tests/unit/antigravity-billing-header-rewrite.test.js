import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const HEADER = "x-anthropic-billing-header: cc_version=2.1.275.f15; cc_entrypoint=cli;";

function systemTextSentToAntigravity(systemContent) {
  // OpenAI-format client (e.g. a proxy converting Claude Code to /v1/chat/completions).
  const body = openaiToAntigravityRequest("gemini-3.8-flash-tiered", {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "hi" },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest("gemini-3.8-flash-tiered", body, true, {});
  expect(finalBody.request.systemInstruction).toBeUndefined();
  return finalBody.request.contents[0].parts.map((p) => p.text).join("\n");
}

describe("Antigravity strips the Claude Code billing header from system prompts", () => {
  it("removes the header line prepended by Claude Code", () => {
    const text = systemTextSentToAntigravity(`${HEADER}\n\nYou are Claude Code, Anthropic's official CLI for Claude.`);
    expect(text).not.toContain("x-anthropic-billing-header");
    expect(text).toContain("You are Antigravity, Anthropic's official CLI for Claude.");
  });

  it("removes the header when it is not the first line", () => {
    const text = systemTextSentToAntigravity(`Some preamble\n${HEADER}\nRest of prompt`);
    expect(text).not.toContain("x-anthropic-billing-header");
    expect(text).toContain("Some preamble");
    expect(text).toContain("Rest of prompt");
  });

  it("leaves prompts without the header untouched", () => {
    const text = systemTextSentToAntigravity("You are a helpful assistant.");
    expect(text).toContain("You are a helpful assistant.");
  });
});

describe("Antigravity moves the system prompt into the first user turn", () => {
  it("prepends system text to the first user message and drops systemInstruction", () => {
    const body = openaiToAntigravityRequest("gemini-3.1-flash-lite", {
      messages: [
        { role: "system", content: "SYS_RULES" },
        { role: "user", content: "hi" },
      ],
    }, true);
    const out = new AntigravityExecutor().transformRequest("gemini-3.1-flash-lite", body, true, {});
    expect(out.request.systemInstruction).toBeUndefined();
    expect(out.request.contents[0].role).toBe("user");
    expect(out.request.contents[0].parts.map((p) => p.text)).toEqual(["SYS_RULES", "hi"]);
  });
});
