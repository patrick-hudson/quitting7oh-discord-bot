import Link from "next/link";
import { prisma } from "@/lib/db";
import { listRoles, listTextChannels } from "@/lib/discord-rest";
import { THEMES } from "@/lib/milestone-themes";
import { MilestoneForm } from "@/components/MilestoneForm";
import { MilestoneResetForm } from "@/components/MilestoneResetForm";

const DEFAULT_TIERS = [
  {
    label: "24 hours",
    emoji: "⏰",
    congratsTemplates: [
      "{emoji} {user} just made it through day one — the hardest day. We see you. Keep showing up.",
      "{emoji} {user} hit **24 hours** clean. The first day is the hardest day. You did the hard thing.",
      "{emoji} Day one in the books for {user}. Withdrawal isn't pretty and you stayed anyway. That counts for everything.",
      "{emoji} {user} just claimed **24 hours**. One foot in front of the other got you here. Same plan tomorrow.",
      "{emoji} A full day clean for {user}. Whatever you did to get through today — do that again tomorrow. We're with you.",
      "{emoji} {user} made it through the first 24. Welcome to day two. We're glad you're here.",
      "{emoji} **24 hours** for {user}. That's not nothing — that's the whole foundation. Keep going.",
    ],
  },
  {
    label: "3 days",
    emoji: "💪",
    congratsTemplates: [
      "{emoji} {user} hit **3 days**. Three of the hardest mornings in a row — your brain is healing right now. Don't stop now.",
      "{emoji} **72 hours** for {user}. The first three days are usually the worst. You're past the worst. Don't quit before the miracle.",
      "{emoji} {user} crossed **3 days** clean. Your body's doing things you can't feel yet. Trust it.",
      "{emoji} Three days down for {user}. The cravings get quieter from here, not louder. Stay close to people.",
      "{emoji} {user} just hit **day 3**. Three mornings of waking up and choosing this. Proud of you.",
      "{emoji} **3 days** clean for {user}. The fog hasn't lifted yet but it will. Keep showing up.",
      "{emoji} {user} hit the **3-day** mark — the acute window most people break in. You didn't break.",
    ],
  },
  {
    label: "1 week",
    emoji: "🌤️",
    congratsTemplates: [
      "{emoji} {user} crossed **1 WEEK** clean. Seven days of choosing yourself when every part of you wanted to quit choosing. The fog is starting to lift — keep going.",
      "{emoji} **One week** for {user}. Seven mornings, seven nights, seven choices to stay. That's the work.",
      "{emoji} {user} just claimed **7 days**. The first week is no joke and you made it. Sleep should start coming back soon.",
      "{emoji} A full **week** clean for {user}. Your nervous system is starting to reset. Be patient with yourself.",
      "{emoji} {user} hit **1 week**. Worth marking — most people who try don't make it this far. You did.",
      "{emoji} Seven days down for {user}. The cravings come in waves; they also pass in waves. Keep riding them out.",
      "{emoji} **{tier}** for {user}. A week's worth of small decisions stacked into something real. Keep going.",
    ],
  },
  {
    label: "2 weeks",
    emoji: "🌈",
    congratsTemplates: [
      "{emoji} {user} hit **2 WEEKS**. The acute fight is winding down and you're still standing. That's everything. You're doing this.",
      "{emoji} **14 days** for {user}. Two weeks of doing the hardest thing you've ever done. Don't underestimate that.",
      "{emoji} {user} crossed **2 weeks** clean. Sleep, appetite, mood — they all start coming back around now. Notice the wins.",
      "{emoji} Two weeks for {user}. The fog is real and it's lifting. You're doing this.",
      "{emoji} {user} just hit **{tier}**. Half a month of choosing yourself over the easy thing. Massive.",
      "{emoji} **2 weeks** in the books for {user}. The worst of the withdrawal is behind you. Keep stacking days.",
      "{emoji} {user} claimed **two weeks**. Your brain's been busy rewiring this whole time. The hard part's paying off.",
    ],
  },
  {
    label: "30 days",
    emoji: "🌱",
    congratsTemplates: [
      "{emoji} {user} hit **30 days**. A full month of choosing yourself, every day. Proud of you.",
      "{emoji} **30 days** clean for {user}. A whole month. That's not a fluke — that's discipline showing up daily.",
      "{emoji} {user} just hit **{tier}**. One month of small honest decisions. This is what recovery looks like.",
      "{emoji} A full **month** for {user}. The acute phase is over. Now the real work starts and you're ready for it.",
      "{emoji} {user} crossed **30 days**. Whatever excuse the addict voice has tried, you've out-stubborned it 30 times in a row.",
      "{emoji} **One month** for {user}. Take stock of how much has changed — sleep, mood, mornings. It's real.",
      "{emoji} {user} claimed **30 days**. The cravings are still there but you're bigger than them now. Keep going.",
    ],
  },
  {
    label: "60 days",
    emoji: "🌿",
    congratsTemplates: [
      "{emoji} {user} just crossed **60 days**. Two months in, and the roots are taking hold.",
      "{emoji} **{tier}** for {user}. Two months. New habits are forming, old ones are starving. Stay the course.",
      "{emoji} {user} hit **60 days** clean. The shape of your life is changing. Notice it. Be proud.",
      "{emoji} Two months for {user}. The \"this is who I am now\" version of you is starting to show up. Trust it.",
      "{emoji} {user} just claimed **{tier}**. Past the danger zone, into the build-something-real zone. Keep going.",
      "{emoji} **60 days** for {user}. Anyone can quit for a day. You've done it sixty times in a row.",
      "{emoji} {user} crossed **two months**. The fog should be gone by now. Look at what's actually possible.",
    ],
  },
  {
    label: "90 days",
    emoji: "🌳",
    congratsTemplates: [
      "{emoji} {user} reached **90 days** — a quarter year clean. That's real, durable progress.",
      "{emoji} **{tier}** for {user}. Ninety days is a milestone for a reason — your brain is genuinely different now.",
      "{emoji} {user} hit **90 days**. The dopamine system is rebuilding. Pleasure starts coming from real things again.",
      "{emoji} A quarter year for {user}. Anyone who's been here knows what this took. Massive respect.",
      "{emoji} {user} just claimed **3 months**. You're not white-knuckling anymore — you're living. Keep going.",
      "{emoji} **{tier}** clean for {user}. The first 90 are the foundation. Everything from here builds on what you just did.",
      "{emoji} {user} crossed **90 days**. Most people relapse before this point. You're not most people.",
    ],
  },
  {
    label: "6 months",
    emoji: "💎",
    congratsTemplates: [
      "{emoji} {user} hit **6 MONTHS**. Half a year of discipline showing up. Massive respect.",
      "{emoji} **{tier}** for {user}. Half a year — long enough that this isn't a phase, it's who you are now.",
      "{emoji} {user} just crossed **6 months**. The version of you from before is barely recognizable. In the best way.",
      "{emoji} Six months clean for {user}. Quiet, steady, undeniable. This is the real work.",
      "{emoji} {user} claimed **{tier}**. Half a year of small decisions stacked into a different life. Keep going.",
      "{emoji} **6 months** for {user}. People in this community quietly point to you now as proof it's possible. Thank you.",
      "{emoji} {user} hit **six months**. The cravings are background noise at this point. You're driving.",
    ],
  },
  {
    label: "1 year",
    emoji: "🏆",
    congratsTemplates: [
      "{emoji} {user} just crossed **1 YEAR**. 365 days of choosing recovery — you're an inspiration to this whole community.",
      "{emoji} **One year** for {user}. A full trip around the sun, every season clean. This is what's possible.",
      "{emoji} {user} hit **{tier}**. 365 sunrises chosen on purpose. Take it in.",
      "{emoji} A **year** for {user}. The you from 365 days ago wouldn't have believed this. Look what you built.",
      "{emoji} {user} claimed **1 year**. Birthdays, holidays, hard nights — you stayed through all of it. Hero status.",
      "{emoji} **{tier}** clean for {user}. The whole community is better because you're in it. Thank you for being here.",
      "{emoji} {user} just crossed **365 days**. This is the milestone that changes everything downstream. Massive.",
    ],
  },
  {
    label: "2+ years",
    emoji: "👑",
    congratsTemplates: [
      "{emoji} {user} crossed **2+ YEARS**. Living proof this works. Thank you for being here and showing the way.",
      "{emoji} **{tier}** for {user}. Two years and counting. The hardest version of this is far behind you.",
      "{emoji} {user} hit **2 years** clean. You're the long-timer now. Newcomers look at you and see what's possible.",
      "{emoji} **Two+ years** for {user}. The fact that you're still here, still showing up, says everything. Thank you.",
      "{emoji} {user} just claimed **{tier}**. You did the hardest part years ago and kept going. Quiet, real, durable. Respect.",
      "{emoji} **2+ years** for {user}. The kind of milestone where the only word that fits is gratitude. Thank you for sticking around.",
      "{emoji} {user} reached **2+ years**. Recovery isn't a phase you went through — it's something you built. Keep going.",
    ],
  },
];

const DEFAULT_CONGRATS_TEMPLATES = [
  "{emoji} Big congrats to {user} on reaching **{tier}** — proud of you. Keep going.\nClaim yours in {claimChannel}.",
  "{emoji} {user} just claimed **{tier}**. Every day you keep showing up is the work. Keep it up.",
  "{emoji} Massive respect to {user} for hitting **{tier}**. This stuff is hard. You're doing it.",
  "{emoji} {user} just leveled up to **{tier}**. Each milestone is a stack of yesterdays you didn't quit. Proud of you.",
  "{emoji} Roll call — {user} just hit **{tier}**. That's another one in the win column.",
  "{emoji} {user} claimed **{tier}**. Quiet, steady, real — the kind of recovery that lasts.",
  "{emoji} Hats off to {user} for reaching **{tier}**. The hard part is showing up daily, and you have.",
  "{emoji} {user} just unlocked **{tier}**. Whatever it took to get here, keep doing that.",
  "{emoji} Big day for {user} — **{tier}** in the books. The community is rooting for you.",
  "{emoji} {user} hit **{tier}**. One more piece of evidence that recovery is possible. Thank you for being here.",
  "{emoji} Salute to {user} on **{tier}**. Sobriety isn't a phase, it's a practice. You're practicing.",
  "{emoji} {user} just earned **{tier}**. Earned is the right word — none of this happens by accident.",
  "{emoji} {user} just hit **{tier}**. Take the win — tomorrow's a fresh chance to stack another day.",
  "{emoji} {user} crossed **{tier}**. Every milestone is proof that recovery sticks. Thank you for showing up.",
  "{emoji} Today {user} hit **{tier}**. Small, important, real. Keep going.",
];

const DEFAULT_EPHEMERAL_TEMPLATES = [
  "{emoji} You've claimed **{tier}** — every day you showed up to earn this matters. We're proud of you. Keep going.",
];

export default async function MilestonesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return null;

  // Seed config if it doesn't exist yet so the form has stable data to bind to.
  let config = await prisma.milestoneConfig.findUnique({ where: { guildId } });
  if (!config) {
    config = await prisma.milestoneConfig.create({ data: { guildId } });
  }

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });

  const [channels, roles] = await Promise.all([
    listTextChannels(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
  ]);

  // Suggest defaults if the guild has no tiers yet. They're not saved until
  // the user hits "Save" — just pre-fills the form.
  const initialTiers =
    tiers.length > 0
      ? tiers.map((t) => ({
          id: t.id,
          label: t.label,
          emoji: t.emoji,
          roleId: t.roleId,
          sortOrder: t.sortOrder,
          congratsTemplates: t.congratsTemplates,
        }))
      : DEFAULT_TIERS.map((d, i) => ({
          label: d.label,
          emoji: d.emoji,
          roleId: "",
          sortOrder: i,
          congratsTemplates: d.congratsTemplates,
        }));

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Milestone roles</h1>
        <Link
          href={`/dashboard/${guildId}/milestones/advanced`}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/10"
          title="Edit every tier's congrats roster side-by-side"
        >
          Bulk-edit templates →
        </Link>
      </div>
      <p className="mt-1 text-sm text-white/60">
        Publish a single message with buttons so members can self-claim a milestone role.
        Clicking a button replaces any earlier milestone role they hold.
      </p>
      <p className="mt-3 text-xs text-white/40">
        The bot needs <strong>Manage Roles</strong> permission, and its own role must sit
        above every milestone role in this guild&apos;s role list.
      </p>

      <div className="mt-8">
        <MilestoneForm
          guildId={guildId}
          initial={{
            channelId: config.channelId ?? "",
            title: config.title,
            description: config.description,
            tiers: initialTiers,
            messageId: config.messageId,
            congratsEnabled: config.congratsEnabled,
            congratsChannelId: config.congratsChannelId ?? "",
            congratsTemplates:
              config.congratsTemplates.length > 0
                ? config.congratsTemplates
                : DEFAULT_CONGRATS_TEMPLATES,
            ephemeralTemplates:
              config.ephemeralTemplates.length > 0
                ? config.ephemeralTemplates
                : DEFAULT_EPHEMERAL_TEMPLATES,
          }}
          channels={channels.map((c) => ({ id: c.id, name: c.name }))}
          roles={roles.map((r) => ({ id: r.id, name: r.name, color: r.color }))}
          themes={THEMES}
        />
      </div>

      <div className="mt-8">
        <MilestoneResetForm guildId={guildId} />
      </div>
    </div>
  );
}
