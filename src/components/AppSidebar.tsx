"use client";

// Primary navigation for /dashboard. Built on shadcn's Sidebar primitive:
//   - SidebarHeader: brand + guild switcher (dropdown)
//   - SidebarContent: per-guild nav links with active highlighting
//   - SidebarFooter: user avatar + dropdown with sign-out
// Inset variant with icon-collapsible behavior (toggle via header button or
// Ctrl/⌘+B); state persists across navigation via shadcn's cookie.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Award,
  CalendarClock,
  ChartColumn,
  ChevronsUpDown,
  Download,
  History,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Sparkles,
  Trophy,
  Plus,
  ScrollText,
  Settings,
  Shield,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signOutAction } from "@/lib/auth-actions";

type Guild = { id: string; name: string };

export function AppSidebar({
  guilds,
  currentGuildId,
  currentGuildName,
  user,
}: {
  guilds: Guild[];
  currentGuildId: string;
  currentGuildName: string;
  user: { name?: string | null; image?: string | null };
}) {
  const pathname = usePathname();
  const router = useRouter();

  const base = `/dashboard/${currentGuildId}`;
  // Grouped by job-to-be-done rather than one long flat list. Dashboard sits
  // alone up top; each labeled group keeps its most-used entry first.
  const groups: {
    label: string | null;
    items: { href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[];
  }[] = [
    {
      label: null,
      items: [
        { href: base, label: "Dashboard", icon: LayoutDashboard, exact: true },
        { href: `${base}/stats`, label: "Server stats", icon: ChartColumn },
      ],
    },
    {
      label: "Posting",
      items: [
        { href: `${base}/posts`, label: "Posts", icon: CalendarClock },
        { href: `${base}/new`, label: "New post", icon: Plus },
        { href: `${base}/posts/advanced`, label: "Bulk-edit posts", icon: Layers },
        { href: `${base}/defaults`, label: "Defaults", icon: MessageSquareText },
      ],
    },
    {
      label: "Members",
      items: [
        { href: `${base}/leaderboard`, label: "Leaderboard", icon: Trophy },
        { href: `${base}/milestones`, label: "Milestones", icon: Award },
        { href: `${base}/milestones/advanced`, label: "Bulk-edit templates", icon: Layers },
        { href: `${base}/ai-review`, label: "AI reviews", icon: Sparkles },
      ],
    },
    {
      label: "Records",
      items: [
        { href: `${base}/audit`, label: "Audit log", icon: ScrollText },
        { href: `${base}/mod-log`, label: "Mod log", icon: Shield },
        { href: `${base}/snapshots`, label: "Snapshots", icon: History },
        { href: `${base}/export`, label: "Export", icon: Download },
      ],
    },
    {
      label: "Server",
      items: [{ href: `${base}/settings`, label: "Settings", icon: Settings }],
    },
  ];

  // Pick the single best-matching item so /posts/advanced highlights only
  // "Bulk-edit posts", not also "Posts" (which would otherwise prefix-match).
  const allItems = groups.flatMap((g) => g.items);
  const activeItem = allItems.reduce<(typeof allItems)[number] | null>(
    (best, item) => {
      const matches = item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(item.href + "/");
      if (!matches) return best;
      if (!best || item.href.length > best.href.length) return item;
      return best;
    },
    null
  );

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-[popup-open]:bg-sidebar-accent"
                  />
                }
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-[color:var(--color-brand-600)] text-sm font-semibold text-white">
                  Q7
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">
                    {currentGuildName}
                  </span>
                  <span className="truncate text-xs text-sidebar-foreground/60">
                    Quitting 7OH
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                align="start"
                side="bottom"
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Switch guild
                  </DropdownMenuLabel>
                  {guilds.map((g) => (
                    <DropdownMenuItem
                      key={g.id}
                      onClick={() => {
                        // Swap the guild segment of the current path; if the rest
                        // of the path doesn't exist for the new guild the inner
                        // page will redirect.
                        const parts = pathname.split("/");
                        if (parts[1] === "dashboard" && parts[2]) {
                          parts[2] = g.id;
                          router.push(parts.join("/"));
                        } else {
                          router.push(`/dashboard/${g.id}`);
                        }
                      }}
                      className={g.id === currentGuildId ? "font-medium" : ""}
                    >
                      {g.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label ?? "top"}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => {
                const { href, label, icon: Icon } = item;
                const active = item === activeItem;
                return (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={label}
                      render={<Link href={href} />}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-[popup-open]:bg-sidebar-accent"
                  />
                }
              >
                <Avatar className="size-8 rounded-lg">
                  {user.image && <AvatarImage src={user.image} alt="" />}
                  <AvatarFallback className="rounded-lg text-xs">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name ?? "Signed in"}</span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                align="end"
                side="top"
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
                    {user.name ?? "Signed in"}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <form action={signOutAction}>
                    <DropdownMenuItem
                      render={
                        <button type="submit" className="w-full cursor-pointer" />
                      }
                    >
                      <LogOut className="size-4" />
                      Sign out
                    </DropdownMenuItem>
                  </form>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function initials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}
