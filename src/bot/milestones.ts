// Handles button clicks on the milestone-claim message. Looks up the clicked
// tier in the DB, swaps the user's roles atomically (remove all other tiers in
// the same guild, add this one), and acknowledges with an ephemeral reply.

import { Events, MessageFlags, type Client, type Interaction } from "discord.js";
import { prisma } from "@/lib/db";

const CUSTOM_ID_PREFIX = "milestone:";

const DEFAULT_EPHEMERAL =
  "{emoji} You've claimed **{tier}** — every day you showed up to earn this matters. We're proud of you. Keep going.";

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
        await interaction.editReply({
          content: "This milestone button is no longer valid. Ask an admin to republish the message.",
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
      const template = config?.ephemeralTemplate || DEFAULT_EPHEMERAL;
      const message = template
        .replace(/\{tier\}/g, tier.label)
        .replace(/\{emoji\}/g, tier.emoji);
      await interaction.editReply({ content: message });

      // Optional congrats post in a public channel — fire-and-forget so a
      // misconfigured channel never breaks the role claim itself.
      // Per-tier template wins over the config-level one.
      const congratsText = tier.congratsTemplate || config?.congratsTemplate;
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
