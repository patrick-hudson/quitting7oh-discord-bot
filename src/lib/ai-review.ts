// AI contributor-fit reviewer. Gathers a member's message history and asks
// Claude — framed as a professional reviewer for a recovery-community
// contributor/mentor role — for a structured, evidence-backed verdict.
//
// Runs in the bot worker (src/bot/ai-review-worker.ts), never a web request:
// gathering + model calls are slow and high-volume.
//
// Cost/quality strategy: histories that fit the token budget go in one Sonnet
// pass. Larger ones use map-reduce — a cheap Haiku pass extracts signals from
// each chronological chunk, then a single Sonnet pass synthesizes the verdict.
// This scales to any volume, preserves the member's trajectory over time, and
// spends the expensive model only where judgment happens.

import Anthropic from "@anthropic-ai/sdk";
import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { env } from "@/lib/env";
import { archiveDir } from "@/bot/archive-worker";
import {
  listTextChannels,
  scanMessagesByAuthor,
  type DiscordMessageRaw,
} from "@/lib/discord-rest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Recommendation =
  | "strong_fit"
  | "possible_fit"
  | "not_yet"
  | "concern";

export type VerdictPoint = {
  point: string;
  evidence: string; // a short quote or paraphrase from their messages
  context?: string; // channel / rough timeframe, when the model can place it
};

export type AiVerdict = {
  recommendation: Recommendation;
  confidence: "low" | "medium" | "high";
  summary: string;
  strengths: VerdictPoint[];
  concerns: VerdictPoint[];
  // Raised when the history shows self-harm / crisis signals that a human
  // should look at — routed here on purpose instead of folding into the
  // promote/reject axis.
  crisisFlag: boolean;
  crisisNote?: string;
};

export type AiReviewResult = {
  verdict: AiVerdict;
  model: string;
  source: "archive" | "scan";
  messagesAnalyzed: number;
  inputTokens: number;
  outputTokens: number;
};

// Quantitative context handed to the model alongside the messages (from the
// leaderboard aggregate) — kept optional so a review can run without it.
export type ReviewStats = {
  total: number;
  d7: number;
  d30: number;
  activeDays: number;
  consistency: number;
  channels: number;
  tenureDays: number;
};

export type GenerateReviewInput = {
  guildId: string;
  targetUserId: string;
  targetName: string;
  sinceAt: Date | null;
  untilAt: Date | null;
  channelIds: string[];
  systemPrompt: string; // resolved override or DEFAULT_REVIEW_PROMPT
  archiveEnabled: boolean;
  stats?: ReviewStats | null;
};

// ---------------------------------------------------------------------------
// Default rubric / system prompt
// ---------------------------------------------------------------------------
// The whole thing is overridable per guild (Guild.aiReviewPrompt). If you edit
// it there, keep the guardrails — they're not decoration.

export const DEFAULT_REVIEW_PROMPT = `You are a seasoned, careful reviewer helping the moderators of an online kratom/7-OH recovery community decide whether a member would be a good fit for a "contributor" / peer-mentor role. Contributors help hold space for people in early recovery: welcoming newcomers, sharing lived experience, de-escalating conflict, and modeling steady, honest recovery.

You are given a sample of ONE member's public messages from the server (with rough dates and channels). Assess them the way a thoughtful hiring manager would assess a candidate — grounded entirely in what the messages actually show.

Weigh evidence for and against fit across these dimensions:
- Lived recovery experience: do they speak from genuine, first-hand experience with kratom/7-OH use and recovery?
- Support of others: do they show up for other members — encouragement, practical help, empathy, following up?
- Consistency & reliability: is their presence steady over time, or sporadic/flaky?
- Tone & de-escalation: are they calm, respectful, and able to defuse tension, especially with people who are struggling or hostile?
- Honesty & humility: do they own setbacks, avoid grandstanding, and stay teachable?
- Boundaries & safety: do they respect the community's purpose and other members?

Red flags to surface if present: glorifying or romanticizing use, encouraging relapse, selling/sourcing substances or promoting vendors, giving unqualified medical/dosing advice as fact, hostility or bullying, manipulation, or using the space primarily for self-promotion.

Rules you must follow:
- Base every strength and concern on the actual messages. Quote or closely paraphrase as evidence. Do not invent behavior you did not see.
- Do NOT infer or comment on race, gender, age, religion, nationality, sexuality, disability, or any protected characteristic. Judge behavior, not identity.
- This is decision-support for a human, not a clinical, diagnostic, or final judgment of the person. Write with that humility.
- If you see signs the member may be in crisis or at risk of self-harm, set crisisFlag=true and briefly note it — this routes to a human for care, separate from the fit question. Do not let a crisis signal by itself drive a negative fit recommendation.
- Be concise and specific. A few strong, well-evidenced points beat a long list of vague ones.

Recommendation scale:
- strong_fit: clear, well-rounded evidence they'd be an asset now.
- possible_fit: promising but with gaps worth watching or a short conversation first.
- not_yet: not enough positive signal yet (often just early/low activity) — revisit later.
- concern: something in the messages actively argues against giving them this role right now.`;

// Tool the map step extracts signals with (cheap model, per chunk).
const SIGNALS_TOOL: Anthropic.Tool = {
  name: "submit_signals",
  description:
    "Record the recovery-role-relevant signals found in this segment of the member's messages.",
  input_schema: {
    type: "object",
    properties: {
      observations: {
        type: "string",
        description:
          "2-5 concise sentences on what this segment shows about their fit for a peer-mentor role (tone, support of others, lived experience, reliability).",
      },
      quotes: {
        type: "array",
        description: "Up to 5 short, representative verbatim quotes.",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            note: {
              type: "string",
              description: "Why this quote is notable (1 short phrase).",
            },
          },
          required: ["text", "note"],
        },
      },
      redFlags: {
        type: "array",
        description: "Any red-flag behaviors observed in this segment (empty if none).",
        items: { type: "string" },
      },
      crisisSignals: {
        type: "boolean",
        description:
          "True if this segment shows possible self-harm/crisis signals a human should review.",
      },
    },
    required: ["observations", "quotes", "redFlags", "crisisSignals"],
  },
};

// Tool the final synthesis returns the verdict with.
const VERDICT_TOOL: Anthropic.Tool = {
  name: "submit_review",
  description:
    "Submit the final contributor-fit review as structured, evidence-backed data.",
  input_schema: {
    type: "object",
    properties: {
      recommendation: {
        type: "string",
        enum: ["strong_fit", "possible_fit", "not_yet", "concern"],
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      summary: {
        type: "string",
        description: "3-6 sentence narrative assessment written for a moderator.",
      },
      strengths: {
        type: "array",
        items: {
          type: "object",
          properties: {
            point: { type: "string" },
            evidence: {
              type: "string",
              description: "A short quote or close paraphrase supporting this point.",
            },
            context: {
              type: "string",
              description: "Channel and/or rough timeframe, if placeable.",
            },
          },
          required: ["point", "evidence"],
        },
      },
      concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            point: { type: "string" },
            evidence: { type: "string" },
            context: { type: "string" },
          },
          required: ["point", "evidence"],
        },
      },
      crisisFlag: { type: "boolean" },
      crisisNote: { type: "string" },
    },
    required: [
      "recommendation",
      "confidence",
      "summary",
      "strengths",
      "concerns",
      "crisisFlag",
    ],
  },
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export class NoApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set — the AI reviewer is disabled.");
    this.name = "NoApiKeyError";
  }
}
export class NoMessagesError extends Error {
  constructor() {
    super("No messages found for this member in the selected range.");
    this.name = "NoMessagesError";
  }
}

export async function generateReview(
  input: GenerateReviewInput
): Promise<AiReviewResult> {
  const apiKey = env.anthropicApiKey();
  if (!apiKey) throw new NoApiKeyError();

  const gathered = await gatherMessages(input);
  if (gathered.messages.length === 0) throw new NoMessagesError();

  const client = new Anthropic({ apiKey });
  const transcript = gathered.messages.map(formatLine);
  const totalChars = transcript.reduce((n, l) => n + l.length + 1, 0);
  const budgetChars = env.aiReviewMaxInputTokens() * APPROX_CHARS_PER_TOKEN;
  const header = statsHeader(input, gathered);

  let inputTokens = 0;
  let outputTokens = 0;
  let verdict: AiVerdict;

  if (totalChars <= budgetChars) {
    // --- Single pass: whole history fits, straight to the verdict model. ---
    const user = `${header}\n\n--- MESSAGES (chronological) ---\n${transcript.join(
      "\n"
    )}`;
    const res = await callTool(client, {
      model: env.aiReviewModel(),
      system: input.systemPrompt,
      user,
      tool: VERDICT_TOOL,
      maxTokens: 2500,
    });
    verdict = normalizeVerdict(res.input);
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
  } else {
    // --- Map-reduce: chunk chronologically, extract signals cheaply, then
    //     synthesize once with the verdict model. ---
    const chunks = chunkLines(transcript, budgetChars);
    const segments: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const res = await callTool(client, {
        model: env.aiReviewMapModel(),
        system:
          "You extract signals about whether a member fits a peer-mentor role in a kratom/7-OH recovery community. Judge behavior, not identity; never infer protected characteristics. Be faithful to the text.",
        user: `Segment ${i + 1} of ${chunks.length} of one member's messages:\n\n${chunks[
          i
        ].join("\n")}`,
        tool: SIGNALS_TOOL,
        maxTokens: 1200,
      });
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      segments.push(formatSegment(i + 1, res.input as SignalsInput));
    }
    const user = `${header}\n\nThe member's history was long, so it was split into ${chunks.length} chronological segments and each was pre-analyzed. Synthesize a single, coherent review from these segment analyses. Weigh the whole trajectory, not just the loudest segment.\n\n--- SEGMENT ANALYSES ---\n${segments.join(
      "\n\n"
    )}`;
    const res = await callTool(client, {
      model: env.aiReviewModel(),
      system: input.systemPrompt,
      user,
      tool: VERDICT_TOOL,
      maxTokens: 2500,
    });
    verdict = normalizeVerdict(res.input);
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
  }

  return {
    verdict,
    model: env.aiReviewModel(),
    source: gathered.source,
    messagesAnalyzed: gathered.messages.length,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Message gathering
// ---------------------------------------------------------------------------

type GatheredMessage = { ts: number; channel: string; content: string };
type Gathered = { messages: GatheredMessage[]; source: "archive" | "scan" };

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_MSG_CHARS = 2000; // truncate any single monster message

async function gatherMessages(input: GenerateReviewInput): Promise<Gathered> {
  const { guildId } = input;
  const sinceMs = input.sinceAt?.getTime() ?? null;
  const untilMs = input.untilAt?.getTime() ?? null;

  // Channel id → name, best-effort (labels only; failure isn't fatal).
  let channelName = new Map<string, string>();
  try {
    channelName = new Map(
      (await listTextChannels(guildId)).map((c) => [c.id, c.name])
    );
  } catch {
    // fall through — we'll label with the raw id
  }

  const dir = path.join(archiveDir(), guildId);
  const useArchive = input.archiveEnabled && existsSync(dir);

  const messages = useArchive
    ? await gatherFromArchive(dir, input, sinceMs, untilMs, channelName)
    : await gatherFromScan(input, sinceMs, untilMs, channelName);

  // Newest-first cap, then back to chronological for the transcript.
  const cap = env.aiReviewMaxMessages();
  messages.sort((a, b) => a.ts - b.ts);
  const capped =
    messages.length > cap ? messages.slice(messages.length - cap) : messages;

  return { messages: capped, source: useArchive ? "archive" : "scan" };
}

// Read the on-disk JSONL archive, keeping only the target author's substantive
// messages in range. A cheap `includes(id)` pre-filter skips the ~99% of lines
// that aren't theirs before the (costly) JSON.parse.
async function gatherFromArchive(
  dir: string,
  input: GenerateReviewInput,
  sinceMs: number | null,
  untilMs: number | null,
  channelName: Map<string, string>
): Promise<GatheredMessage[]> {
  const wanted = new Set(input.channelIds);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: GatheredMessage[] = [];
  for (const file of files) {
    const channelId = file.replace(/\.jsonl$/, "");
    if (wanted.size > 0 && !wanted.has(channelId)) continue;
    const name = channelName.get(channelId) ?? channelId;
    const rl = readline.createInterface({
      input: createReadStream(path.join(dir, file), "utf8"),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes(input.targetUserId)) continue; // cheap pre-filter
      let m: DiscordMessageRaw;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.author?.id !== input.targetUserId) continue;
      const ts = new Date(m.timestamp).getTime();
      if (sinceMs !== null && ts < sinceMs) continue;
      if (untilMs !== null && ts > untilMs) continue;
      const content = cleanContent(m.content);
      if (!content) continue; // skip attachment/embed-only noise
      out.push({ ts, channel: name, content });
    }
  }
  return out;
}

// Fallback when the guild isn't archiving: scan live via the REST API, exactly
// like the user-export worker does.
async function gatherFromScan(
  input: GenerateReviewInput,
  _sinceMs: number | null,
  _untilMs: number | null,
  channelName: Map<string, string>
): Promise<GatheredMessage[]> {
  const channels =
    input.channelIds.length > 0
      ? input.channelIds
      : [...channelName.keys()];
  const out: GatheredMessage[] = [];
  for (const channelId of channels) {
    const name = channelName.get(channelId) ?? channelId;
    try {
      const { matches } = await scanMessagesByAuthor(channelId, input.targetUserId, {
        since: input.sinceAt,
        until: input.untilAt,
        scanLimit: env.aiReviewMaxMessages(),
      });
      for (const m of matches) {
        const content = cleanContent(m.content);
        if (!content) continue;
        out.push({ ts: new Date(m.timestamp).getTime(), channel: name, content });
      }
    } catch {
      // one unreadable channel shouldn't sink the whole review
    }
  }
  return out;
}

// Strip Discord markup to readable, token-light text and drop empties.
function cleanContent(raw: string): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/<@!?\d{17,21}>/g, "@user")
    .replace(/<@&\d{17,21}>/g, "@role")
    .replace(/<#\d{17,21}>/g, "#channel")
    .replace(/<a?:(\w+):\d{17,21}>/g, ":$1:")
    .replace(/<t:\d+:?[tTdDfFR]?>/g, "[time]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_MSG_CHARS
    ? cleaned.slice(0, MAX_MSG_CHARS) + "…"
    : cleaned;
}

function formatLine(m: GatheredMessage): string {
  const d = new Date(m.ts).toISOString().slice(0, 10);
  return `[${d} #${m.channel}] ${m.content}`;
}

// Split already-chronological transcript lines into chunks that each stay
// under the char budget (never splitting a line). Guarantees forward progress
// even if a single line somehow exceeds the budget.
function chunkLines(lines: string[], budgetChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length > budgetChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Model plumbing
// ---------------------------------------------------------------------------

async function callTool(
  client: Anthropic,
  args: {
    model: string;
    system: string;
    user: string;
    tool: Anthropic.Tool;
    maxTokens: number;
  }
): Promise<{ input: unknown; inputTokens: number; outputTokens: number }> {
  const res = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    tools: [args.tool],
    tool_choice: { type: "tool", name: args.tool.name },
    messages: [{ role: "user", content: args.user }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`Model returned no ${args.tool.name} tool call`);
  }
  return {
    input: block.input,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}

// Fields are typed loose on purpose — this is unvalidated model output. The
// tool schema asks for arrays of objects, but models occasionally return a
// scalar or a differently-shaped value, so formatSegment coerces everything.
type SignalsInput = {
  observations?: unknown;
  quotes?: unknown;
  redFlags?: unknown;
  crisisSignals?: unknown;
};

function formatSegment(n: number, s: SignalsInput): string {
  // Coerce defensively so one odd segment can't sink the whole review with
  // ".map is not a function".
  const quoteList = Array.isArray(s.quotes) ? s.quotes : [];
  const flagList = Array.isArray(s.redFlags) ? s.redFlags : [];
  const quotes = quoteList
    .map((q) => {
      const o = q as { text?: unknown; note?: unknown } | null;
      const text = typeof q === "string" ? q : String(o?.text ?? "");
      const note = o && typeof o === "object" && o.note ? ` — ${String(o.note)}` : "";
      return `  - "${text}"${note}`;
    })
    .join("\n");
  const flags = flagList.length
    ? `\nRed flags: ${flagList.map((f) => String(f)).join("; ")}`
    : "";
  const crisis = s.crisisSignals ? "\nCrisis signals: yes" : "";
  const observations = typeof s.observations === "string" ? s.observations : "";
  return `## Segment ${n}\n${observations}${
    quotes ? `\nNotable quotes:\n${quotes}` : ""
  }${flags}${crisis}`;
}

function statsHeader(input: GenerateReviewInput, gathered: Gathered): string {
  const range = [
    input.sinceAt ? `from ${input.sinceAt.toISOString().slice(0, 10)}` : "from the beginning",
    input.untilAt ? `until ${input.untilAt.toISOString().slice(0, 10)}` : "to now",
  ].join(" ");
  const s = input.stats;
  const statLine = s
    ? `Activity stats: ${s.total} total messages, ${s.d30} in last 30d, ${s.d7} in last 7d, active on ${s.activeDays} distinct days, ~${s.consistency}% posting consistency, across ${s.channels} channels, first posted ~${s.tenureDays} days ago.`
    : "Activity stats: not available.";
  return `You are reviewing the member "${input.targetName}" (${range}). The sample below is ${gathered.messages.length} of their substantive messages (attachment-only and empty messages were dropped). ${statLine}`;
}

// Coerce the model's tool input into a well-formed verdict, defensively.
function normalizeVerdict(raw: unknown): AiVerdict {
  const v = (raw ?? {}) as Record<string, unknown>;
  const rec = v.recommendation;
  const recommendation: Recommendation =
    rec === "strong_fit" || rec === "possible_fit" || rec === "not_yet" || rec === "concern"
      ? rec
      : "not_yet";
  const conf = v.confidence;
  const confidence = conf === "low" || conf === "medium" || conf === "high" ? conf : "low";
  const points = (arr: unknown): VerdictPoint[] =>
    Array.isArray(arr)
      ? arr
          .map((p) => {
            const o = (p ?? {}) as Record<string, unknown>;
            return {
              point: String(o.point ?? "").trim(),
              evidence: String(o.evidence ?? "").trim(),
              context: o.context ? String(o.context).trim() : undefined,
            };
          })
          .filter((p) => p.point)
      : [];
  return {
    recommendation,
    confidence,
    summary: String(v.summary ?? "").trim(),
    strengths: points(v.strengths),
    concerns: points(v.concerns),
    crisisFlag: Boolean(v.crisisFlag),
    crisisNote: v.crisisNote ? String(v.crisisNote).trim() : undefined,
  };
}

export function resolveReviewPrompt(override: string | null | undefined): string {
  const trimmed = (override ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_REVIEW_PROMPT;
}
