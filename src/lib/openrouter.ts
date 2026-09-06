/**
 * OpenRouter client (OpenAI-compatible chat completions).
 * Every call degrades gracefully: no key configured means `llmEnabled()` is
 * false and callers fall back to the statistical output rather than erroring.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const llmEnabled = () => Boolean(process.env.OPENROUTER_API_KEY);

export const textModel = () => process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5";
export const visionModel = () =>
  process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || textModel();

/**
 * Preferred upstream providers, in order (OpenRouter serves most models from
 * several). Fallbacks stay on by default: pinning a single provider means a
 * briefing fails outright whenever that one is rate-limited, and a busy
 * provider is a worse reason to lose a weekly report than a slightly different
 * machine answering. Set OPENROUTER_ALLOW_FALLBACKS=false to pin strictly.
 */
export function providerRouting(): Record<string, unknown> | undefined {
  const order = (process.env.OPENROUTER_PROVIDER ?? "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const allowFallbacks = process.env.OPENROUTER_ALLOW_FALLBACKS !== "false";
  if (!order.length) return allowFallbacks ? undefined : undefined;
  return { order, allow_fallbacks: allowFallbacks };
}

/**
 * How hard a reasoning model should think. Reasoning tokens are billed as
 * output and consume the same budget as the answer, so a task that is really
 * extraction (reading a CSV, parsing a goal) should not be paying for deep
 * deliberation. Set OPENROUTER_REASONING_EFFORT to override globally.
 */
export type Effort = "low" | "medium" | "high";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

export class LlmError extends Error {}

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatResult = { content: string; toolCalls?: ToolCall[] };

export async function chat(
  messages: ChatMessage[],
  opts: {
    model?: string; json?: boolean; maxTokens?: number; temperature?: number; effort?: Effort;
    tools?: unknown[]; toolChoice?: "auto" | "none" | "required";
  } = {}
): Promise<any> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LlmError("OPENROUTER_API_KEY is not set");

  const body: Record<string, unknown> = {
    model: opts.model ?? textModel(),
    messages,
    // Reasoning models can spend thousands of tokens thinking before emitting a
    // single visible character — a budget sized for the answer alone gets eaten
    // entirely by that. These models carry ~1M context, so the constraint is
    // cost, not capability, and output here is fractions of a cent.
    max_tokens: opts.maxTokens ?? 8000,
    temperature: opts.temperature ?? 0.4,
  };

  const effort = (process.env.OPENROUTER_REASONING_EFFORT as Effort | undefined) ?? opts.effort;
  if (effort) body.reasoning = { effort };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
    // A model mid-tool-call has no answer to give yet, so JSON mode would
    // force it to fabricate one instead of calling the tool it wants.
    delete body.response_format;
  }
  if (opts.json) body.response_format = { type: "json_object" };
  const routing = providerRouting();
  if (routing) body.provider = routing;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // OpenRouter uses these for attribution on your dashboard
      "HTTP-Referer": process.env.OAUTH_REDIRECT_URI?.replace(/\/api\/.*$/, "") ?? "http://localhost:3000",
      "X-Title": "Vector",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    // OpenRouter gates some models behind account attestations; the raw 403 is
    // opaque, so surface the actual thing the user has to go and do.
    if (res.status === 403 && text.includes("attestation")) {
      throw new LlmError(
        `The model "${body.model}" needs a one-time confirmation on your OpenRouter ` +
        `account before it can be used. Visit https://openrouter.ai/settings/preferences, ` +
        `then retry. (${text.slice(0, 160)})`
      );
    }
    if (res.status === 429) {
      const pinned = process.env.OPENROUTER_ALLOW_FALLBACKS === "false";
      throw new LlmError(
        `The model provider is rate-limited right now.` +
        (pinned
          ? ` OPENROUTER_ALLOW_FALLBACKS is "false", so no other provider was tried — unset it to let OpenRouter route around this.`
          : ` Try again shortly.`)
      );
    }
    throw new LlmError(`OpenRouter ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json?.error) throw new LlmError(`OpenRouter: ${JSON.stringify(json.error).slice(0, 300)}`);

  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  let content = msg.content;

  if (opts.tools?.length) {
    const toolCalls = (msg.tool_calls ?? []) as ToolCall[];
    if (toolCalls.length) return { content: typeof content === "string" ? content : "", toolCalls };
    if (typeof content === "string" && content.trim()) return { content, toolCalls: [] };
  }

  // Some reasoning models return an empty `content` with the answer stranded in
  // `reasoning` when they run the thinking budget close to the limit. Salvage it
  // rather than failing, since the answer is genuinely there.
  if ((typeof content !== "string" || !content.trim()) && typeof msg.reasoning === "string") {
    const m = msg.reasoning.match(/\{[\s\S]*\}/);
    if (m) content = m[0];
  }

  if (typeof content !== "string" || !content.trim()) {
    // Say what actually came back — "malformed response" tells nobody anything.
    const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? "unknown";
    const keys = Object.keys(msg).join(", ") || "none";
    const reasoningTokens = json?.usage?.completion_tokens_details?.reasoning_tokens;
    throw new LlmError(
      `The model returned no usable content (finish_reason: ${finish}; message fields: ${keys}` +
      (reasoningTokens ? `; ${reasoningTokens} tokens spent reasoning` : "") +
      `). This usually means the token budget ran out during reasoning — raise maxTokens or use a non-reasoning model.`
    );
  }

  const finish = choice.finish_reason ?? choice.native_finish_reason;
  if (finish === "length") {
    const used = json?.usage?.completion_tokens_details?.reasoning_tokens;
    throw new LlmError(
      `The model hit its token limit before finishing` +
      (used ? ` (it spent ${used} tokens reasoning first)` : "") +
      `. Raise maxTokens, or switch OPENROUTER_MODEL to a non-reasoning model.`
    );
  }
  return opts.tools?.length ? ({ content, toolCalls: [] } as ChatResult) : content;
}

/** Chat that must return JSON. Tolerates models that wrap output in code fences. */
export async function chatJson<T>(messages: ChatMessage[], opts: Parameters<typeof chat>[1] = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true, tools: undefined });
  return parseJson<T>(typeof raw === "string" ? raw : raw.content);
}

export function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const once = JSON.parse(cleaned);
    // Some models return their JSON wrapped in a string literal. One parse then
    // yields a string rather than the object the caller is typed to expect.
    if (typeof once === "string") {
      try { return JSON.parse(once) as T; } catch { /* genuinely a string */ }
    }
    return once as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new LlmError(`Model did not return JSON: ${raw.slice(0, 200)}`);
  }
}

/** List available models, so Settings can offer a real picker rather than a text box. */
export async function listModels(): Promise<{ id: string; name: string; context?: number }[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return [];
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.data ?? []).map((m: any) => ({
    id: m.id, name: m.name ?? m.id, context: m.context_length,
  }));
}
