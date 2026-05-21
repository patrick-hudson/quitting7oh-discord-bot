import { PostForm } from "@/components/PostForm";
import { prisma } from "@/lib/db";

export default async function NewPostPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">New scheduled post</h1>
      <p className="mt-1 text-sm text-white/60">
        Define when the bot should post and what the message should say.
      </p>
      <div className="mt-8">
        <PostForm
          guildId={guildId}
          guildTimezone={guild?.timezone ?? "America/New_York"}
        />
      </div>
    </div>
  );
}
