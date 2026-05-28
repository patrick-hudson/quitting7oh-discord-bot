// Baked-in plain-text reminder bodies, shared by the bot scheduler (which picks
// one at fire time when a post has no reminderContent override) and the post
// form (which previews the default). {meetingTime:R} renders as "in 5 minutes"
// etc., so these stay correct for any reminder lead time. Keep them short and
// plain — they post as a reply under the original announcement.
export const REMINDER_TEMPLATES = [
  "⏰ Heads up — starting {meetingTime:R}! See the message above for the link.",
  "👋 Quick reminder: this one kicks off {meetingTime:R}. Hope to see you there.",
  "📣 Almost time — starting {meetingTime:R}. Details are in the post above.",
  "⏳ Starting {meetingTime:R}. Grab a drink and come join us.",
  "🔔 Friendly nudge — we begin {meetingTime:R}. Link's in the original message.",
  "✨ Starting {meetingTime:R}. Drop in even if you can only listen.",
];
