"use client";

import { useRouter, usePathname } from "next/navigation";

type Guild = { id: string; name: string };

export function GuildSwitcher({
  guilds,
  currentGuildId,
}: {
  guilds: Guild[];
  currentGuildId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    // Swap the guild segment of the path when possible, else go to its root.
    const parts = pathname.split("/");
    if (parts[1] === "dashboard" && parts[2]) {
      parts[2] = next;
      router.push(parts.slice(0, 3).join("/"));
    } else {
      router.push(`/dashboard/${next}`);
    }
  }

  return (
    <select
      defaultValue={currentGuildId}
      onChange={onChange}
      className="rounded-md bg-white/5 px-2 py-1.5 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
    >
      {guilds.map((g) => (
        <option key={g.id} value={g.id} className="bg-neutral-900">
          {g.name}
        </option>
      ))}
    </select>
  );
}
