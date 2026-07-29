"use client";

// "Import existing post as starter" picker for the New Post page. Selecting a
// post navigates to ?from=<id>; the server loads that post's config into the
// form (without its id, so saving creates a new post).

import { useRouter } from "next/navigation";

export function StarterPicker({
  guildId,
  posts,
  currentFrom,
}: {
  guildId: string;
  posts: Array<{ id: string; name: string }>;
  currentFrom: string;
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/10">
      <label
        htmlFor="starter-picker"
        className="shrink-0 text-sm text-white/70"
      >
        Import existing post as starter
      </label>
      <select
        id="starter-picker"
        value={currentFrom}
        onChange={(e) => {
          const id = e.target.value;
          router.push(
            id
              ? `/dashboard/${guildId}/new?from=${id}`
              : `/dashboard/${guildId}/new`
          );
        }}
        className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
      >
        <option value="" className="bg-neutral-900">
          Start blank
        </option>
        {posts.map((p) => (
          <option key={p.id} value={p.id} className="bg-neutral-900">
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
