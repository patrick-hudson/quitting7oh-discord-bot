# Claude working notes

Project-level instructions and pitfalls for Claude Code working in this repo.

## Timezone-aware timestamps

The server runs in UTC (Docker), so any date formatted in a server component
renders in UTC. Show viewer-local times with `<LocalTime iso={...} />`
([src/components/LocalTime.tsx](src/components/LocalTime.tsx)), never a raw
`toLocaleString()` in server-rendered output.

`LocalTime`'s implementation is deliberate — don't "simplify" it. The naive
approaches DON'T work and cost real debugging time:

- With `suppressHydrationWarning`, React keeps the server's UTC DOM text but
  stores the *client* value in its vdom. If the client render computes local
  directly, later renders also compute local → matches vdom → React never
  patches the stale UTC DOM. A post-mount `setState` doesn't help if the text
  value it produces is the one React already recorded.
- The working pattern: render a **deterministic UTC** value pre-mount (server
  and first client render agree, vdom == DOM), then switch to local after a
  `mounted` flag flips. Only then does the vdom text actually change (UTC →
  local) and force a DOM patch.

Not a Cloudflare / caching issue — it's pure client hydration, and reproduces
locally on a hard refresh.

## Dependency management

After anything that changes `package.json` (adding deps, running `shadcn add`,
running a codemod, etc.), regenerate the lockfile cleanly before committing:

```sh
rm -rf node_modules package-lock.json && npm install
```

Why: `npm install` on macOS/Windows skips linux-only platform binaries
(`lightningcss-linux-*`, `@napi-rs/*`, etc.), and npm 10 won't record their
transitive `node_modules/...` entries in the lockfile if they weren't installed
locally. The Docker build (linux) then fails on `npm ci` with

```
npm error Missing: @emnapi/runtime@... from lock file
npm error Missing: @emnapi/core@... from lock file
```

A clean reinstall regenerates the lockfile with entries for every platform's
optional deps, so `npm ci` works the same locally and in the build container.

## shadcn / Base UI (`base-nova`) pitfalls

This repo's `components.json` uses the `base-nova` preset, so the components in
`src/components/ui/*` are built on **Base UI** (`@base-ui/react`), not Radix.
The Radix muscle memory doesn't translate 1:1; the two things that bite:

### 1. Use `render`, not `asChild`

Base UI primitives don't have an `asChild` prop. Composing with a custom
element uses a `render` prop instead — pass either a JSX element (cloned with
merged props) or a render function:

```tsx
// Wrong — TS error: "asChild does not exist".
<DropdownMenuTrigger asChild>
  <SidebarMenuButton>…</SidebarMenuButton>
</DropdownMenuTrigger>

// Right (element form) — children of the Trigger become children of the rendered button.
<DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
  <Avatar />
  <span>Label</span>
</DropdownMenuTrigger>

// Right (link inside a SidebarMenuButton) — same idea.
<SidebarMenuButton render={<Link href={href} />} isActive={active} tooltip={label}>
  <Icon />
  <span>{label}</span>
</SidebarMenuButton>
```

### 2. `DropdownMenuLabel` requires `DropdownMenuGroup`

Base UI's menu "group parts" (`MenuPrimitive.GroupLabel`, etc.) read from a
group context and **throw at click time** if they aren't inside a group. Radix
tolerated this; Base UI doesn't.

```
Uncaught Error: Base UI error #31; visit https://base-ui.com/production-error?code=31
```

decodes to *"MenuGroupContext is missing. Menu group parts must be used within
`<Menu.Group>` or `<Menu.RadioGroup>`."*

```tsx
// Wrong — throws on first open.
<DropdownMenuContent>
  <DropdownMenuLabel>Section title</DropdownMenuLabel>
  <DropdownMenuItem>…</DropdownMenuItem>
</DropdownMenuContent>

// Right — wrap label + items in a group.
<DropdownMenuContent>
  <DropdownMenuGroup>
    <DropdownMenuLabel>Section title</DropdownMenuLabel>
    <DropdownMenuItem>…</DropdownMenuItem>
  </DropdownMenuGroup>
</DropdownMenuContent>
```

Same logic applies anywhere a Base UI primitive has a "group-relative" sibling
(radio group items, selected-item indicators, etc.). If you see a Base UI
production-error link, the code mapping lives in the source —
`grep -rn "formatErrorMessage2.default)(<N>" node_modules/@base-ui/` finds the
throw site.
