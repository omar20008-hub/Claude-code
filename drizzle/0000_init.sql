CREATE TYPE "public"."agent" AS ENUM('KNOWLEDGE_AGENT', 'CREATIVE_AGENT', 'ADVERTISING_AGENT');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('IMAGE', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('PENDING', 'STORED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'READY', 'LAUNCHING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('GOOGLE_DRIVE', 'META_ADS', 'N8N');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('NOT_CONFIGURED', 'CONNECTED', 'DEGRADED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('ar', 'en');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('USER', 'ASSISTANT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('ASSET_READY', 'ASSET_FAILED', 'CAMPAIGN_SUBMITTED', 'CAMPAIGN_FAILED', 'KNOWLEDGE_SYNC_FAILED', 'KNOWLEDGE_SYNC_SUCCEEDED', 'AGENT_ERROR');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'MARKETING_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."token_purpose" AS ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET');--> statement-breakpoint
CREATE TYPE "public"."usage_metric" AS ENUM('AGENT_REQUEST', 'KNOWLEDGE_QUERY', 'IMAGE_GENERATED', 'VIDEO_GENERATED', 'CAMPAIGN_CREATED', 'CAMPAIGN_LAUNCH_SUBMITTED', 'STORAGE_BYTES');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_request_id" uuid NOT NULL,
	"user_id" uuid,
	"agent" "agent" NOT NULL,
	"action" text NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"correlation_id" text NOT NULL,
	"n8n_execution_id" text,
	"idempotency_key" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"request_ref" text NOT NULL,
	"correlation_id" text NOT NULL,
	"agent" "agent" NOT NULL,
	"action" text NOT NULL,
	"locale" "locale" NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" text,
	"error_detail" text,
	"n8n_execution_id" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"agent_job_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'PENDING' NOT NULL,
	"title" text NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"duration_seconds" numeric(8, 2),
	"checksum" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"status" text NOT NULL,
	"correlation_id" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"impressions" bigint,
	"clicks" bigint,
	"spend_minor" bigint,
	"conversions" bigint,
	"conversion_value_minor" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"locale" "locale" NOT NULL,
	"objective" text DEFAULT 'OUTCOME_TRAFFIC' NOT NULL,
	"brief" text,
	"primary_text" text,
	"headline" text,
	"description" text,
	"destination_url" text,
	"call_to_action" text DEFAULT 'LEARN_MORE',
	"placement" text DEFAULT 'Feed 1:1',
	"saved_audience_id" text,
	"saved_audience_name" text,
	"audience_notes" text,
	"age_min" integer,
	"age_max" integer,
	"genders" text DEFAULT 'all',
	"countries" jsonb DEFAULT '["SA"]'::jsonb NOT NULL,
	"cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifetime_budget_minor" bigint,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"asset_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_snapshot" jsonb,
	"meta_ad_account_id" text,
	"meta_page_id" text,
	"meta_campaign_id" text,
	"meta_ad_set_id" text,
	"meta_ad_id" text,
	"meta_object_status" text,
	"launched_at" timestamp with time zone,
	"launch_job_id" uuid,
	"launch_idempotency_key" text,
	"last_error_code" text,
	"last_error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaigns_age_range" CHECK (("campaigns"."age_min" IS NULL OR "campaigns"."age_min" >= 13) AND ("campaigns"."age_max" IS NULL OR "campaigns"."age_max" <= 65) AND ("campaigns"."age_min" IS NULL OR "campaigns"."age_max" IS NULL OR "campaigns"."age_min" <= "campaigns"."age_max")),
	CONSTRAINT "campaigns_budget_positive" CHECK ("campaigns"."lifetime_budget_minor" IS NULL OR "campaigns"."lifetime_budget_minor" > 0),
	CONSTRAINT "campaigns_schedule_order" CHECK ("campaigns"."start_date" IS NULL OR "campaigns"."end_date" IS NULL OR "campaigns"."end_date" > "campaigns"."start_date")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent" "agent" NOT NULL,
	"title" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"locale" "locale" NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"status" "integration_status" DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_credentials" text,
	"last_checked_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "integration_kind" DEFAULT 'GOOGLE_DRIVE' NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"supported_formats" jsonb DEFAULT '["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]'::jsonb NOT NULL,
	"document_count" integer,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" "sync_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"knowledge_source_id" uuid NOT NULL,
	"status" "sync_status" NOT NULL,
	"trigger" text DEFAULT 'SCHEDULE' NOT NULL,
	"documents_indexed" integer,
	"documents_failed" integer,
	"error_code" text,
	"error_detail" text,
	"correlation_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_basis" text,
	"agent_request_id" uuid,
	"feedback" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_feedback_range" CHECK ("messages"."feedback" IS NULL OR "messages"."feedback" IN (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"message_key" text NOT NULL,
	"message_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_locale" "locale" DEFAULT 'ar' NOT NULL,
	"timezone" text DEFAULT 'Asia/Riyadh' NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"detail" text,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"metric" "usage_metric" NOT NULL,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"agent" "agent",
	"reference_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" DEFAULT 'ADMIN' NOT NULL,
	"status" "user_status" DEFAULT 'PENDING_VERIFICATION' NOT NULL,
	"locale_preference" "locale",
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"nonce" text NOT NULL,
	"request_ref" text,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"rejection_reason" text,
	"correlation_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_agent_request_id_agent_requests_id_fk" FOREIGN KEY ("agent_request_id") REFERENCES "public"."agent_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_agent_job_id_agent_jobs_id_fk" FOREIGN KEY ("agent_job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_launch_job_id_agent_jobs_id_fk" FOREIGN KEY ("launch_job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_syncs" ADD CONSTRAINT "knowledge_syncs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_syncs" ADD CONSTRAINT "knowledge_syncs_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_events" ADD CONSTRAINT "system_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_jobs_org_status_idx" ON "agent_jobs" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_jobs_org_agent_idx" ON "agent_jobs" USING btree ("organization_id","agent","created_at");--> statement-breakpoint
CREATE INDEX "agent_jobs_request_idx" ON "agent_jobs" USING btree ("agent_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_idempotency_key" ON "agent_jobs" USING btree ("organization_id","idempotency_key") WHERE "agent_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_requests_ref_key" ON "agent_requests" USING btree ("request_ref");--> statement-breakpoint
CREATE INDEX "agent_requests_org_created_idx" ON "agent_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_requests_org_agent_idx" ON "agent_requests" USING btree ("organization_id","agent","created_at");--> statement-breakpoint
CREATE INDEX "agent_requests_org_status_idx" ON "agent_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "agent_requests_correlation_idx" ON "agent_requests" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "assets_org_created_idx" ON "assets" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_org_kind_idx" ON "assets" USING btree ("organization_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "assets_org_status_idx" ON "assets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_checksum_key" ON "assets" USING btree ("organization_id","checksum") WHERE "assets"."checksum" IS NOT NULL AND "assets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_action_idx" ON "audit_logs" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_key" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_metrics_campaign_date_key" ON "campaign_metrics" USING btree ("campaign_id","date");--> statement-breakpoint
CREATE INDEX "campaign_metrics_org_date_idx" ON "campaign_metrics" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "campaigns_org_created_idx" ON "campaigns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_launch_idempotency_key" ON "campaigns" USING btree ("organization_id","launch_idempotency_key") WHERE "campaigns"."launch_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_meta_campaign_key" ON "campaigns" USING btree ("meta_campaign_id") WHERE "campaigns"."meta_campaign_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_org_agent_idx" ON "conversations" USING btree ("organization_id","agent","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_org_user_idx" ON "conversations" USING btree ("organization_id","user_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_agent_session_key" ON "conversations" USING btree ("agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_kind_key" ON "integrations" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "integrations_org_idx" ON "integrations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_org_external_key" ON "knowledge_sources" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_org_idx" ON "knowledge_sources" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_syncs_org_started_idx" ON "knowledge_syncs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "knowledge_syncs_source_idx" ON "knowledge_syncs" USING btree ("knowledge_source_id","started_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_org_idx" ON "messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_org_user_idx" ON "notifications" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "rate_limits_expiry_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "system_events_created_idx" ON "system_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "system_events_org_created_idx" ON "system_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "system_events_code_idx" ON "system_events" USING btree ("code","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_metric_idx" ON "usage_records" USING btree ("organization_id","metric","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_occurred_idx" ON "usage_records" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_nonce_key" ON "webhook_deliveries" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_request_idx" ON "webhook_deliveries" USING btree ("request_ref");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_expiry_idx" ON "webhook_deliveries" USING btree ("expires_at");