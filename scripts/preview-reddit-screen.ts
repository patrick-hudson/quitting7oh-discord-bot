// Calibrate the reddit sourcing screen before turning it on. Runs the item
// classifier (classifyItems in src/lib/reddit-screen.ts) over the newest
// collected posts/comments for one subreddit and prints what it would label
// them. Read-only: never writes RedditScreenItem or RedditScreenUser, so the
// worker still screens these items normally once the screen is enabled.
//
// Costs real money, so it only calls the API with --yes. Without it, prints
// the plan and an estimated cost and exits.
//
// Usage:
//   npx tsx scripts/preview-reddit-screen.ts <guildId> <subreddit> \
//     [--limit 100] [--notes "..."] [--yes]
//
// Defaults:
//   --limit  100   newest N items (posts + comments together), max 2000
//   --notes        the guild's saved screen notes; pass --notes "" for none
//
// Model: AI_SCREEN_MODEL, else AI_REVIEW_MAP_MODEL (same as the worker).

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import {
  FLAG_LABELS,
  SCREEN_LABELS,
  ScreenRefusalError,
  classifyItems,
  type ScreenInputItem,
  type ScreenItemResult,
} from "@/lib/reddit-screen";

const BATCH_SIZE = 20; // same as the worker
const MAX_LIMIT = 2000;
const EXCLUDED_AUTHORS = ["automoderator", "[deleted]"];

// Estimate only. Same conservative 3 chars/token as the fit reviewer; the
// rubric plus tool schema (~4.5k chars) is re-sent with every batch.
const CHARS_PER_TOKEN = 3;
const RUBRIC_TOKENS = 2000;
const OUTPUT_TOKENS_PER_ITEM = 150;

// $ per million tokens [input, output], matched by model-id prefix.
const PRICES: Array<[string, number, number]> = [
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-4-5", 1, 5],
  ["claude-sonnet-5", 2, 10], // 5 and 5.5
  ["claude-sonnet-4-6", 3, 15],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4", 5, 25], // 4.6–4.8
  ["claude-fable-5", 10, 50],
];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function usage(msg: string): never {
  console.error(msg);
  console.error(
    'Usage: npx tsx scripts/preview-reddit-screen.ts <guildId> <subreddit> [--limit 100] [--notes "..."] [--yes]'
  );
  process.exit(1);
}

const positional: string[] = [];
let limit = 100;
let notesArg: string | undefined;
let yes = false;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const [flag, inline] = eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) usage(`${flag} needs a value.`);
      return argv[++i];
    };
    if (flag === "--yes" || flag === "-y") yes = true;
    else if (flag === "--limit") limit = Number(value());
    else if (flag === "--notes") notesArg = value();
    else if (flag.startsWith("-")) usage(`Unknown flag ${flag}.`);
    else positional.push(a);
  }
}
const [GUILD_ID, rawSub] = positional;
if (!GUILD_ID || !rawSub || positional.length > 2) usage("Need exactly <guildId> and <subreddit>.");
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
  usage(`--limit must be an integer between 1 and ${MAX_LIMIT}.`);
}
const SUBREDDIT = rawSub.replace(/^\/?r\//i, "").toLowerCase();

// ---------------------------------------------------------------------------

type Row = {
  fid: string;
  kind: "post" | "comment";
  subreddit: string;
  author: string;
  postTitle: string;
  body: string;
  permalink: string;
  createdAt: Date;
};

async function main() {
  const guild = await prisma.guild.findUnique({
    where: { id: GUILD_ID },
    select: { name: true, redditScreenNotes: true },
  });
  if (!guild) {
    console.error(`Guild ${GUILD_ID} not found in the DB.`);
    process.exit(1);
  }

  // Newest first for the LIMIT, then oldest first so batches read like a feed.
  const rows = (
    await prisma.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT 't3_' || id AS fid, 'post' AS kind, subreddit, author,
               title AS "postTitle", body, permalink, "createdAt"
        FROM "RedditPost"
        WHERE "guildId" = ${GUILD_ID} AND subreddit = ${SUBREDDIT}
        UNION ALL
        SELECT 't1_' || id AS fid, 'comment' AS kind, subreddit, author,
               "postTitle", body, permalink, "createdAt"
        FROM "RedditComment"
        WHERE "guildId" = ${GUILD_ID} AND subreddit = ${SUBREDDIT}
      ) x
      WHERE lower(x.author) <> ALL(${EXCLUDED_AUTHORS})
      ORDER BY x."createdAt" DESC
      LIMIT ${limit}
    `
  ).reverse();

  const notes = notesArg !== undefined ? notesArg : guild.redditScreenNotes;
  const notesSource =
    notesArg !== undefined ? (notesArg.trim() ? "--notes" : "none (--notes \"\")") : notes?.trim() ? "guild's saved notes" : "none";
  const model = env.aiScreenModel();
  const posts = rows.filter((r) => r.kind === "post").length;
  const batches = Math.ceil(rows.length / BATCH_SIZE);

  console.log(`Guild:      ${guild.name} (${GUILD_ID})`);
  console.log(`Subreddit:  r/${SUBREDDIT}`);
  console.log(`Model:      ${model}`);
  console.log(`Notes:      ${notesSource}`);
  if (notes?.trim()) console.log(indent(notes.trim(), "            "));
  if (rows.length === 0) {
    console.log("");
    console.log(`No collected posts or comments for r/${SUBREDDIT} in this guild. Nothing to screen.`);
    await prisma.$disconnect();
    return;
  }
  console.log(
    `Items:      ${rows.length} (${posts} post(s), ${rows.length - posts} comment(s)), ${fmtDate(rows[0].createdAt)} → ${fmtDate(rows[rows.length - 1].createdAt)}`
  );
  console.log(`Calls:      ${batches} batch(es) of up to ${BATCH_SIZE}`);

  const estIn =
    batches * (RUBRIC_TOKENS + Math.ceil((notes ?? "").length / CHARS_PER_TOKEN)) +
    Math.ceil(rows.reduce((n, r) => n + Math.min(r.body.length, 1500) + Math.min(r.postTitle.length, 300) + 120, 0) / CHARS_PER_TOKEN);
  const estOut = rows.length * OUTPUT_TOKENS_PER_ITEM;
  console.log(`Estimate:   ~${estIn.toLocaleString()} input + ~${estOut.toLocaleString()} output tokens ≈ ${fmtCost(model, estIn, estOut)}`);
  console.log("");

  if (!yes) {
    console.log("Dry run — no API calls made. Re-run with --yes to classify:");
    const notesFlag = notesArg !== undefined ? ` --notes ${shellQuote(notesArg)}` : "";
    console.log(`  npx tsx scripts/preview-reddit-screen.ts ${GUILD_ID} ${SUBREDDIT} --limit ${limit}${notesFlag} --yes`);
    await prisma.$disconnect();
    return;
  }
  if (!env.anthropicApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  // Labels the worker already stored, for comparison (read only).
  const stored = new Map(
    (
      await prisma.redditScreenItem.findMany({
        where: { id: { in: rows.map((r) => r.fid) } },
        select: { id: true, label: true },
      })
    ).map((s) => [s.id, s.label])
  );

  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey() });
  const results = new Map<string, ScreenItemResult | "declined">();
  let inputTokens = 0;
  let outputTokens = 0;
  let failure: Error | null = null;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    process.stderr.write(`  batch ${i / BATCH_SIZE + 1}/${batches}…\n`);
    const input: ScreenInputItem[] = batch.map((r, j) => ({
      ref: String(j + 1),
      kind: r.kind,
      author: r.author,
      subreddit: r.subreddit,
      postTitle: r.postTitle,
      body: r.body,
      createdAt: r.createdAt,
    }));
    try {
      const res = await classifyItems(anthropic, { model, notes, items: input });
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      batch.forEach((r, j) => {
        const got = res.results.get(String(j + 1));
        if (got) results.set(r.fid, got);
      });
    } catch (err) {
      if (err instanceof ScreenRefusalError) {
        batch.forEach((r) => results.set(r.fid, "declined"));
        continue;
      }
      // Rate limit / outage: report what we have rather than lose it.
      failure = err as Error;
      break;
    }
  }

  printTable(rows, results, stored);
  printSummary(rows, results, stored);
  console.log("");
  console.log(
    `Tokens:     ${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output ≈ ${fmtCost(model, inputTokens, outputTokens)}`
  );
  if (failure) {
    console.error(`\nStopped early: ${failure.message}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const SEVERITY = ["sourcing", "promoting_use", "taper_sourcing", "struggling", "ok"];

// Flags first, so the rows a mod most needs to check are at the top.
function printTable(
  rows: Row[],
  results: Map<string, ScreenItemResult | "declined">,
  stored: Map<string, string>
) {
  const rank = (r: Row) => {
    const res = results.get(r.fid);
    if (!res) return SEVERITY.length + 1;
    if (res === "declined") return SEVERITY.length;
    return SEVERITY.indexOf(res.label);
  };
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());

  console.log(
    `${pad("", 2)}${pad("label", 15)}${pad("conf", 7)}${pad("RI", 4)}${pad("author", 22)}${pad("quote", 62)}permalink`
  );
  console.log("─".repeat(140));
  for (const r of sorted) {
    const res = results.get(r.fid);
    if (!res || res === "declined") {
      console.log(
        `${pad("", 2)}${pad(res ? "(declined)" : "(no result)", 15)}${pad("", 7)}${pad("", 4)}${pad(r.author, 22)}${pad(squash(r.body || r.postTitle, 60), 62)}${r.permalink}`
      );
      continue;
    }
    const flagged = FLAG_LABELS.includes(res.label);
    // The false positive that hurts: a struggling member labeled as a source.
    const mark = res.crisis ? "!!" : flagged && res.recoveryIntent ? "⚠ " : flagged ? "• " : "  ";
    console.log(
      `${mark}${pad(res.label, 15)}${pad(res.confidence, 7)}${pad(res.recoveryIntent ? "yes" : "", 4)}${pad(r.author, 22)}${pad(squash(res.evidence || r.body || r.postTitle, 60), 62)}${r.permalink}`
    );
    if (flagged || res.crisis) {
      console.log(`${" ".repeat(17)}why: ${res.reason}`);
      if (res.crisis) console.log(`${" ".repeat(17)}crisis: ${res.crisisNote ?? ""}`);
    }
    const was = stored.get(r.fid);
    if (was && was !== res.label) console.log(`${" ".repeat(17)}stored label was: ${was}`);
  }
  console.log("─".repeat(140));
  console.log("• flagged (counts toward the mod queue at medium/high)   ⚠ flagged AND recoveryIntent — check for a struggling member   !! crisis signal");
}

function printSummary(
  rows: Row[],
  results: Map<string, ScreenItemResult | "declined">,
  stored: Map<string, string>
) {
  const counts: Record<string, number> = {};
  let queued = 0;
  let flaggedWithIntent = 0;
  let crisis = 0;
  let changed = 0;
  for (const r of rows) {
    const res = results.get(r.fid);
    const label = !res ? "(no result)" : res === "declined" ? "(declined)" : res.label;
    counts[label] = (counts[label] ?? 0) + 1;
    if (res && res !== "declined") {
      const flagged = FLAG_LABELS.includes(res.label);
      if (flagged && res.confidence !== "low") queued++;
      if (flagged && res.recoveryIntent) flaggedWithIntent++;
      if (res.crisis) crisis++;
      const was = stored.get(r.fid);
      if (was && was !== res.label) changed++;
    }
  }
  console.log("");
  console.log("Labels:");
  for (const l of [...SCREEN_LABELS, "(declined)", "(no result)"]) {
    if (counts[l]) console.log(`  ${pad(l, 16)}${String(counts[l]).padStart(5)}  (${Math.round((100 * counts[l]) / rows.length)}%)`);
  }
  console.log("");
  console.log(`Would queue: ${queued} item(s) with a medium/high sourcing, promotion, or taper flag`);
  console.log(`Flagged with recoveryIntent: ${flaggedWithIntent}   Crisis signals: ${crisis}`);
  if (stored.size > 0) console.log(`Already screened by the worker: ${stored.size}, of which ${changed} got a different label now`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCost(model: string, input: number, output: number): string {
  const price = PRICES.find(([prefix]) => model.startsWith(prefix));
  if (!price) return "unknown (no price on file for this model)";
  const usd = (input * price[1] + output * price[2]) / 1_000_000;
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function squash(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function pad(s: string, n: number): string {
  const t = s.length > n - 1 ? s.slice(0, n - 2) + "…" : s;
  return t.padEnd(n);
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

main().catch(async (err) => {
  console.error("Preview failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
