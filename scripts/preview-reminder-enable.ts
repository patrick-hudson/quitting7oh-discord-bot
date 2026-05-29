// Pretty-print a plan to enable the follow-up reminder on a guild's scheduled
// posts. Does NOT touch the database. Once the output looks right, run
// apply-reminder-enable.ts with the same env vars to commit it.
//
// Usage:
//   GUILD_ID=<snowflake> [REMINDER_MINUTES=5] [NAME_FILTER="KA"] \
//     npx tsx scripts/preview-reminder-enable.ts
//
// Defaults:
//   REMINDER_MINUTES = 5   (reminder fires 5 min before the meeting)
//   NAME_FILTER      = ""  (match all posts in the guild)
//
// For each matching post this sets reminderMinutes and clears reminderContent
// (null = the bot picks from its baked-in template roster at fire time).
// Posts whose leadMinutes is not strictly greater than REMINDER_MINUTES are
// skipped — the reminder must fire after the original post, never before it.

import { prisma } from "@/lib/db";

const GUILD_ID = process.env.GUILD_ID;
const REMINDER_MINUTES = Number(process.env.REMINDER_MINUTES ?? 5);
const NAME_FILTER = process.env.NAME_FILTER ?? "";

if (!GUILD_ID) {
  console.error("Missing GUILD_ID env var (Discord guild snowflake).");
  process.exit(1);
}
if (!Number.isInteger(REMINDER_MINUTES) || REMINDER_MINUTES < 1 || REMINDER_MINUTES > 1439) {
  console.error("REMINDER_MINUTES must be an integer between 1 and 1439.");
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
      ...(NAME_FILTER ? { name: { contains: NAME_FILTER } } : {}),
    },
    orderBy: { name: "asc" },
  });

  console.log(`Guild:           ${guild.name} (${GUILD_ID})`);
  console.log(`Reminder lead:   ${REMINDER_MINUTES} min before the meeting`);
  console.log(`Reminder text:   default (built-in roster)`);
  if (NAME_FILTER) console.log(`Name filter:     contains "${NAME_FILTER}"`);
  console.log(`Matched ${posts.length} post(s).`);
  console.log("");

  if (posts.length === 0) {
    console.log("Nothing to preview.");
    await prisma.$disconnect();
    return;
  }

  let toChange = 0;
  let alreadyAtTarget = 0;
  const tooShort: string[] = [];

  for (const p of posts) {
    // Reminder must fire strictly after the original post: reminder < lead.
    if (p.leadMinutes <= REMINDER_MINUTES) {
      console.log(`  ✗ ${p.name}`);
      console.log(
        `    lead time ${p.leadMinutes} min ≤ reminder ${REMINDER_MINUTES} min — can't enable (reminder must be < lead)`
      );
      console.log("");
      tooShort.push(p.name);
      continue;
    }

    const alreadySet =
      p.reminderMinutes === REMINDER_MINUTES && p.reminderContent === null;
    if (alreadySet) {
      console.log(`  · ${p.name}`);
      console.log(`    already ${REMINDER_MINUTES} min before with default text, skip`);
      console.log("");
      alreadyAtTarget++;
      continue;
    }

    const fromStr =
      p.reminderMinutes === null
        ? "off"
        : `${p.reminderMinutes} min (${p.reminderContent ? "custom text" : "default text"})`;

    console.log(`  → ${p.name}`);
    console.log(`    lead time: ${p.leadMinutes} min`);
    console.log(`    reminder:  ${fromStr}  →  ${REMINDER_MINUTES} min before (default text)`);
    if (p.reminderContent) {
      console.log(`    ⚠ existing custom reminder text will be cleared (reset to default)`);
    }
    console.log("");
    toChange++;
  }

  console.log("─".repeat(64));
  const shortSuffix = tooShort.length ? `, ${tooShort.length} skipped (lead too short)` : "";
  console.log(
    `Summary: ${toChange} to change, ${alreadyAtTarget} already at target${shortSuffix}.`
  );
  console.log("");
  if (toChange > 0) {
    const filterEnv = NAME_FILTER ? ` NAME_FILTER="${NAME_FILTER}"` : "";
    console.log("If this looks right, apply with:");
    console.log(
      `  GUILD_ID=${GUILD_ID} REMINDER_MINUTES=${REMINDER_MINUTES}${filterEnv} npx tsx scripts/apply-reminder-enable.ts`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Preview failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
