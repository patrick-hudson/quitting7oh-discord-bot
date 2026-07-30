// DMs a welcome message to members when they join. Event-driven, fires on
// every join including rejoins (deliberate — returning members get a warm
// re-welcome). Members whose DMs are closed (error 50007) or who block the
// bot are silently skipped, per design: no public fallback ping.
//
// Membership-screening aware: if the guild uses rules screening, members
// arrive with `pending = true` and can't receive server-member DMs dependably
// (and may never finish joining). Those get their DM when screening completes
// (the pending → false transition on GuildMemberUpdate) instead of on join.

import {
  Events,
  type Client,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { prisma } from "@/lib/db";
import { WELCOME_TEMPLATES } from "@/lib/welcome-templates";

// Same anti-repeat roster picker as the leave/reminder features.
function pickTemplate(
  roster: string[],
  lastIndex: number | null
): { template: string; index: number } {
  if (roster.length === 1) return { template: roster[0], index: 0 };
  const candidates: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    if (i !== lastIndex) candidates.push(i);
  }
  const index = candidates[Math.floor(Math.random() * candidates.length)];
  return { template: roster[index], index };
}

// Discord's "Cannot send messages to this user" — DMs closed or bot blocked.
const CANNOT_DM = 50007;

export function registerWelcomeDm(client: Client) {
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    if (member.user.bot) return;
    // Screening gate: pending members get welcomed on completion instead.
    if (member.pending) return;
    await sendWelcome(member);
  });

  client.on(
    Events.GuildMemberUpdate,
    async (
      oldMember: GuildMember | PartialGuildMember,
      newMember: GuildMember
    ) => {
      if (newMember.user.bot) return;
      // Only the pending → false transition (screening completed). Partial
      // old members have pending unknown — treat only an explicit true as
      // "was pending" so we never double-send after an unrelated update.
      if (oldMember.pending === true && newMember.pending === false) {
        await sendWelcome(newMember);
      }
    }
  );
}

async function sendWelcome(member: GuildMember) {
  try {
    const config = await prisma.guild.findUnique({
      where: { id: member.guild.id },
      select: {
        welcomeDmEnabled: true,
        welcomeDmTemplates: true,
        lastWelcomeDmIndex: true,
      },
    });
    if (!config?.welcomeDmEnabled) return;

    const roster =
      config.welcomeDmTemplates.length > 0
        ? config.welcomeDmTemplates
        : WELCOME_TEMPLATES;
    const pick = pickTemplate(roster, config.lastWelcomeDmIndex);
    const name = member.user.globalName || member.user.username;
    const content = pick.template
      .replaceAll("{user}", name)
      .replaceAll("{server}", member.guild.name);

    try {
      await member.send({ content });
    } catch (err) {
      // Silent skip on closed DMs / blocks, by design. Log at info level so
      // "why didn't X get a welcome" is answerable from the logs.
      const code = (err as { code?: number } | null)?.code;
      if (code === CANNOT_DM) {
        console.log(
          `[welcome] ${member.user.tag} (${member.id}) has DMs closed — skipped`
        );
        return;
      }
      throw err;
    }

    await prisma.guild
      .update({
        where: { id: member.guild.id },
        data: { lastWelcomeDmIndex: pick.index },
      })
      .catch((err) =>
        console.warn("[welcome] lastWelcomeDmIndex update failed:", err)
      );
    console.log(`[welcome] DMed ${member.user.tag} (${member.guild.name})`);
  } catch (err) {
    console.error(`[welcome] failed for guild ${member.guild.id}:`, err);
  }
}
