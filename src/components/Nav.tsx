import Link from "next/link";
import { signOut } from "@/auth";
import { GuildSwitcher } from "./GuildSwitcher";

type Guild = { id: string; name: string };

export function Nav({
  guilds,
  currentGuildId,
  user,
}: {
  guilds: Guild[];
  currentGuildId?: string;
  user: { name?: string | null; image?: string | null };
}) {
  return (
    <header className="border-b border-white/5 bg-black/40 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link href="/dashboard" className="font-semibold tracking-tight">
          Quitting 7OH
        </Link>

        <nav className="flex items-center gap-1 text-sm text-white/70">
          {currentGuildId && (
            <>
              <NavLink href={`/dashboard/${currentGuildId}`}>Dashboard</NavLink>
              <NavLink href={`/dashboard/${currentGuildId}/posts`}>Posts</NavLink>
              <NavLink href={`/dashboard/${currentGuildId}/new`}>New Post</NavLink>
              <NavLink href={`/dashboard/${currentGuildId}/milestones`}>Milestones</NavLink>
              <NavLink href={`/dashboard/${currentGuildId}/export`}>Export</NavLink>
              <NavLink href={`/dashboard/${currentGuildId}/settings`}>Settings</NavLink>
            </>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {guilds.length > 1 && (
            <GuildSwitcher guilds={guilds} currentGuildId={currentGuildId} />
          )}
          <UserMenu user={user} />
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 transition hover:bg-white/5 hover:text-white"
    >
      {children}
    </Link>
  );
}

function UserMenu({ user }: { user: { name?: string | null; image?: string | null } }) {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
      className="flex items-center gap-2"
    >
      {user.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.image} alt="" className="h-7 w-7 rounded-full ring-1 ring-white/10" />
      )}
      <span className="text-sm text-white/70">{user.name}</span>
      <button
        type="submit"
        className="rounded-md px-2 py-1 text-xs text-white/50 hover:bg-white/5 hover:text-white"
      >
        Sign out
      </button>
    </form>
  );
}
