-- Backfill the expanded default GLOBAL congrats roster (15 variants) into
-- MilestoneConfig rows that are still on the single-string seed default.
--
-- Note: the global congrats roster is only used when a tier has NO roster of
-- its own. If you also ran 2026-05-22-milestone-default-rosters.sql to seed
-- per-tier rosters (7 each), the global roster is effectively dormant — but
-- still worth keeping current for guilds that clear a tier's roster later.
--
-- Safety: only fires when cardinality("congratsTemplates") <= 1. Customized
-- rosters (2+ entries) are left alone.

BEGIN;

UPDATE "MilestoneConfig"
SET "congratsTemplates" = ARRAY[
  '{emoji} Big congrats to {user} on reaching **{tier}** — proud of you. Keep going.
Claim yours in {claimChannel}.',
  '{emoji} {user} just claimed **{tier}**. Every day you keep showing up is the work. Keep it up.',
  '{emoji} Massive respect to {user} for hitting **{tier}**. This stuff is hard. You''re doing it.',
  '{emoji} {user} just leveled up to **{tier}**. Each milestone is a stack of yesterdays you didn''t quit. Proud of you.',
  '{emoji} Roll call — {user} just hit **{tier}**. That''s another one in the win column.',
  '{emoji} {user} claimed **{tier}**. Quiet, steady, real — the kind of recovery that lasts.',
  '{emoji} Hats off to {user} for reaching **{tier}**. The hard part is showing up daily, and you have.',
  '{emoji} {user} just unlocked **{tier}**. Whatever it took to get here, keep doing that.',
  '{emoji} Big day for {user} — **{tier}** in the books. The community is rooting for you.',
  '{emoji} {user} hit **{tier}**. One more piece of evidence that recovery is possible. Thank you for being here.',
  '{emoji} Salute to {user} on **{tier}**. Sobriety isn''t a phase, it''s a practice. You''re practicing.',
  '{emoji} {user} just earned **{tier}**. Earned is the right word — none of this happens by accident.',
  '{emoji} {user} just hit **{tier}**. Take the win — tomorrow''s a fresh chance to stack another day.',
  '{emoji} {user} crossed **{tier}**. Every milestone is proof that recovery sticks. Thank you for showing up.',
  '{emoji} Today {user} hit **{tier}**. Small, important, real. Keep going.'
]
WHERE cardinality("congratsTemplates") <= 1;

COMMIT;
