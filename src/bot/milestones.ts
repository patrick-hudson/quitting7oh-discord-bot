// Handles button clicks on the milestone-claim message. Looks up the clicked
// tier in the DB, swaps the user's roles atomically (remove all other tiers in
// the same guild, add this one), and acknowledges with an ephemeral reply.

import { Events, MessageFlags, type Client, type Interaction } from "discord.js";
import { prisma } from "@/lib/db";

const CUSTOM_ID_PREFIX = "milestone:";

const DEFAULT_EPHEMERAL =
  "{emoji} You've claimed **{tier}** — every day you showed up to earn this matters. We're proud of you. Keep going.";

// Pick a random entry from a roster, avoiding the index used last time.
// Returns null when the roster is empty so callers can fall back to a default.
function pickFromRoster(
  roster: string[],
  lastIndex: number | null | undefined
): { template: string; index: number } | null {
  if (roster.length === 0) return null;
  if (roster.length === 1) return { template: roster[0], index: 0 };
  const candidates: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    if (i !== lastIndex) candidates.push(i);
  }
  const idx = candidates[Math.floor(Math.random() * candidates.length)];
  return { template: roster[idx], index: idx };
}

export function registerMilestoneHandler(client: Client) {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(CUSTOM_ID_PREFIX)) return;
    if (!interaction.inGuild()) return;

    const tierId = interaction.customId.slice(CUSTOM_ID_PREFIX.length);
    // ACK within Discord's 3s interaction window. Role swaps + DB lookups
    // below can take longer than that, so we defer up front and editReply
    // when the work is done.
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.warn("[milestones] deferReply failed (interaction likely expired):", err);
      return;
    }
    try {
      const tier = await prisma.milestoneTier.findUnique({ where: { id: tierId } });
      if (!tier || tier.guildId !== interaction.guildId) {
        // Diagnostic — we sometimes see this on rapid clicks even though
        // re-clicking works. Logging context to figure out whether the tier
        // is truly missing or this is a transient lookup miss.
        const guildTierCount = interaction.guildId
          ? await prisma.milestoneTier.count({ where: { guildId: interaction.guildId } })
          : -1;
        console.warn(
          `[milestones] tier lookup miss: tierId=${tierId} userId=${interaction.user.id} guildId=${interaction.guildId} tierFound=${Boolean(tier)} guildTierCount=${guildTierCount}`
        );
        await interaction.editReply({
          content:
            "Hmm — couldn't claim that one. Try clicking again. If it keeps failing, an admin may need to republish the message.",
        });
        return;
      }

      // Every other tier in this guild — these get removed from the member.
      const otherTiers = await prisma.milestoneTier.findMany({
        where: { guildId: tier.guildId, NOT: { id: tier.id } },
        select: { roleId: true },
      });

      const guild = interaction.guild;
      if (!guild) return;
      const member = await guild.members.fetch(interaction.user.id);

      const heldOtherRoles = otherTiers
        .map((t) => t.roleId)
        .filter((rid) => member.roles.cache.has(rid));

      // Already on this tier — let them know and bail.
      if (member.roles.cache.has(tier.roleId) && heldOtherRoles.length === 0) {
        await interaction.editReply({
          content: `You already have the **${tier.label}** role.`,
        });
        return;
      }

      for (const roleId of heldOtherRoles) {
        await member.roles.remove(roleId, "Milestone role swap");
      }
      await member.roles.add(tier.roleId, "Milestone role claim");

      const config = await prisma.milestoneConfig.findUnique({
        where: { guildId: tier.guildId },
      });

      // Ephemeral roster — falls through to the baked-in default when empty.
      const ephemeralPick = pickFromRoster(
        config?.ephemeralTemplates ?? [],
        config?.lastEphemeralIndex
      );
      const ephemeralTemplate = ephemeralPick?.template ?? DEFAULT_EPHEMERAL;
      const message = ephemeralTemplate
        .replace(/\{tier\}/g, tier.label)
        .replace(/\{emoji\}/g, tier.emoji);
      await interaction.editReply({ content: message });
      if (ephemeralPick && config) {
        prisma.milestoneConfig
          .update({
            where: { guildId: config.guildId },
            data: { lastEphemeralIndex: ephemeralPick.index },
          })
          .catch((err: unknown) =>
            console.warn("[milestones] lastEphemeralIndex update failed:", err)
          );
      }

      // Optional congrats post in a public channel — fire-and-forget so a
      // misconfigured channel never breaks the role claim itself.
      // Per-tier roster wins over the config-level one.
      const tierPick = pickFromRoster(tier.congratsTemplates, tier.lastCongratsIndex);
      const configPick = tierPick
        ? null
        : pickFromRoster(config?.congratsTemplates ?? [], config?.lastCongratsIndex);
      const congratsText = tierPick?.template ?? configPick?.template ?? null;
      if (config?.congratsEnabled && config.congratsChannelId && congratsText) {
        try {
          const channel = await client.channels.fetch(config.congratsChannelId);
          if (channel && channel.isTextBased() && "send" in channel) {
            // Always include a pointer to the claim channel. If the template
            // has {claimChannel} we use the author's placement; otherwise we
            // append a default line on a new line.
            const hasClaimPlaceholder = /\{claimChannel\}/.test(congratsText);
            let text = congratsText
              .replace(/\{user\}/g, `<@${interaction.user.id}>`)
              .replace(/\{tier\}/g, tier.label)
              .replace(/\{emoji\}/g, tier.emoji)
              .replace(
                /\{claimChannel\}/g,
                config.channelId ? `<#${config.channelId}>` : ""
              );
            if (!hasClaimPlaceholder && config.channelId) {
              text += `\nClaim yours in <#${config.channelId}>.`;
            }
            await channel.send({
              content: text,
              allowedMentions: { users: [interaction.user.id] },
            });
          }
        } catch (err) {
          console.warn("[milestones] congrats send failed:", err);
        }
      }

      // Persist which roster entry we just used. Fire-and-forget — losing a
      // last-index write would just mean one possible repeat next time.
      if (tierPick) {
        prisma.milestoneTier
          .update({
            where: { id: tier.id },
            data: { lastCongratsIndex: tierPick.index },
          })
          .catch((err: unknown) =>
            console.warn("[milestones] tier lastCongratsIndex update failed:", err)
          );
      } else if (configPick && config) {
        prisma.milestoneConfig
          .update({
            where: { guildId: config.guildId },
            data: { lastCongratsIndex: configPick.index },
          })
          .catch((err: unknown) =>
            console.warn("[milestones] config lastCongratsIndex update failed:", err)
          );
      }
    } catch (err) {
      console.error("[milestones] interaction failed:", err);
      // Best-effort surfacing — we already deferred, so editReply is the
      // primary path; fall back to followUp if something edited it already.
      try {
        const msg =
          err instanceof Error && err.message.includes("Missing Permissions")
            ? "I don't have permission to manage this role. Ask an admin to move my role above the milestone roles."
            : "Something went wrong claiming that milestone. Try again in a sec.";
        if (interaction.deferred) {
          await interaction.editReply({ content: msg });
        } else if (interaction.replied) {
          await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // swallow — the original error is already logged
      }
    }
  });
}
