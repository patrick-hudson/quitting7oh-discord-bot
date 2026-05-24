// Pretty-print the lead-time migration plan for a guild's scheduled
// posts. Does NOT touch the database. Once the output looks right, run
// apply-lead-change.ts with the same env vars to commit it.
//
// Usage:
//   GUILD_ID=<snowflake> [NEW_LEAD=15] [NAME_FILTER="KA"] \
//     npx tsx scripts/preview-lead-change.ts
//
// Defaults:
//   NEW_LEAD     = 15  (warning fires 15 min before the meeting)
//   NAME_FILTER  = ""  (match all cron-scheduled posts in the guild)
//
// Only cron-scheduled posts are considered — one-off posts are skipped.

import { prisma } from "@/lib/db";
import { formatHM, meetingTimeFromCron, shiftCronByMinutes } from "./lib/lead-shift";

const GUILD_ID = process.env.GUILD_ID;
const NEW_LEAD = Number(process.env.NEW_LEAD ?? 15);
const NAME_FILTER = process.env.NAME_FILTER ?? "";

if (!GUILD_ID) {
  console.error("Missing GUILD_ID env var (Discord guild snowflake).");
  process.exit(1);
}
if (!Number.isInteger(NEW_LEAD) || NEW_LEAD < 0 || NEW_LEAD > 1440) {
  console.error("NEW_LEAD must be an integer between 0 and 1440.");
  process.exit(1);
}

async function main() {
  const guild = await prisma.guild.findUnique({ where: { id: GUILD_ID! } });
  if (!guild) {
    console.error(`Guild ${GUILD_ID} not found in the DB.`);
    process.exit(1);
  }

  const posts = await prisma.scheduledPost.findMany({
    where: {
      guildId: GUILD_ID!,
      cron: { not: null },
      ...(NAME_FILTER ? { name: { contains: NAME_FILTER } } : {}),
    },
    orderBy: { name: "asc" },
  });

  console.log(`Guild:        ${guild.name} (${GUILD_ID})`);
  console.log(`Target lead:  ${NEW_LEAD} min`);
  if (NAME_FILTER) console.log(`Name filter:  contains "${NAME_FILTER}"`);
  console.log(`Matched ${posts.length} cron-scheduled post(s).`);
  console.log("");

  if (posts.length === 0) {
    console.log("Nothing to preview.");
    await prisma.$disconnect();
    return;
  }

  let toChange = 0;
  let alreadyAtTarget = 0;
  const errors: string[] = [];
  const dayShifters: string[] = [];

  for (const p of posts) {
    const oldLead = p.leadMinutes;
    const delta = oldLead - NEW_LEAD;
    const meeting = meetingTimeFromCron(p.cron!, oldLead);
    const meetingStr = meeting ? formatHM(meeting.hour, meeting.minute) : "?";

    if (delta === 0) {
      console.log(`  · ${p.name}`);
      console.log(`    meeting ~${meetingStr} — already at lead ${oldLead} min, skip`);
      console.log("");
      alreadyAtTarget++;
      continue;
    }

    const shift = shiftCronByMinutes(p.cron!, -delta);
    if (!shift.ok) {
      console.log(`  ✗ ${p.name}`);
      console.log(`    cron "${p.cron}" — cannot shift: ${shift.error}`);
      console.log("");
      errors.push(p.name);
      continue;
    }

    console.log(`  → ${p.name}`);
    console.log(`    meeting at ~${meetingStr} (unchanged)`);
    console.log(`    cron:  ${p.cron}  →  ${shift.newCron}`);
    console.log(`    lead:  ${oldLead} min  →  ${NEW_LEAD} min`);
    if (shift.dayShift !== 0) {
      const sign = shift.dayShift > 0 ? "+" : "";
      console.log(
        `    ⚠ cron crosses midnight (${sign}${shift.dayShift} day) — DOW/DOM not auto-adjusted, review manually`
      );
      dayShifters.push(p.name);
    }
    console.log("");
    toChange++;
  }

  console.log("─".repeat(64));
  const errSuffix = errors.length ? `, ${errors.length} error(s)` : "";
  console.log(
    `Summary: ${toChange} to change, ${alreadyAtTarget} already at target${errSuffix}.`
  );
  if (dayShifters.length > 0) {
    console.log(`         ${dayShifters.length} would cross midnight — review before applying.`);
  }
  console.log("");
  if (toChange > 0) {
    const filterEnv = NAME_FILTER ? ` NAME_FILTER="${NAME_FILTER}"` : "";
    console.log("If this looks right, apply with:");
    console.log(
      `  GUILD_ID=${GUILD_ID} NEW_LEAD=${NEW_LEAD}${filterEnv} npx tsx scripts/apply-lead-change.ts`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Preview failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
