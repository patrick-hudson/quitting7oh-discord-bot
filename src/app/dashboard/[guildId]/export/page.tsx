import { listTextChannels } from "@/lib/discord-rest";
import { prisma } from "@/lib/db";
import { ExportForm } from "@/components/ExportForm";
import { UserExportForm } from "@/components/UserExportForm";
import { LocalTime } from "@/components/LocalTime";

export default async function ExportPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [channels, guild, archiveStates] = await Promise.all([
    listTextChannels(guildId).catch(() => []),
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.archiveChannelState.findMany({
      where: { guildId },
      orderBy: { channelName: "asc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Channel export</h1>
      <p className="mt-1 text-sm text-white/60">
        Download a Markdown archive of one or more channels — full message history,
        with mentions resolved to readable names, custom emojis linked to their
        Discord CDN URLs, and attachments preserved as links.
      </p>
      <p className="mt-3 text-xs text-white/40">
        The bot needs <strong>View Channel</strong> and <strong>Read Message
        History</strong> permission on each channel you select. Large channels
        (10k+ messages) may take a minute — the request streams when it&apos;s
        done. The export caps per-channel history at 10,000 messages by default.
      </p>

      <div className="mt-8">
        <ExportForm
          guildId={guildId}
          channels={channels.map((c) => ({ id: c.id, name: c.name }))}
        />
      </div>

      <div className="mt-12 border-t border-white/10 pt-8">
        <h2 className="text-xl font-semibold tracking-tight">Export a user&apos;s messages</h2>
        <p className="mt-1 text-sm text-white/60">
          Collect everything one member has posted — across all channels or a
          subset, optionally bounded by date — into a Markdown zip. Runs as a
          background job; the bot DMs you a download link when it finishes.
        </p>
        <p className="mt-3 text-xs text-white/40">
          Scans channel history via Discord&apos;s API, so large servers take a
          while. Only messages still visible to the bot are included — deleted
          messages can&apos;t be recovered. Exports are kept for 7 days.
        </p>

        <div className="mt-6">
          <UserExportForm
            guildId={guildId}
            channels={channels.map((c) => ({ id: c.id, name: c.name }))}
          />
        </div>
      </div>

      <div className="mt-12 border-t border-white/10 pt-8">
        <h2 className="text-xl font-semibold tracking-tight">Full message archive</h2>
        <p className="mt-1 text-sm text-white/60">
          {guild?.archiveEnabled
            ? "Continuous archive is enabled — the bot copies every channel's history (messages + attachment files) to archive storage, catching up hourly."
            : "Continuous archive is disabled. Enable it in Settings to keep a disaster-recovery copy of all message history."}
        </p>

        {archiveStates.length > 0 && (
          <>
            <ul className="mt-4 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
              {archiveStates.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 bg-white/[0.02] px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate text-white/80">
                    #{s.channelName}
                  </span>
                  <span className="shrink-0 text-xs text-white/40">
                    {s.archivedCount.toLocaleString()} msgs · {s.mediaCount}{" "}
                    files ·{" "}
                    {(Number(s.mediaBytes) / (1024 * 1024)).toFixed(1)} MB
                  </span>
                  <LocalTime
                    iso={s.updatedAt.toISOString()}
                    className="shrink-0 font-mono text-[11px] text-white/30"
                  />
                  <a
                    href={`/api/guilds/${guildId}/archive/${s.channelId}/download`}
                    className="shrink-0 rounded-md px-2.5 py-1 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/5"
                  >
                    JSONL
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-white/40">
              Attachment files live alongside the JSONL in the archive volume
              (<code className="text-white/60">media/</code> per guild) — pull
              them with your server backup, not through the browser.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
