// Bulk editor for all scheduled posts in a guild. Shows every post as a card
// with the high-leverage fields visible inline; saves via the same per-post
// PATCH endpoint as the single-post edit form (no new API surface).

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { listRoles, listTextChannels } from "@/lib/discord-rest";
import {
  PostsAdvancedForm,
  type PostRowValues,
} from "@/components/PostsAdvancedForm";

export default async function PostsAdvancedPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, posts, channels, roles] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.scheduledPost.findMany({
      where: { guildId },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    listTextChannels(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
  ]);
  if (!guild) notFound();

  const initial: PostRowValues[] = posts.map((p) => ({
    id: p.id,
    name: p.name,
    channelIds: p.channelIds,
    scheduleKind: p.cron ? "cron" : "oneoff",
    cron: p.cron ?? "",
    // Sent as an ISO string; the client converts to a local datetime-local
    // value on mount.
    runAt: p.runAt ? p.runAt.toISOString() : "",
    timezone: p.timezone ?? guild.timezone,
    useEmbed: p.useEmbed,
    content: p.content,
    embedTitle: p.embedTitle ?? "",
    embedColor: p.embedColor ?? "",
    embedUrl: p.embedUrl ?? "",
    embedImage: p.embedImage ?? "",
    mentionRoleId: p.mentionRoleId ?? "",
    leadMinutes: p.leadMinutes,
    skipIfRecentWithin: p.skipIfRecentWithin,
    reminderMinutes: p.reminderMinutes,
    reminderContent: p.reminderContent ?? "",
    active: p.active,
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bulk-edit posts</h1>
          <p className="mt-1 text-sm text-white/60">
            Every scheduled post on one page. Edit any combination of fields,
            then Save all to PATCH only the rows you changed.
          </p>
        </div>
        <Link
          href={`/dashboard/${guildId}/posts`}
          className="rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
        >
          ← Back to posts
        </Link>
      </div>

      <div className="mt-8">
        <PostsAdvancedForm
          guildId={guildId}
          initialPosts={initial}
          channels={channels.map((c) => ({
            id: c.id,
            name: c.name,
            parent_id: c.parent_id,
          }))}
          roles={roles.map((r) => ({ id: r.id, name: r.name, color: r.color }))}
        />
      </div>
    </div>
  );
}
