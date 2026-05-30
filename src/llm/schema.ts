export const SUPPORTED_LLM_INTENTS = [
	"create_reminder",
	"create_crawl_schedule",
	"update_reminder",
] as const;

export type SupportedLlmIntent = (typeof SUPPORTED_LLM_INTENTS)[number];

export type LlmDayOfWeek =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday"
	| "sunday";

export type NormalizedRepeatRule =
	| {
			type: "daily";
			time: string;
	  }
	| {
			type: "weekly";
			day_of_week: LlmDayOfWeek;
			time: string;
	  }
	| {
			type: "interval";
			minutes: number;
	  };

export type NormalizedLlmReminderIntent = {
	intent: "create_reminder";
	title: string;
	run_at: string | null;
	repeat_rule: NormalizedRepeatRule | null;
	timezone: "Asia/Seoul";
	needs_confirmation: true;
	confidence?: number;
};

export type NormalizedLlmCrawlScheduleIntent = {
	intent: "create_crawl_schedule";
	source_id: "maplestory_update";
	title: string;
	target_url: string;
	interval_minutes: number;
	keywords: string[];
	timezone: "Asia/Seoul";
	needs_confirmation: true;
	confidence?: number;
};

export type NormalizedLlmUpdateReminderIntent = {
	intent: "update_reminder";
	title?: string;
	run_at?: string | null;
	repeat_rule?: NormalizedRepeatRule | null;
	clear_repeat?: boolean;
	timezone: "Asia/Seoul";
	needs_confirmation: true;
	confidence?: number;
};

export type NormalizedLlmIntent =
	| NormalizedLlmReminderIntent
	| NormalizedLlmCrawlScheduleIntent
	| NormalizedLlmUpdateReminderIntent;

export type ValidationResult =
	| { ok: true; value: NormalizedLlmIntent }
	| { ok: false; reason: string; userMessage: string };
