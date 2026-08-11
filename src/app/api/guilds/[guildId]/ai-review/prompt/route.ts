// Per-guild override for the AI reviewer's ENTIRE system prompt. PUT saves it
// (empty string clears the override → the baked-in default rubric is used
// again). The default lives in src/lib/ai-review.ts (DEFAULT_REVIEW_PROMPT).

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const schema = z.object({ prompt: z.string().max(20000) });

export const PUT = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const { prompt } = schema.parse(await req.json());
  const trimmed = prompt.trim();
  const value = trimmed.length > 0 ? trimmed : null;

  await prisma.guild.update({
    where: { id: guildId },
    data: { aiReviewPrompt: value },
  });
  audit(
    guildId,
    "aireview.prompt_updated",
    value ? "AI reviewer prompt customized" : "AI reviewer prompt reset to default",
    { by: session.user.discordId, custom: value !== null }
  );

  return NextResponse.json({ ok: true, custom: value !== null });
});
