import { notFound } from "next/navigation";
import { PostForm, type PostFormValues } from "@/components/PostForm";
import { prisma } from "@/lib/db";

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id } = await params;
  const [guild, post] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.scheduledPost.findUnique({ where: { id } }),
  ]);
  if (!post || post.guildId !== guildId) notFound();

  // Pass the raw ISO string; PostForm converts to the browser's local
  // `datetime-local` representation on mount.
  const initial: Partial<PostFormValues> = {
    id: post.id,
    name: post.name,
    channelIds: post.channelIds,
    scheduleKind: post.cron ? "cron" : "oneoff",
    cron: post.cron ?? "",
    runAt: post.runAt ? post.runAt.toISOString() : "",
    timezone: post.timezone ?? guild?.timezone ?? "America/New_York",
    useEmbed: post.useEmbed,
    content: post.content,
    embedTitle: post.embedTitle ?? "",
    embedColor: post.embedColor ?? "#5865F2",
    embedUrl: post.embedUrl ?? "",
    embedImage: post.embedImage ?? "",
    mentionRoleId: post.mentionRoleId ?? "",
    leadMinutes: post.leadMinutes,
    skipIfRecentWithin: post.skipIfRecentWithin,
    reminderMinutes: post.reminderMinutes,
    reminderContent: post.reminderContent ?? "",
    active: post.active,
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Edit post</h1>
      <p className="mt-1 text-sm text-white/60">{post.name}</p>
      <div className="mt-8">
        <PostForm
          guildId={guildId}
          initial={initial}
          guildTimezone={guild?.timezone ?? "America/New_York"}
        />
      </div>
    </div>
  );
}
