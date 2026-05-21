import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listAccessibleGuilds } from "@/lib/authz";

export default async function DashboardIndex() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const guilds = await listAccessibleGuilds(session.user.discordId);
  if (guilds.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-2xl font-semibold">No accessible guilds</h1>
        <p className="mt-2 text-white/60">
          You&apos;re signed in as <span className="text-white">{session.user.name}</span>, but no
          Discord guild grants you access yet.
        </p>
        <p className="mt-4 text-sm text-white/50">
          Ask an existing admin to add your user ID to <code>BOOTSTRAP_ADMIN_USER_IDS</code>, or
          have one configure an admin role for your guild that you hold.
        </p>
      </main>
    );
  }

  redirect(`/dashboard/${guilds[0].id}`);
}
