CREATE TYPE "public"."goal_role" AS ENUM('OWNER', 'MEMBER');--> statement-breakpoint
CREATE TABLE "goal_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "goal_role" NOT NULL,
	"joined_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "goal_members" ADD CONSTRAINT "goal_members_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_members" ADD CONSTRAINT "goal_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goal_members_goal_user_idx" ON "goal_members" USING btree ("goal_id","user_id");