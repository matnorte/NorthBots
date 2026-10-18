CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"task_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "schedule_runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"agent_id" uuid,
	"room_id" uuid,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"system_key" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"approved_hash" text,
	"approval_id" uuid,
	"created_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_runs_due" ON "schedule_runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "schedules_due" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_system" ON "schedules" USING btree ("workspace_id","system_key");