-- Each look (shape + colour) belongs to one agent per workspace, so agents are easy to tell apart.
-- Existing duplicates keep the look on the oldest agent; the others lose it here and get a free
-- one when the server starts (normalizeLooks). Avatars without a "shape" key are not indexed.
UPDATE "agents" AS a SET "avatar" = a."avatar" - 'shape'
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "workspace_id", "avatar"->>'shape', "avatar"->>'color' ORDER BY "created_at", "id") AS rn
  FROM "agents" WHERE "avatar" ? 'shape'
) AS d
WHERE a."id" = d."id" AND d.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_look" ON "agents" ("workspace_id", ("avatar"->>'shape'), ("avatar"->>'color')) WHERE "avatar" ? 'shape';
