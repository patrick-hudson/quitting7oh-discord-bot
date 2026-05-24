// One-shot seeder for Kratom Anonymous virtual meetings.
//
// Inserts 15 ScheduledPost rows covering the full weekly KA schedule. Each
// post uses the cutt.ly short link as the primary clickable URL — cutt.ly
// redirects are stable even when the underlying Zoom URL/passcode rotates,
// so we don't have to re-edit 15 posts every time KA refreshes a room.
//
// Usage (local dev):
//   SEED_GUILD_ID=<snowflake> SEED_CHANNEL_ID=<snowflake> \
//     npx tsx scripts/seed-ka-meetings.ts
//
// Usage (prod, run inside the compose stack):
//   docker compose -f docker-compose.prod.yml run --rm \
//     -e SEED_GUILD_ID=<snowflake> \
//     -e SEED_CHANNEL_ID=<snowflake> \
//     bot npx tsx scripts/seed-ka-meetings.ts
//
// This script is idempotent: it upserts by (guildId, name). Re-running
// safely refreshes content/title/color/cron on existing posts without
// touching `embedImage` or `mentionRoleId` you may have set in the UI.

import { prisma } from "@/lib/db";
import { computeNextFireAt } from "@/lib/cron";

const GUILD_ID = process.env.SEED_GUILD_ID;
const CHANNEL_ID = process.env.SEED_CHANNEL_ID;

if (!GUILD_ID || !CHANNEL_ID) {
  console.error(
    "Missing env vars. Set SEED_GUILD_ID and SEED_CHANNEL_ID (Discord snowflakes)."
  );
  process.exit(1);
}
if (!/^\d{17,21}$/.test(GUILD_ID) || !/^\d{17,21}$/.test(CHANNEL_ID)) {
  console.error("SEED_GUILD_ID and SEED_CHANNEL_ID must look like Discord snowflakes (17–21 digits).");
  process.exit(1);
}

// Reusable bullet lists per meeting format.
const DISCUSSION_BULLETS = `- **Open-topic share** — not step-focused; bring whatever's on your mind
- You can just listen; no obligation to talk
- Cameras encouraged but optional
- Newcomers welcome at every meeting
- Free, volunteer-led, confidential`;

const STEP_BULLETS = `- **Focused on one of KA's 12 Steps** — the group reads the step, then shares experience working it
- Newcomers welcome — no prep needed; bring whatever step you're on, or none at all
- You can just listen; no obligation to talk
- Cameras encouraged but optional
- Free, volunteer-led, confidential`;

// Build the embed description from per-meeting variables. The {meetingTime}
// placeholders are resolved at fire time by the scheduler.
function body(opts: {
  opener: string;
  etPt: string;
  cuttly: string;
  zoom: string;
  bullets: string;
}): string {
  return `${opts.opener}

⏰ **Starting {meetingTime:R} — {meetingTime:t} your time**
(${opts.etPt}). Runs about an hour.

🔗 **How to join**
Click the title link above, or: ${opts.cuttly}
Direct Zoom (if the short link is down): ${opts.zoom}

💬 **What to expect**
${opts.bullets}

🌐 **About KA**
Kratom Anonymous is a 12-step fellowship for kratom and 7-OH recovery. Full schedule + resources at https://www.kratom-anonymous.org/`;
}

// Color reference is in KA_MEETINGS.md — same order, same hexes.
const POSTS = [
  {
    name: "☕ Monday KA — 10:00 AM ET (Discussion)",
    embedTitle: "KA — Monday Morning Discussion",
    cron: "55 9 * * 1",
    color: "#D4A95E",
    cuttly: "https://cutt.ly/ctg55sR6",
    zoom: "https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1",
    opener:
      "Kicking off the week clean — and you're not doing it alone. **Open-topic discussion** (not step-focused) — bring a topic, bring a problem, or just sip and listen. Pajamas welcome, coffee mandatory, cameras optional.",
    etPt: "10:00 AM ET / 7:00 AM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🌙 Monday KA — 9:00 PM ET (Step)",
    embedTitle: "KA — Monday Evening Step",
    cron: "55 20 * * 1",
    color: "#5B6D9B",
    cuttly: "https://cutt.ly/8tgmCNjd",
    zoom: "https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1",
    opener:
      "Close out Monday with the people getting through this with you. We work **one of KA's 12 Steps** together tonight — no prep, no homework, just real talk about what's working.",
    etPt: "9:00 PM ET / 6:00 PM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "☕ Tuesday KA — 10:00 AM ET (Step)",
    embedTitle: "KA — Tuesday Morning Step",
    cron: "55 9 * * 2",
    color: "#7AB069",
    cuttly: "https://cutt.ly/ctg55sR6",
    zoom: "https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1",
    opener:
      "Tuesday morning — possibly the most adult thing you'll do today is showing up to this meeting. We work **one of KA's 12 Steps** together, no prep needed. Bring your coffee and whatever's on your mind.",
    etPt: "10:00 AM ET / 7:00 AM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "🌙 Tuesday KA — 9:00 PM ET (Discussion)",
    embedTitle: "KA — Tuesday Evening Discussion",
    cron: "55 20 * * 2",
    color: "#A576C2",
    cuttly: "https://cutt.ly/8tgmCNjd",
    zoom: "https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1",
    opener:
      "Tuesday night check-in. **Open-topic discussion** (not step-focused) — vent, celebrate, decompress, whatever you need. The dishes can wait.",
    etPt: "9:00 PM ET / 6:00 PM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "☕ Wednesday KA — 10:00 AM ET (Discussion)",
    embedTitle: "KA — Wednesday Morning Discussion",
    cron: "55 9 * * 3",
    color: "#E5B07C",
    cuttly: "https://cutt.ly/ctg55sR6",
    zoom: "https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1",
    opener:
      "Hump day, but make it sober. **Open-topic discussion** (not step-focused) to get you over the midweek hill — share what's stuck, listen to what's working, sip your coffee in good company.",
    etPt: "10:00 AM ET / 7:00 AM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🌙 Wednesday KA — 9:00 PM ET (Step)",
    embedTitle: "KA — Wednesday Evening Step",
    cron: "55 20 * * 3",
    color: "#4F8FA6",
    cuttly: "https://cutt.ly/8tgmCNjd",
    zoom: "https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1",
    opener:
      "Midweek step meeting — we work **one of KA's 12 Steps** together tonight. Show up however you are — bedhead, dinner crumbs, kids in the background, all of it. No prep required.",
    etPt: "9:00 PM ET / 6:00 PM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "☕ Thursday KA — 10:00 AM ET (Step)",
    embedTitle: "KA — Thursday Morning Step",
    cron: "55 9 * * 4",
    color: "#9CB76A",
    cuttly: "https://cutt.ly/ctg55sR6",
    zoom: "https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1",
    opener:
      "Almost-Friday morning, ready or not. We work **one of KA's 12 Steps** together before the day gets loud — bring nothing but yourself.",
    etPt: "10:00 AM ET / 7:00 AM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "🌆 Thursday KA — 6:45 PM ET (Discussion)",
    embedTitle: "KA — Thursday Early-Evening Discussion",
    cron: "40 18 * * 4",
    color: "#E08B5F",
    cuttly: "https://cutt.ly/4tgmVje8",
    zoom: "https://us06web.zoom.us/j/86106557739?pwd=b4ARPZhF3q7ROSabq65a1tQjNXhMYw.1",
    opener:
      "That perfect window between \"done with work\" and \"haven't started dinner.\" **Open-topic discussion** (not step-focused), friendly faces, real talk. Slot it right in.",
    etPt: "6:45 PM ET / 3:45 PM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🌙 Thursday KA — 9:00 PM ET (Discussion)",
    embedTitle: "KA — Thursday Evening Discussion",
    cron: "55 20 * * 4",
    color: "#7F9AB3",
    cuttly: "https://cutt.ly/8tgmCNjd",
    zoom: "https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1",
    opener:
      "Thursday night, the weekend's in sight. Close the day with people who get it — **open-topic discussion** (not step-focused), low-key vibe, all you need to do is click.",
    etPt: "9:00 PM ET / 6:00 PM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "☕ Friday KA — 10:00 AM ET (Discussion)",
    embedTitle: "KA — Friday Morning Discussion",
    cron: "55 9 * * 5",
    color: "#F0C46E",
    cuttly: "https://cutt.ly/ctg55sR6",
    zoom: "https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1",
    opener:
      "You made it to Friday morning, clean. That deserves a meeting. **Open-topic discussion** (not step-focused), easy pace, the people you've shared the week with.",
    etPt: "10:00 AM ET / 7:00 AM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🌙 Friday KA — 9:00 PM ET (Step)",
    embedTitle: "KA — Friday Evening Step",
    cron: "55 20 * * 5",
    color: "#B19CD9",
    cuttly: "https://cutt.ly/8tgmCNjd",
    zoom: "https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1",
    opener:
      "Friday night, sober and showing up. We work **one of KA's 12 Steps** tonight — bring whatever you've got, leave a little lighter.",
    etPt: "9:00 PM ET / 6:00 PM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "🪴 Saturday KA — 1:00 PM ET (Step)",
    embedTitle: "KA — Saturday Afternoon Step",
    cron: "55 12 * * 6",
    color: "#6CB2A8",
    cuttly: "https://cutt.ly/xtgmVDlr",
    zoom: "https://us06web.zoom.us/j/83187735602?pwd=dn36p4BHboNxaAZLrbbS7yAKlsRemV.1",
    opener:
      "Saturday afternoon, when the cravings creep and the day stretches long. We work **one of KA's 12 Steps** together — turns out, that counts as something to do. Show up however you are.",
    etPt: "1:00 PM ET / 10:00 AM PT",
    bullets: STEP_BULLETS,
  },
  {
    name: "🌅 Saturday KA — 5:00 PM ET (Discussion)",
    embedTitle: "KA — Saturday Evening Discussion",
    cron: "55 16 * * 6",
    color: "#C97B5C",
    cuttly: "https://cutt.ly/xtgmVDlr",
    zoom: "https://us06web.zoom.us/j/83187735602?pwd=dn36p4BHboNxaAZLrbbS7yAKlsRemV.1",
    opener:
      "Saturday dinner-hour check-in. **Open-topic discussion** (not step-focused) — show up with whatever's on top. Venting allowed, celebrating encouraged, listening welcome.",
    etPt: "5:00 PM ET / 2:00 PM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🪴 Sunday KA — 1:00 PM ET (Discussion)",
    embedTitle: "KA — Sunday Afternoon Discussion",
    cron: "55 12 * * 0",
    color: "#8FA86D",
    cuttly: "https://cutt.ly/xtgmVDlr",
    zoom: "https://us06web.zoom.us/j/83187735602?pwd=dn36p4BHboNxaAZLrbbS7yAKlsRemV.1",
    opener:
      "Sunday afternoon, the soft edge of the weekend. Squeeze in an **open-topic discussion** with the people in your corner before Monday shows up — easy pace.",
    etPt: "1:00 PM ET / 10:00 AM PT",
    bullets: DISCUSSION_BULLETS,
  },
  {
    name: "🌅 Sunday KA — 5:00 PM ET (Step)",
    embedTitle: "KA — Sunday Evening Step",
    cron: "55 16 * * 0",
    color: "#5B8BB0",
    cuttly: "https://cutt.ly/xtgmVDlr",
    zoom: "https://us06web.zoom.us/j/83187735602?pwd=dn36p4BHboNxaAZLrbbS7yAKlsRemV.1",
    opener:
      "Cap the weekend with a step. We focus on **one of KA's 12 Steps** tonight — Sunday-evening doom-scrolling can wait. Show up however you are, leave a little steadier.",
    etPt: "5:00 PM ET / 2:00 PM PT",
    bullets: STEP_BULLETS,
  },
];

async function main() {
  // Verify the guild exists so we fail loudly before inserting 15 orphan rows.
  const guild = await prisma.guild.findUnique({ where: { id: GUILD_ID! } });
  if (!guild) {
    console.error(
      `Guild ${GUILD_ID} not found in DB. The bot needs to be in that server first so the guild row exists.`
    );
    process.exit(1);
  }

  const guildTimezone = guild.timezone;

  console.log(`Seeding ${POSTS.length} KA meetings into guild ${guild.name} (${GUILD_ID})...`);
  console.log(`Channel: ${CHANNEL_ID}`);
  console.log(`Timezone: ${guildTimezone}`);
  console.log("");

  for (const p of POSTS) {
    const nextFireAt = computeNextFireAt({
      cron: p.cron,
      runAt: null,
      timezone: null,
      guildTimezone,
    });
    const content = body({
      opener: p.opener,
      etPt: p.etPt,
      cuttly: p.cuttly,
      zoom: p.zoom,
      bullets: p.bullets,
    });
    // Match by (guildId, name) — these are effectively the natural key for
    // the seeded posts. On update we deliberately leave `embedImage`,
    // `mentionRoleId`, and `channelIds` alone so admin edits in the dashboard
    // survive a re-run.
    const existing = await prisma.scheduledPost.findFirst({
      where: { guildId: GUILD_ID!, name: p.name },
      select: { id: true },
    });
    const sharedData = {
      cron: p.cron,
      timezone: null,
      useEmbed: true,
      content,
      embedTitle: p.embedTitle,
      embedColor: p.color,
      // Embed Link = the cutt.ly so clicking the title goes through the
      // stable short URL, not the raw Zoom URL.
      embedUrl: p.cuttly,
      leadMinutes: 5,
      active: true,
      nextFireAt,
    };
    const action = existing ? "↻ updated" : "✓ created";
    if (existing) {
      await prisma.scheduledPost.update({ where: { id: existing.id }, data: sharedData });
    } else {
      await prisma.scheduledPost.create({
        data: {
          ...sharedData,
          guildId: GUILD_ID!,
          channelIds: [CHANNEL_ID!],
          name: p.name,
          embedImage: null,
          mentionRoleId: null,
        },
      });
    }
    const nextStr = nextFireAt ? nextFireAt.toLocaleString("en-US", { timeZone: guildTimezone }) : "never";
    console.log(`  ${action}: ${p.name} — next fires ${nextStr}`);
  }

  console.log("");
  console.log("Done. Add an image URL to each post via the dashboard if you want one.");
  console.log("Color chart is in KA_MEETINGS.md.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
