// One structured tool call that works across Claude model generations, shared
// by the AI fit reviewer (src/lib/ai-review.ts) and the Reddit sourcing
// screen (src/lib/reddit-screen.ts). Model ids come from env, so the same
// request has to run on whatever an operator configures:
//
//   - tool_choice is "auto" plus an explicit instruction. Sonnet 5.5 and
//     Opus 5.5 reject a forced tool_choice with a 400; older models accept
//     either. If the model answers in prose, ask once more.
//   - Current models think by default and thinking counts toward max_tokens,
//     so callers pass a generous cap and an effort level. Effort is only sent
//     to models that accept it — Haiku 4.5, Sonnet 4.5, and older reject the
//     parameter. If a response still runs out of tokens before the tool
//     call, retry once at low effort.
//   - stop_reason "refusal" throws ToolCallRefusalError, which callers treat
//     as permanent (a retry would decline the same way).

import Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high";

export class ToolCallRefusalError extends Error {
  constructor(detail: string) {
    super(`Model declined the request${detail ? `: ${detail}` : ""}`);
    this.name = "ToolCallRefusalError";
  }
}

// Models that 400 on output_config.effort: the 3.x family, Claude 4.0/4.1
// (dated ids like claude-sonnet-4-20250514), Sonnet 4.5, and Haiku 4.5.
// Everything newer (Opus 4.5+, 4.6+, the 5 family) accepts low/medium/high.
const NO_EFFORT =
  /^claude-(?:instant|2|3)|^claude-(?:sonnet|opus)-4(?:-[01])?(?:-\d{8})?$|^claude-(?:sonnet|haiku)-4-5\b/;

export function supportsEffort(model: string): boolean {
  return !NO_EFFORT.test(model.replace(/^(?:[a-z]+\.)?anthropic\./, ""));
}

export async function callTool(
  client: Anthropic,
  args: {
    model: string;
    system: string;
    user: string;
    tool: Anthropic.Tool;
    maxTokens: number;
    effort: Effort;
  }
): Promise<{ input: unknown; inputTokens: number; outputTokens: number }> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${args.user}\n\nSubmit your answer by calling the ${args.tool.name} tool.`,
    },
  ];
  let effort = args.effort;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      tools: [args.tool],
      tool_choice: { type: "auto" },
      ...(supportsEffort(args.model) ? { output_config: { effort } } : {}),
      messages,
    });
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;

    if (res.stop_reason === "refusal") {
      throw new ToolCallRefusalError(res.stop_details?.explanation ?? "");
    }
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use" && res.stop_reason !== "max_tokens") {
      return { input: block.input, inputTokens, outputTokens };
    }

    if (res.stop_reason === "max_tokens") {
      // Out of room before a complete tool call (thinking can eat the cap).
      // Re-run the same request thinking less; nothing to append.
      if (effort === "low" || !supportsEffort(args.model)) break;
      effort = "low";
      continue;
    }
    // Answered in prose: keep the turn (thinking blocks included, unmodified)
    // and ask again. Append-only, so replayed thinking stays valid.
    messages.push(
      { role: "assistant", content: res.content },
      { role: "user", content: `Submit your answer by calling the ${args.tool.name} tool.` }
    );
  }
  throw new Error(`Model returned no ${args.tool.name} tool call`);
}
