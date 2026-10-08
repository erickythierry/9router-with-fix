import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { withClaudePing } = await import("../../open-sse/utils/streamHelpers.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");

const encoder = new TextEncoder();

function baseCtx(providerResponse, sourceFormat, targetFormat) {
  return {
    providerResponse,
    sourceFormat,
    targetFormat,
    provider: "test",
    model: "m",
    body: { model: "m", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "c",
    clientRawRequest: { endpoint: "/v1/messages" },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("Claude client, non-stream", () => {
  it("returns a Message for a Gemini-family upstream", async () => {
    const gemini = {
      response: {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "Read", args: { path: "a" } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
      }
    };
    const res = new Response(JSON.stringify(gemini), { headers: { "content-type": "application/json" } });
    const result = await handleNonStreamingResponse(baseCtx(res, FORMATS.CLAUDE, FORMATS.ANTIGRAVITY));
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json).not.toHaveProperty("choices");
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content[0]).toMatchObject({ type: "tool_use", name: "Read", input: { path: "a" } });
  });

  it("returns a Message on the forced-SSE path", async () => {
    const raw = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"delta":{"content":"oi"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const res = new Response(raw, { headers: { "content-type": "text/event-stream" } });
    const result = await handleForcedSSEToJson(baseCtx(res, FORMATS.CLAUDE, FORMATS.OPENAI));
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "oi" }]);
    expect(json.stop_reason).toBe("end_turn");
  });
});

describe("withClaudePing", () => {
  it("sends a ping up front and passes chunks through", async () => {
    const src = new ReadableStream({
      start(c) { c.enqueue(encoder.encode("event: message_stop\n\n")); c.close(); }
    });
    const text = await new Response(withClaudePing(src)).text();
    expect(text).toBe('event: ping\ndata: {"type": "ping"}\n\nevent: message_stop\n\n');
  });
});

describe("Codex peek cap", () => {
  it("stops holding the response after the cap and keeps every byte", async () => {
    vi.useFakeTimers();
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } });
    const response = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const peekP = new CodexExecutor()._peekSseTransientError(response);
    ctrl.enqueue(encoder.encode("event: response.created\n\n"));
    await vi.advanceTimersByTimeAsync(5000);
    const peek = await peekP;
    vi.useRealTimers();
    expect(peek.matched).toBeNull();
    ctrl.enqueue(encoder.encode("event: response.output_text.delta\n\n"));
    ctrl.close();
    await expect(new Response(peek.replacementBody).text())
      .resolves.toBe("event: response.created\n\nevent: response.output_text.delta\n\n");
  });
});
