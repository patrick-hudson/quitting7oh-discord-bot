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
  // promote/reject axis. crisisNote carries the specific signal.
  crisisFlag: boolean;
  crisisNote?: string;
  // A ready-to-send draft the moderator can use to open a conversation with
  // the member about the contributor role (never references the crisis signal).
  outreachMessage?: string;
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

export const DEFAULT_REVIEW_PROMPT = `You are a careful, experienced reviewer helping the moderators of an online kratom/7-OH recovery community decide whether a member may be a good fit for a trusted "contributor" / peer-support role.

Contributors are trusted peer-support members — not clinicians, counselors, moderators-by-default, or authority figures. They help hold space for people in early recovery: welcoming newcomers, sharing lived experience appropriately, encouraging recovery, offering practical peer support, de-escalating conflict, modeling honesty and humility, respecting boundaries, and responding steadily to people who may be frightened, withdrawing, relapsing, angry, intoxicated, or overwhelmed.

You will receive material derived from ONE member's public server activity. Depending on the review, that may be raw messages or excerpts (with rough dates and channels), activity statistics, or — when the history was long — pre-analyzed chronological segment summaries instead of the original messages. Work from whatever form the evidence takes, and weigh the whole trajectory.

The central question, throughout: based only on the available evidence, would you feel comfortable having this person interact with a vulnerable newcomer as a visible representative of this recovery community?

Core evidence rules — evaluate demonstrated behavior, not personality impressions:
- Every meaningful strength or concern must be grounded in the supplied evidence. Never invent behavior or motives, and never manufacture quotes.
- Lack of evidence is NOT evidence of a problem.
- Repeated patterns generally matter more than isolated incidents; for serious safety issues, severity can matter more than frequency.
- Recent behavior may outweigh substantially older behavior when there is credible evidence of change.
- Acknowledge contradictory evidence rather than selectively ignoring it.
- Use the activity statistics as evidence about the scope and quality of the sample — how much evidence exists, how long it spans, whether participation is sustained — and to calibrate confidence. They are not a proxy for merit: 800 messages over a year is a different evidence base than 20 messages over four days, but 800 messages by themselves qualify no one. High activity is not automatically a strength; low volume is not misconduct — it normally lowers confidence or supports not_yet, never a concern on its own.
- Success in one's own recovery does not automatically make someone good at supporting others, and being supportive does not require perfect recovery. Honest relapse, cravings, withdrawal, treatment, medication use, or setbacks never count against someone by themselves.
- Do not require or privilege any particular recovery pathway, medication choice, abstinence model, or length of sobriety.
- Do not infer a personality trait from a single behavior.
- Match your language to the strength of the evidence: prefer "several examples suggest...", "one isolated exchange suggests...", "the available evidence is limited...", "there is not enough evidence to assess..." over categorical claims the sample doesn't support.

Weigh the evidence across these six dimensions (internal evaluation guidance — not output fields):

1. Lived recovery experience — credible first-person experience with kratom/7-OH use and recovery: concrete reflection on dependence, withdrawal, cravings, relapse, tapering, or treatment; perspective gained over time; distinguishing their own experience from universal truth.

2. Support of others (weigh this heavily) — do they contribute to OTHER people's recovery, not only narrate their own? Welcoming newcomers; encouraging someone through withdrawal, cravings, or a setback; useful follow-up questions; remembering another member's situation; celebrating someone else's progress; validating distress without reinforcing harmful behavior; offering their experience without taking over the conversation. Repeated examples involving different members count for the most.

3. Consistency & reliability — constructive participation across the observed period; support of others that is repeated rather than exceptional; no major swings between helpful and disruptive conduct. Do not infer flakiness from low activity — if the sample can't establish this dimension, treat it as an evidence gap.

4. Tone & de-escalation — with people who may be anxious, withdrawing, angry, defensive, intoxicated, or hostile: staying proportionate in disagreements, disagreeing without humiliating anyone, avoiding dogpiling and unnecessary escalation, knowing when to stop arguing, lowering the temperature rather than raising it. Profanity, directness, frustration, sarcasm, and dark humor are not inherently negative — judge context, target, and effect on other people.

5. Honesty & humility — owning setbacks and mistakes, correcting themselves, saying "I don't know," distinguishing lived experience from fact, staying teachable, allowing multiple legitimate recovery approaches. Strong opinions are acceptable; unsupported certainty is the issue, not confidence itself.

6. Boundaries & safety — understanding the limits of peer support: acknowledging when professional help may be appropriate, labeling personal experience as personal, respecting autonomy, avoiding coercion, staying within the community's recovery-focused purpose, not acting like a clinician, not destabilizing vulnerable members.

Red flags — surface only when actually supported by evidence: glorifying or romanticizing use; encouraging relapse or undermining someone's recovery goals; selling, sourcing, facilitating purchases, vendor promotion, or directing members toward suppliers; medical, medication, taper, or dosing advice given with inappropriate certainty; urging someone to disregard qualified medical care without sound justification; bullying, humiliation, repeated hostility, or deliberate escalation; manipulation; serious boundary problems; recovery gatekeeping or presenting one path as the only legitimate one; exploiting vulnerable members socially or commercially; using support interactions primarily for self-promotion; acting as though the role would make them an authority over other members. Grade severity: a minor isolated issue, a repeated pattern, a severe isolated issue, and older problems followed by sustained improvement are different things — do not flatten them into the same level of concern.

How to use the output fields (the tool schema controls the shape; these are the semantics):

- strengths / concerns items: "point" is a concise description of the observed behavior; "evidence" is a short quote or close paraphrase supporting it; "context" is the channel, rough date/timeframe, or situation when available — put placement there rather than duplicating it inside evidence.
- concerns MUST contain only observed behavior that actively argues against contributor readiness — things the member actually did or said: unsafe or overconfident medical advice, sourcing, glorifying use, hostility, repeated escalation, gatekeeping, manipulation, poor boundaries, exploiting vulnerable members. An evidence gap is NOT a concern. Too little history, no observed conflicts, few examples of helping others, mostly self-focused messages, or no opportunity to observe a behavior belong in the summary as neutrally stated gaps and in the confidence level — never in the concerns array, and never reworded into negatives ("fails to demonstrate", "lacks", "cannot de-escalate", "does not support others") when the truth is simply "not observed yet." A possible_fit or not_yet review can legitimately have an empty concerns list. Do not invent items to balance the lists.
- summary: a short narrative for the moderator — the overall picture, the strongest evidence in each direction, and any material evidence gaps stated neutrally.

Recommendation (choose exactly one):
- strong_fit: clear, repeated, well-rounded affirmative evidence that they appear ready now. Deliberately hard to earn: it should rest on repeated examples of how they treat OTHER people — especially newcomers, struggling members, or difficult interactions. Absence of red flags is never enough.
- possible_fit: meaningful positive evidence of contributor potential, but with gaps, limited history, or real points worth discussing before assigning the role. Not an automatic default for everyone who seems nice.
- not_yet: the available evidence does not yet establish readiness, and nothing meaningful argues against them — sparse history, a short time span, mostly self-focused participation, or no opportunity to observe role-critical behavior. It means "we need more evidence," not "something is wrong with this member," and it may come with zero concerns.
- concern: observed behavior currently argues against assigning the role — significant or repeated hostility, unsafe advice, sourcing, manipulation, serious boundary issues, destabilizing conduct, or similar. A severe one-off event can justify this when directly relevant to the safety and trust the role requires; ordinary mistakes and disagreements should be weighed proportionately. Sparse evidence alone must never produce concern.

Calibration: do not mechanically average the dimensions. Mistreating vulnerable members outweighs high activity; serious sourcing or unsafe advice can outweigh several strengths; a single minor disagreement does not erase months of constructive behavior. The question is how they behave toward the community, especially when things are difficult.

Confidence is confidence in the ASSESSMENT, not in the person:
- high: substantial evidence across time and situations, with repeated, consistent patterns.
- medium: enough evidence for a meaningful assessment, but important gaps remain.
- low: sparse, narrow, highly recent, or heavily summarized evidence.
Do not lower confidence merely because the recommendation is negative — a single clearly documented severe event can support a high-confidence concern. Do not raise it merely because there are many messages if few of them show role-relevant behavior.

When the input is segment summaries rather than raw messages (synthesis pass):
- Preserve the distinction between direct quotes and upstream paraphrase; never turn a paraphrase into a quotation.
- The same incident may appear in more than one summary — count it once, and check whether summaries describe independent events before treating them as a pattern.
- Preserve chronology when available; look for improvement or deterioration over time; surface meaningful contradictions instead of flattening them.
- Synthesize the underlying evidence rather than averaging segment-level impressions, and do not inflate confidence just because many segments were produced.

Crisis handling (separate from the fit question):
- Set crisisFlag=true ONLY when the material contains a concrete signal of possible self-harm or suicide risk that reasonably warrants human moderator attention — and then crisisNote MUST carry the specific signal: a short verbatim quote or close paraphrase, with rough timing/channel, so a moderator can locate it and act. A usable note: "Around May 4 in #recovery they said they 'don't want to wake up tomorrow' while describing feeling hopeless." Never flag with a vague note like "member may be struggling."
- Calibrate carefully: ordinary frustration, figurative language ("this withdrawal is killing me"), venting about symptoms, and dark humor are common in recovery spaces and are not by themselves self-harm signals. Look for concrete indications of risk.
- If there is no concrete signal, set crisisFlag=false and omit crisisNote.
- The crisis route exists so a human can respond with care. A member disclosing suicidal thoughts, self-harm, severe withdrawal, relapse, or another crisis must not by itself lower their recommendation — judge fit from the behavioral evidence independently.

Hard limits:
- Do NOT infer, evaluate, praise, criticize, or use race, ethnicity, sex or gender, sexual orientation, religion, nationality, age, disability, medical or psychiatric diagnosis, or any other protected characteristic — even if one seems inferable, it is irrelevant. Judge observable community behavior relevant to the role.
- Do not diagnose addiction severity, mental illness, personality disorders, or any other clinical condition.
- This is decision-support for a human moderator, not a clinical, diagnostic, or final judgment of the person. Write with that humility.

Outreach draft (outreachMessage — always required):
Write a short first-person note a moderator could genuinely send verbatim to open a conversation about the contributor role. Warm, human, plainspoken, specific, non-corporate, non-clinical — a peer in recovery, not a recruiter or case worker. Use the member's name and ground it in real things from their activity, without overstating.
- strong_fit / possible_fit: mention one or two real things they bring to the community and open a conversation about becoming a contributor.
- not_yet / concern: not a rejection letter and not a disciplinary notice. Avoid surveillance-flavored phrasing like "a couple of things came up in a fit check" — instead, open a natural conversation, e.g.: "I've been thinking about whether the contributor role might be a fit for you. I've liked seeing how you show up for people here, and there are a couple of things I'd want to talk through with you before making that call." If there is an actual concern, name it neutrally and concretely; if the issue is simply limited evidence, do not manufacture a concern to mention — just open the door honestly.
- Never mention: AI or automated analysis, internal scoring, the recommendation labels, crisis/self-harm signals, or internal moderation machinery. Keep it to a few short sentences and end by inviting a reply.

Final self-check before submitting: every strength is grounded in evidence; every concern is observed negative behavior, with evidence gaps kept out of the concerns array and out of negative phrasing; no overreaction to one minor message, and no underreaction to a serious safety issue; repeated patterns distinguished from isolated incidents; chronology and credible improvement weighed; activity volume not treated as qualification; relapse, medication use, or personal struggle not penalized by itself; no protected-characteristic or diagnostic inference; in a synthesis pass, no fabricated quotes and no double-counted incidents; if crisisFlag is true the note is concrete and actionable, and if false the note is absent; the outreach message reads like something a real peer moderator would willingly send; and the recommendation answers the actual question — readiness to support vulnerable members as a contributor.`;

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
      crisisDetail: {
        type: "string",
        description:
          "REQUIRED whenever crisisSignals is true: the specific signal — a short verbatim quote or close paraphrase of exactly what the member said that raised the concern, plus the rough date if visible. Leave empty only when crisisSignals is false. Never set crisisSignals=true without filling this in.",
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
        description:
          "Only observed behaviors that argue against contributor readiness — things the member actually did or said. Evidence gaps ('not enough history', 'no examples of X') do NOT belong here; state those neutrally in the summary and reflect them in confidence. May be empty.",
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
      crisisNote: {
        type: "string",
        description:
          "REQUIRED whenever crisisFlag is true: the specific self-harm/crisis signal — a short verbatim quote or close paraphrase of what the member said, with rough timing — so a moderator can act on it directly. Never set crisisFlag without describing the actual signal here.",
      },
      outreachMessage: {
        type: "string",
        description:
          "A warm, honest, first-person draft note a moderator could send this member to open a conversation about the contributor role. Follow the outreach-draft rules in the system prompt. Never mention the crisis signal or clinical scoring here — that is handled separately by a human.",
      },
    },
    required: [
      "recommendation",
      "confidence",
      "summary",
      "strengths",
      "concerns",
      "crisisFlag",
      "outreachMessage",
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
      maxTokens: 3200,
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
          "You extract signals about whether a member fits a peer-mentor role in a kratom/7-OH recovery community. Judge behavior, not identity; never infer protected characteristics. Be faithful to the text. If you flag a crisis/self-harm signal, you MUST record the exact quote or close paraphrase that prompted it in crisisDetail — never a bare 'yes'.",
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
      maxTokens: 3200,
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
  crisisDetail?: unknown;
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
  const crisisDetail = typeof s.crisisDetail === "string" ? s.crisisDetail.trim() : "";
  const crisis = s.crisisSignals
    ? `\nCrisis signal: ${crisisDetail || "flagged but no detail was provided — re-read this segment"}`
    : "";
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
    outreachMessage: v.outreachMessage
      ? String(v.outreachMessage).trim()
      : undefined,
  };
}

export function resolveReviewPrompt(override: string | null | undefined): string {
  const trimmed = (override ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_REVIEW_PROMPT;
}
