// Baked-in member-departure messages, used when a guild has leaveEnabled but
// an empty Guild.leaveTemplates roster. Editable per guild on the portal's
// Defaults page. Placeholders: {user} = display name (plain text), {profile}
// = display name hyperlinked to their Discord profile, {count} = member count
// after they left.
//
// Tone matters here: this is a recovery community, and people sometimes leave
// during a relapse. Keep departures neutral and warm — no jokes, no shaming,
// and leave the door open.
export const LEAVE_TEMPLATES = [
  "👋 {profile} has left the server. Wishing them well — the door is always open.",
  "{profile} has left. We're {count} strong and they're welcome back anytime.",
  "👋 {profile} left the server. If they come back, greet them like family.",
  "{profile} has moved on for now. Once part of this community, always part of it.",
];
