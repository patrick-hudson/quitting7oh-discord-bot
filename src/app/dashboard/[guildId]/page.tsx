import Link from "next/link";
import { prisma } from "@/lib/db";
import { listGuildMembers, listTextChannels } from "@/lib/discord-rest";

// Server-rendered overview page. Pulls a handful of quick stats so admins can
// see at a glance whether the bot is doing what it should without clicking
// through every section. Everything below is read-only — actions live on the
// dedicated pages.
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;

  // Fan-out queries in parallel — the page can't render until all return.
  const [
    guild,
    postsActiveCount,
    postsPausedCount,
    nextPost,
    lastPost,
    upcoming,
    recent,
    tiers,
    milestoneConfig,
    lastFailedPost,
    recentSignIns,
    channels,
    members,
  ] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.scheduledPost.count({ where: { guildId, active: true } }),
    prisma.scheduledPost.count({ where: { guildId, active: false } }),
    prisma.scheduledPost.findFirst({
      where: { guildId, active: true, nextFireAt: { not: null } },
      orderBy: { nextFireAt: "asc" },
    }),
    prisma.scheduledPost.findFirst({
      where: { guildId, lastFiredAt: { not: null } },
      orderBy: { lastFiredAt: "desc" },
    }),
    prisma.scheduledPost.findMany({
      where: { guildId, active: true, nextFireAt: { not: null } },
      orderBy: { nextFireAt: "asc" },
      take: 5,
    }),
    prisma.scheduledPost.findMany({
      where: { guildId, lastFiredAt: { not: null } },
      orderBy: { lastFiredAt: "desc" },
      take: 5,
    }),
    prisma.milestoneTier.findMany({
      where: { guildId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.milestoneConfig.findUnique({ where: { guildId } }),
    prisma.scheduledPost.findFirst({
      where: { guildId, lastFailedAt: { not: null } },
      orderBy: { lastFailedAt: "desc" },
    }),
    // Sign-ins are global, not per-guild — anyone who can see this dashboard
    // can see who else has logged in lately. Limit to 5 most recent.
    prisma.user.findMany({
      where: { lastSignInAt: { not: null } },
      orderBy: { lastSignInAt: "desc" },
      take: 5,
      select: { id: true, name: true, image: true, lastSignInAt: true },
    }),
    listTextChannels(guildId).catch(() => null),
    listGuildMembers(guildId).catch(() => null),
  ]);

  if (!guild) return null;

  const channelNames: Record<string, string> = channels
    ? Object.fromEntries(channels.map((c) => [c.id, c.name]))
    : {};
  const channelsReachable = channels !== null;

  // Tally how many members hold each milestone role. Null `members` means the
  // GUILD_MEMBERS intent isn't enabled or the API call failed; we render "—"
  // for counts in that case rather than misleading zeros.
  const memberCountsByRole: Record<string, number> | null = members
    ? (() => {
        const counts: Record<string, number> = {};
        for (const m of members) {
          for (const roleId of m.roles) {
            counts[roleId] = (counts[roleId] ?? 0) + 1;
          }
        }
        return counts;
      })()
    : null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{guild.name}</h1>
          <p className="mt-1 text-sm text-white/60">
            What the bot has done lately, and what&apos;s queued next.
          </p>
        </div>
        <Link
          href={`/dashboard/${guildId}/new`}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)]"
        >
          + New Post
        </Link>
      </div>

      {/* Top stat grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard
          label="Active posts"
          value={postsActiveCount.toString()}
          sub={postsPausedCount > 0 ? `${postsPausedCount} paused` : "none paused"}
          href={`/dashboard/${guildId}/posts`}
        />
        <StatCard
          label="Next firing"
          value={nextPost?.nextFireAt ? relativeTime(nextPost.nextFireAt) : "—"}
          sub={
            nextPost
              ? truncate(nextPost.name, 32)
              : postsActiveCount === 0
                ? "no active posts"
                : "no scheduled run"
          }
          href={nextPost ? `/dashboard/${guildId}/posts/${nextPost.id}` : undefined}
        />
        <StatCard
          label="Last firing"
          value={lastPost?.lastFiredAt ? relativeTime(lastPost.lastFiredAt) : "—"}
          sub={lastPost ? truncate(lastPost.name, 32) : "nothing has fired yet"}
          href={lastPost ? `/dashboard/${guildId}/posts/${lastPost.id}` : undefined}
        />
        <StatCard
          label="Milestone tiers"
          value={tiers.length.toString()}
          sub={
            milestoneConfig?.messageId
              ? "claim message published"
              : tiers.length > 0
                ? "not yet published"
                : "none configured"
          }
          href={`/dashboard/${guildId}/milestones`}
        />
        <StatCard
          label="Congrats roster"
          value={
            milestoneConfig?.congratsEnabled
              ? milestoneConfig.congratsTemplates.length.toString()
              : "off"
          }
          sub={
            milestoneConfig?.congratsEnabled
              ? milestoneConfig.congratsChannelId
                ? `→ #${channelNames[milestoneConfig.congratsChannelId] ?? milestoneConfig.congratsChannelId.slice(-6)}`
                : "no channel set"
              : "public congrats disabled"
          }
          href={`/dashboard/${guildId}/milestones`}
        />
        <StatCard
          label="Channels visible"
          value={channelsReachable ? channels!.length.toString() : "—"}
          sub={
            channelsReachable
              ? "bot can see and post"
              : "bot can't list channels (check token/intents)"
          }
          tone={channelsReachable ? "default" : "warn"}
        />
      </div>

      {/* Two-column: upcoming + recent */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Upcoming" linkHref={`/dashboard/${guildId}/posts`} linkLabel="All posts →">
          {upcoming.length === 0 ? (
            <EmptyMsg>Nothing scheduled.</EmptyMsg>
          ) : (
            <ul className="divide-y divide-white/5">
              {upcoming.map((p) => (
                <PostLine
                  key={p.id}
                  guildId={guildId}
                  post={p}
                  channelNames={channelNames}
                  whenLabel="fires"
                  when={p.nextFireAt!}
                />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recently fired">
          {recent.length === 0 ? (
            <EmptyMsg>No fires recorded yet.</EmptyMsg>
          ) : (
            <ul className="divide-y divide-white/5">
              {recent.map((p) => (
                <PostLine
                  key={p.id}
                  guildId={guildId}
                  post={p}
                  channelNames={channelNames}
                  whenLabel="fired"
                  when={p.lastFiredAt!}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Last error — only renders when there's a failure to surface */}
      {lastFailedPost && (
        <Panel title="Last scheduler error">
          <div className="px-4 py-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <Link
                href={`/dashboard/${guildId}/posts/${lastFailedPost.id}`}
                className="font-medium hover:underline"
              >
                {lastFailedPost.name}
              </Link>
              <span
                className="shrink-0 text-xs text-amber-200/80"
                title={lastFailedPost.lastFailedAt!.toLocaleString()}
              >
                {relativeTime(lastFailedPost.lastFailedAt!)}
              </span>
            </div>
            {lastFailedPost.lastError && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-xs text-amber-100/80 ring-1 ring-amber-500/20">
                {lastFailedPost.lastError}
              </pre>
            )}
          </div>
        </Panel>
      )}

      {/* Milestones */}
      <Panel
        title="Milestone tiers"
        linkHref={`/dashboard/${guildId}/milestones`}
        linkLabel="Edit →"
      >
        {tiers.length === 0 ? (
          <EmptyMsg>
            None set up.{" "}
            <Link
              href={`/dashboard/${guildId}/milestones`}
              className="text-[color:var(--color-brand-500)] hover:underline"
            >
              Configure milestones →
            </Link>
          </EmptyMsg>
        ) : (
          <ul className="divide-y divide-white/5">
            {tiers.map((t) => {
              const memberCount =
                memberCountsByRole && t.roleId ? (memberCountsByRole[t.roleId] ?? 0) : null;
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-lg">{t.emoji}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{t.label}</span>
                  <span
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] tabular-nums text-white/70"
                    title={
                      memberCountsByRole === null
                        ? "Member count unavailable — enable GUILD_MEMBERS intent in the dev portal"
                        : "Members currently holding this role"
                    }
                  >
                    {memberCount !== null ? `${memberCount} member${memberCount === 1 ? "" : "s"}` : "— members"}
                  </span>
                  <span className="text-xs text-white/40">
                    {t.congratsTemplates.length === 0
                      ? "fallback roster"
                      : `${t.congratsTemplates.length} response${t.congratsTemplates.length === 1 ? "" : "s"}`}
                  </span>
                  <span className="font-mono text-[11px] text-white/30">
                    {t.roleId ? `@${t.roleId.slice(-6)}` : "no role"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* Recently signed in */}
      <Panel title="Recently signed in">
        {recentSignIns.length === 0 ? (
          <EmptyMsg>No sign-ins recorded yet.</EmptyMsg>
        ) : (
          <ul className="divide-y divide-white/5">
            {recentSignIns.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-2">
                {u.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={u.image}
                    alt=""
                    className="h-6 w-6 rounded-full ring-1 ring-white/10"
                  />
                ) : (
                  <div className="h-6 w-6 rounded-full bg-white/10" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {u.name ?? "Unknown user"}
                </span>
                <span
                  className="shrink-0 text-xs text-white/50"
                  title={u.lastSignInAt!.toLocaleString()}
                >
                  {relativeTime(u.lastSignInAt!)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Guild meta */}
      <Panel title="Guild">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2">
          <Meta term="ID" detail={<span className="font-mono text-xs">{guild.id}</span>} />
          <Meta term="Timezone" detail={guild.timezone} />
          <Meta
            term="Admin role"
            detail={
              guild.adminRoleId ? (
                <span className="font-mono text-xs">@{guild.adminRoleId.slice(-6)}</span>
              ) : (
                <span className="text-white/40">bootstrap admins only</span>
              )
            }
          />
          <Meta
            term="Bot joined"
            detail={
              <span title={guild.createdAt.toLocaleString()}>
                {relativeTime(guild.createdAt)}
              </span>
            }
          />
        </dl>
      </Panel>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  href,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  href?: string;
  tone?: "default" | "warn";
}) {
  const inner = (
    <div
      className={`h-full rounded-2xl bg-white/[0.02] p-4 ring-1 transition ${
        tone === "warn"
          ? "ring-amber-500/30"
          : href
            ? "ring-white/5 hover:bg-white/[0.04] hover:ring-white/10"
            : "ring-white/5"
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold ${
          tone === "warn" ? "text-amber-200" : "text-white"
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-white/50">{sub}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function Panel({
  title,
  children,
  linkHref,
  linkLabel,
}: {
  title: string;
  children: React.ReactNode;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-white/5">
      <header className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
        <h2 className="text-sm font-medium text-white/80">{title}</h2>
        {linkHref && (
          <Link href={linkHref} className="text-xs text-white/50 hover:text-white">
            {linkLabel ?? "View"}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyMsg({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-white/50">{children}</div>;
}

function Meta({ term, detail }: { term: string; detail: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5 sm:border-0 sm:pb-0">
      <dt className="text-white/50">{term}</dt>
      <dd className="text-right text-white/80">{detail}</dd>
    </div>
  );
}

function PostLine({
  guildId,
  post,
  channelNames,
  whenLabel,
  when,
}: {
  guildId: string;
  post: {
    id: string;
    name: string;
    channelIds: string[];
    active: boolean;
  };
  channelNames: Record<string, string>;
  whenLabel: string;
  when: Date;
}) {
  return (
    <li className="px-4 py-2.5 hover:bg-white/[0.02]">
      <Link href={`/dashboard/${guildId}/posts/${post.id}`} className="block">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">
            {!post.active && (
              <span className="mr-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50">
                paused
              </span>
            )}
            {post.name}
          </span>
          <span className="shrink-0 text-xs text-white/50" title={when.toLocaleString()}>
            {whenLabel} {relativeTime(when)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {post.channelIds.slice(0, 3).map((id) => (
            <span
              key={id}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50"
            >
              #{channelNames[id] ?? id.slice(-6)}
            </span>
          ))}
          {post.channelIds.length > 3 && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">
              +{post.channelIds.length - 3}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Render a Date as a short relative string ("5 min ago", "in 2 hours"). Server-
// rendered so the user sees the formatted string immediately; no client-side
// hydration ticker.
function relativeTime(d: Date): string {
  const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec >= 0;
  const fmt = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  let val: string;
  if (abs < 60) val = fmt(abs, "sec");
  else if (abs < 3600) val = fmt(Math.round(abs / 60), "min");
  else if (abs < 86400) val = fmt(Math.round(abs / 3600), "hour");
  else if (abs < 86400 * 30) val = fmt(Math.round(abs / 86400), "day");
  else if (abs < 86400 * 365) val = fmt(Math.round(abs / (86400 * 30)), "month");
  else val = fmt(Math.round(abs / (86400 * 365)), "year");
  return future ? `in ${val}` : `${val} ago`;
}
