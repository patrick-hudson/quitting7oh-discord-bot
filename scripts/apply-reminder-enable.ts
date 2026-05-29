// Enable the follow-up reminder on a guild's scheduled posts. WRITES to the
// database. Always run preview-reminder-enable.ts first with the same env vars
// and inspect the output before invoking this.
//
// Usage:
//   GUILD_ID=<snowflake> [REMINDER_MINUTES=5] [NAME_FILTER="KA"] \
//     npx tsx scripts/apply-reminder-enable.ts
//
// For each matching post it sets:
//   - reminderMinutes = REMINDER_MINUTES
//   - reminderContent = null  (bot picks from the baked-in roster at fire time)
//
// Posts whose leadMinutes is not strictly greater than REMINDER_MINUTES are
// skipped — the reminder must fire after the original post, never before it.
// This does not change when posts fire, so no nextFireAt recompute is needed;
// PostReminder rows are created by the scheduler when each post next fires.

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
  console.log(`Applying to ${posts.length} matched post(s).`);
  console.log("");

  if (posts.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;
  const tooShort: string[] = [];

  for (const p of posts) {
    if (p.leadMinutes <= REMINDER_MINUTES) {
      console.log(
        `  ✗ ${p.name} — lead ${p.leadMinutes} min ≤ reminder ${REMINDER_MINUTES} min, skip`
      );
      tooShort.push(p.name);
      continue;
    }

    const alreadySet =
      p.reminderMinutes === REMINDER_MINUTES && p.reminderContent === null;
    if (alreadySet) {
      console.log(`  · ${p.name} — already ${REMINDER_MINUTES} min, default text, skip`);
      skipped++;
      continue;
    }

    await prisma.scheduledPost.update({
      where: { id: p.id },
      data: { reminderMinutes: REMINDER_MINUTES, reminderContent: null },
    });
    console.log(`  ✓ ${p.name} — reminder ${REMINDER_MINUTES} min before, default text`);
    updated++;
  }

  console.log("");
  console.log("─".repeat(64));
  const shortSuffix = tooShort.length ? `, ${tooShort.length} skipped (lead too short)` : "";
  console.log(`Done: ${updated} updated, ${skipped} already set${shortSuffix}.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Apply failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
