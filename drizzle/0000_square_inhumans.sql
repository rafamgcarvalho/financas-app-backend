CREATE TYPE "public"."goal_status" AS ENUM('ACTIVE', 'PAUSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."goal_type" AS ENUM('SHORT', 'MEDIUM', 'LONG');--> statement-breakpoint
CREATE TYPE "public"."meta_priority" AS ENUM('ESSENTIAL', 'IMPORTANT', 'DESIRABLE');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('INCOME', 'EXPENSE', 'INVESTMENT');--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(50) NOT NULL,
	"description" varchar(100),
	"targetValue" numeric NOT NULL,
	"currentValue" numeric DEFAULT '0',
	"startDate" timestamp NOT NULL,
	"targetDate" timestamp,
	"type" "goal_type" NOT NULL,
	"status" "goal_status" NOT NULL,
	"priority" "meta_priority" DEFAULT 'IMPORTANT' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(100) NOT NULL,
	"amount" numeric NOT NULL,
	"description" varchar(255),
	"date" timestamp NOT NULL,
	"category" varchar(50) NOT NULL,
	"type" "transaction_type" NOT NULL,
	"is_recurring" boolean DEFAULT false,
	"installments" integer DEFAULT 1,
	"group_id" text,
	"created_at" timestamp DEFAULT now(),
	"goal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"username" varchar(150) NOT NULL,
	"password" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;