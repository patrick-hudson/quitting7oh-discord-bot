// Apply the lead-time migration to a guild's scheduled posts. WRITES to
// the database. Always run preview-lead-change.ts first with the same env
// vars and inspect the output before invoking this.
//
// Usage:
//   GUILD_ID=<snowflake> [NEW_LEAD=15] [NAME_FILTER="KA"] \
//     npx tsx scripts/apply-lead-change.ts
//
// For each matching cron-scheduled post:
//   - shifts the cron expression by (oldLead - NEW_LEAD) minutes so the
//     real-world meeting stays at the same wall-clock time;
//   - sets leadMinutes = NEW_LEAD;
//   - recomputes nextFireAt with the new cron.
//
// Posts already at the target lead are skipped. Complex cron expressions
// (lists/ranges/steps in the minute or hour field) are skipped with a
// clear error line — fix or migrate those by hand.

import { prisma } from "@/lib/db";
import { computeNextFireAt } from "@/lib/cron";
import { shiftCronByMinutes } from "./lib/lead-shift";

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
  console.log(`Applying to ${posts.length} cron-scheduled post(s).`);
  console.log("");

  if (posts.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of posts) {
    const oldLead = p.leadMinutes;
    const delta = oldLead - NEW_LEAD;

    if (delta === 0) {
      console.log(`  · ${p.name} — already at ${NEW_LEAD} min, skip`);
      skipped++;
      continue;
    }

    const shift = shiftCronByMinutes(p.cron!, -delta);
    if (!shift.ok) {
      console.log(`  ✗ ${p.name} — cannot shift cron "${p.cron}": ${shift.error}`);
      errors.push(p.name);
      continue;
    }

    const nextFireAt = computeNextFireAt({
      cron: shift.newCron,
      runAt: null,
      timezone: p.timezone,
      guildTimezone: guild.timezone,
    });

    await prisma.scheduledPost.update({
      where: { id: p.id },
      data: {
        cron: shift.newCron,
        leadMinutes: NEW_LEAD,
        nextFireAt,
      },
    });

    const dayWarn =
      shift.dayShift !== 0
        ? ` ⚠ crossed midnight (${shift.dayShift > 0 ? "+" : ""}${shift.dayShift} day)`
        : "";
    console.log(
      `  ✓ ${p.name} — cron ${p.cron} → ${shift.newCron}, lead ${oldLead} → ${NEW_LEAD}${dayWarn}`
    );
    updated++;
  }

  console.log("");
  console.log("─".repeat(64));
  const errSuffix = errors.length ? `, ${errors.length} error(s)` : "";
  console.log(`Done: ${updated} updated, ${skipped} skipped${errSuffix}.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Apply failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
