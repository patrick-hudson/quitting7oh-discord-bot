-- Convert milestone congrats/ephemeral templates from single text columns to
-- text[] arrays ("rosters"). Run this once against prod BEFORE deploying the
-- new image — once the SQL applies, the deploy's `prisma db push` will be a
-- no-op against the matching schema.prisma.
--
-- This is wrapped in a transaction so a partial failure rolls back cleanly.

BEGIN;

-- MilestoneTier: add new columns, backfill, drop old.
ALTER TABLE "MilestoneTier"
  ADD COLUMN "congratsTemplates" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "lastCongratsIndex" integer;

UPDATE "MilestoneTier"
  SET "congratsTemplates" = ARRAY["congratsTemplate"]
  WHERE "congratsTemplate" IS NOT NULL AND length("congratsTemplate") > 0;

ALTER TABLE "MilestoneTier" DROP COLUMN "congratsTemplate";

-- MilestoneConfig: same shape for both congrats and ephemeral.
ALTER TABLE "MilestoneConfig"
  ADD COLUMN "congratsTemplates" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "lastCongratsIndex" integer,
  ADD COLUMN "ephemeralTemplates" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "lastEphemeralIndex" integer;

UPDATE "MilestoneConfig"
  SET "congratsTemplates" = ARRAY["congratsTemplate"]
  WHERE "congratsTemplate" IS NOT NULL AND length("congratsTemplate") > 0;

UPDATE "MilestoneConfig"
  SET "ephemeralTemplates" = ARRAY["ephemeralTemplate"]
  WHERE "ephemeralTemplate" IS NOT NULL AND length("ephemeralTemplate") > 0;

ALTER TABLE "MilestoneConfig"
  DROP COLUMN "congratsTemplate",
  DROP COLUMN "ephemeralTemplate";

COMMIT;
