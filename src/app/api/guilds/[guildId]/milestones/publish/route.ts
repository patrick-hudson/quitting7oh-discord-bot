import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import {
  buttonsToRows,
  editButtonMessage,
  sendButtonMessage,
} from "@/lib/discord-rest";

// POST — publishes (or re-publishes) the milestone-claim message to Discord.
// If a previous message exists, edits it in place; otherwise sends a new one
// and stores the resulting messageId.
export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const config = await prisma.milestoneConfig.findUnique({ where: { guildId } });
  if (!config || !config.channelId) {
    return NextResponse.json(
      { error: "Pick a channel and save before publishing." },
      { status: 400 }
    );
  }

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });
  if (tiers.length === 0) {
    return NextResponse.json({ error: "Add at least one milestone tier first." }, { status: 400 });
  }

  const buttons = tiers.map((t) => ({
    type: 2 as const,
    style: 2 as const, // secondary — neutral gray; let emoji+label do the work
    label: t.label,
    custom_id: `milestone:${t.id}`,
    emoji: { name: t.emoji },
  }));
  // Self-service quiet reset — removes the member's milestone role(s) with no
  // announcement. "reset" is a reserved custom_id suffix (tier ids are cuids,
  // which can never equal it). Note: Discord caps a message at 25 buttons, so
  // with the reset button the practical tier limit is 24.
  buttons.push({
    type: 2 as const,
    style: 2 as const,
    label: "Start over (reset my milestone)",
    custom_id: "milestone:reset",
    emoji: { name: "↩️" },
  });
  const rows = buttonsToRows(buttons);
  const embed = {
    title: config.title,
    description: config.description,
    color: 0x5865f2,
  };

  let messageId: string;
  if (config.messageId) {
    try {
      const msg = await editButtonMessage(config.channelId, config.messageId, embed, rows);
      messageId = msg.id;
    } catch (err) {
      // Message was likely deleted in Discord — fall back to sending a new one.
      console.warn("[milestones] edit failed, sending fresh:", err);
      const msg = await sendButtonMessage(config.channelId, embed, rows);
      messageId = msg.id;
    }
  } else {
    const msg = await sendButtonMessage(config.channelId, embed, rows);
    messageId = msg.id;
  }

  const updated = await prisma.milestoneConfig.update({
    where: { guildId },
    data: { messageId },
  });

  return NextResponse.json({ config: updated });
});
