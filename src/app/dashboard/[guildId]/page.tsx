import Link from "next/link";
import { prisma } from "@/lib/db";
import { PostRow } from "@/components/PostRow";
import { listTextChannels } from "@/lib/discord-rest";

export default async function PostsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [posts, channels] = await Promise.all([
    prisma.scheduledPost.findMany({
      where: { guildId },
      orderBy: [{ active: "desc" }, { nextFireAt: "asc" }, { createdAt: "desc" }],
    }),
    listTextChannels(guildId).catch(() => []),
  ]);
  const channelNames: Record<string, string> = Object.fromEntries(
    channels.map((c) => [c.id, c.name])
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scheduled Posts</h1>
          <p className="mt-1 text-sm text-white/60">
            Messages the bot will post into Discord channels on a schedule.
          </p>
        </div>
        <Link
          href={`/dashboard/${guildId}/new`}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)]"
        >
          + New Post
        </Link>
      </div>

      {posts.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-white/70">No scheduled posts yet.</p>
          <Link
            href={`/dashboard/${guildId}/new`}
            className="mt-4 inline-block text-sm text-[color:var(--color-brand-500)] hover:underline"
          >
            Create your first one →
          </Link>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
          {posts.map((p) => (
            <PostRow key={p.id} post={p} guildId={guildId} channelNames={channelNames} />
          ))}
        </ul>
      )}
    </div>
  );
}
