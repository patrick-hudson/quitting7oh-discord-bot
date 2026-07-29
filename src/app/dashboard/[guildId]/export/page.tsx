import { listTextChannels } from "@/lib/discord-rest";
import { ExportForm } from "@/components/ExportForm";
import { UserExportForm } from "@/components/UserExportForm";

export default async function ExportPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const channels = await listTextChannels(guildId).catch(() => []);

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
    </div>
  );
}
