// Baked-in welcome-DM messages, used when a guild has welcomeDmEnabled but an
// empty Guild.welcomeDmTemplates roster. Editable per guild on the portal's
// Defaults page. Placeholders: {user} = the member's display name, {server} =
// the server name.
//
// Keep these short, warm, and light on links — join-DM walls of text read as
// spam, and Discord's anti-spam heuristics watch link-heavy join DMs. Specific
// channel pointers belong in per-guild custom templates (e.g. "check
// #start-here"), since channel names vary.
export const WELCOME_TEMPLATES = [
  "👋 Welcome to {server}, {user}! We're glad you found us. Take your time, look around, and when you're ready, say hi — this community is at its best when people show up as they are.",
  "Hey {user}, welcome to {server} 💜 Whether you're day 1 or day 1,000, you belong here. Check out the channels, join a meeting when you're ready, and know that nobody here judges.",
  "Welcome, {user}! {server} is a peer community — everyone here has been where you are. Lurk as long as you like, and when you're ready to talk, we're ready to listen.",
];
