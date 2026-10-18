CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"trigger" jsonb,
	"status" text DEFAULT 'binned' NOT NULL,
	"source_task_id" uuid,
	"tossed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"restored_at" timestamp with time zone,
	"restored_by" text,
	"restore_note" text
);
--> statement-breakpoint
CREATE TABLE "letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_kind" text NOT NULL,
	"from_agent_id" uuid,
	"from_user_id" uuid,
	"to_agent_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"stamp" jsonb,
	"reply_to_id" uuid,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"content" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"coordinator_agent_id" uuid,
	"turn_rule" text DEFAULT 'coordinator' NOT NULL,
	"cost_cap_usd" numeric(12, 4) DEFAULT '1' NOT NULL,
	"spent_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"presenter_agent_id" uuid NOT NULL,
	"dissenter_agent_id" uuid,
	"audience" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"decision_mode" text DEFAULT 'vote' NOT NULL,
	"budget_usd" numeric(12, 4) DEFAULT '1' NOT NULL,
	"spent_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"stage" text DEFAULT 'brief' NOT NULL,
	"deck" jsonb,
	"qa" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"challenge" jsonb,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" jsonb,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "letter_id" uuid;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_coordinator_agent_id_agents_id_fk" FOREIGN KEY ("coordinator_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talks" ADD CONSTRAINT "talks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talks" ADD CONSTRAINT "talks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talks" ADD CONSTRAINT "talks_presenter_agent_id_agents_id_fk" FOREIGN KEY ("presenter_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talks" ADD CONSTRAINT "talks_dissenter_agent_id_agents_id_fk" FOREIGN KEY ("dissenter_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ideas_workspace" ON "ideas" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "letters_workspace" ON "letters" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_pk" ON "room_members" USING btree ("room_id","agent_id");--> statement-breakpoint
CREATE INDEX "room_messages_room" ON "room_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "rooms_workspace" ON "rooms" USING btree ("workspace_id","created_at");