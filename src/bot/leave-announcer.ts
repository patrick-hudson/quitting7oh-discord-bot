// Posts a configurable message when a member leaves the server. Event-driven
// (GuildMemberRemove) — no polling. Fires for voluntary leaves, kicks, and
// bans alike; Discord doesn't distinguish them in this event, and we
// deliberately post the same message for all three.
//
// Requires the GuildMembers privileged intent (already enabled for the
// milestone features) and Partials.GuildMember on the client — without the
// partial, discord.js drops the event for members that weren't in the cache.

import {
  Events,
  type Client,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { prisma } from "@/lib/db";
import { LEAVE_TEMPLATES } from "@/lib/leave-templates";

// Pick a random entry, avoiding the index used last time. Same shape as the
// reminder/milestone roster pickers.
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

export function registerLeaveAnnouncer(client: Client) {
  client.on(
    Events.GuildMemberRemove,
    async (member: GuildMember | PartialGuildMember) => {
      try {
        const config = await prisma.guild.findUnique({
          where: { id: member.guild.id },
          select: {
            leaveEnabled: true,
            leaveChannelId: true,
            leaveTemplates: true,
            lastLeaveIndex: true,
          },
        });
        if (!config?.leaveEnabled || !config.leaveChannelId) return;

        // The user object survives even on partial members; fall back safely.
        const name =
          member.user?.globalName || member.user?.username || "A member";
        // memberCount reflects the state after the removal.
        const count = member.guild.memberCount;
        // Masked profile link — bots may use markdown links in plain content,
        // and discord.com/users/<id> opens the profile in-app. This stays
        // clickable after the member leaves, unlike a <@id> mention (which
        // degrades to @unknown-user once they're gone).
        const profile = `[${name}](https://discord.com/users/${member.id})`;

        const roster =
          config.leaveTemplates.length > 0 ? config.leaveTemplates : LEAVE_TEMPLATES;
        const pick = pickTemplate(roster, config.lastLeaveIndex);
        const content = pick.template
          .replaceAll("{profile}", profile)
          .replaceAll("{user}", name)
          .replaceAll("{count}", String(count));

        const channel = await client.channels.fetch(config.leaveChannelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          console.warn(
            `[leave] channel ${config.leaveChannelId} in ${member.guild.id} not sendable`
          );
          return;
        }
        await channel.send({ content });

        await prisma.guild
          .update({
            where: { id: member.guild.id },
            data: { lastLeaveIndex: pick.index },
          })
          .catch((err) =>
            console.warn(`[leave] lastLeaveIndex update failed:`, err)
          );
      } catch (err) {
        console.error(`[leave] failed for guild ${member.guild.id}:`, err);
      }
    }
  );
}
