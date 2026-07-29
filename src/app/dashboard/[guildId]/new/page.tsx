import { PostForm, type PostFormValues } from "@/components/PostForm";
import { StarterPicker } from "@/components/StarterPicker";
import { prisma } from "@/lib/db";

// New-post page. `?from=<postId>` imports an existing post's config as the
// starting point — the id is deliberately omitted from `initial` so saving
// always CREATES a new post, never edits the source.

export default async function NewPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { guildId } = await params;
  const { from } = await searchParams;
  const [guild, posts] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.scheduledPost.findMany({
      where: { guildId },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  // Load the starter post, if requested and it belongs to this guild.
  const source = from
    ? await prisma.scheduledPost.findUnique({ where: { id: from } })
    : null;
  const starter = source && source.guildId === guildId ? source : null;

  const initial: Partial<PostFormValues> | undefined = starter
    ? {
        // No `id` — that's what makes this an import-as-starter, not an edit.
        name: `${starter.name} (copy)`,
        channelIds: starter.channelIds,
        scheduleKind: starter.cron ? "cron" : "oneoff",
        cron: starter.cron ?? "",
        runAt: starter.runAt ? starter.runAt.toISOString() : "",
        timezone: starter.timezone ?? guild?.timezone ?? "America/New_York",
        useEmbed: starter.useEmbed,
        content: starter.content,
        embedTitle: starter.embedTitle ?? "",
        embedColor: starter.embedColor ?? "#5865F2",
        embedUrl: starter.embedUrl ?? "",
        embedImage: starter.embedImage ?? "",
        mentionRoleId: starter.mentionRoleId ?? "",
        leadMinutes: starter.leadMinutes,
        reminderMinutes: starter.reminderMinutes,
        reminderContent: starter.reminderContent ?? "",
        active: starter.active,
      }
    : undefined;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">New scheduled post</h1>
      <p className="mt-1 text-sm text-white/60">
        Define when the bot should post and what the message should say.
      </p>

      {posts.length > 0 && (
        <div className="mt-6">
          <StarterPicker
            guildId={guildId}
            posts={posts}
            currentFrom={starter?.id ?? ""}
          />
        </div>
      )}

      <div className="mt-6">
        {/* Key on the starter id so switching starters remounts the form with
            fresh initial values instead of merging into stale state. */}
        <PostForm
          key={starter?.id ?? "blank"}
          guildId={guildId}
          initial={initial}
          initiallyDirty={Boolean(starter)}
          guildTimezone={guild?.timezone ?? "America/New_York"}
        />
      </div>
    </div>
  );
}
