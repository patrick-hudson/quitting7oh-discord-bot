import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;
  if (session?.user) redirect(params.callbackUrl ?? "/dashboard");

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white/5 p-8 ring-1 ring-white/10">
        <h1 className="text-xl font-semibold tracking-tight">Quitting 7OH Admin</h1>
        <p className="mt-1 text-sm text-white/60">
          Sign in with Discord to manage scheduled meeting posts.
        </p>

        {params.error && (
          <p className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
            {params.error === "AccessDenied"
              ? "You don't have access to manage any guilds. Ask an admin to grant you the configured role."
              : params.error}
          </p>
        )}

        <form
          action={async () => {
            "use server";
            await signIn("discord", { redirectTo: params.callbackUrl ?? "/dashboard" });
          }}
          className="mt-6"
        >
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#5865F2] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#4752c4]"
          >
            <DiscordIcon />
            Continue with Discord
          </button>
        </form>
      </div>
    </main>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M19.27 5.33A18.36 18.36 0 0 0 14.65 4c-.2.36-.42.83-.58 1.21a17.07 17.07 0 0 0-4.14 0A8.78 8.78 0 0 0 9.35 4a18.5 18.5 0 0 0-4.63 1.33C2.36 9 1.74 12.55 2.05 16.06a18.6 18.6 0 0 0 5.66 2.86c.46-.63.87-1.3 1.22-2-.67-.25-1.31-.56-1.92-.92.16-.12.32-.25.47-.38a13.27 13.27 0 0 0 11.04 0c.15.13.31.26.47.38-.61.36-1.25.67-1.92.92.35.7.76 1.37 1.22 2a18.55 18.55 0 0 0 5.66-2.86c.36-4.1-.65-7.62-2.68-10.73ZM9.34 14.07c-1.1 0-2-1.02-2-2.26 0-1.25.88-2.27 2-2.27 1.12 0 2.02 1.02 2 2.27 0 1.24-.88 2.26-2 2.26Zm5.32 0c-1.1 0-2-1.02-2-2.26 0-1.25.88-2.27 2-2.27 1.12 0 2.02 1.02 2 2.27 0 1.24-.88 2.26-2 2.26Z" />
    </svg>
  );
}
