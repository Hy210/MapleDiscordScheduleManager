import { MAPLESTORY_UPDATE_PRESET } from "../crawler/presets";
import { normalizeReminderTitle } from "../parser/titleExtractor";
import type {
	LlmDayOfWeek,
	NormalizedLlmCrawlScheduleIntent,
	NormalizedLlmReminderIntent,
	NormalizedRepeatRule,
	ValidationResult,
} from "./schema";

const SEOUL_TIMEZONE = "Asia/Seoul";
const DEFAULT_REMINDER_TITLE = "알림";
const DEFAULT_CRAWL_TITLE = "메이플스토리 업데이트 감지";
const MIN_CONFIDENCE = 0.65;
const MIN_INTERVAL_MINUTES = 5;
const MAX_REMINDER_INTERVAL_MINUTES = 10080;
const MAX_CRAWL_INTERVAL_MINUTES = 1440;
const VALID_DAYS_OF_WEEK = new Set<LlmDayOfWeek>([
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
]);

type JsonObject = Record<string, unknown>;
type InvalidValidationResult = Extract<ValidationResult, { ok: false }>;

export function validateLlmIntent(
	raw: unknown,
	options: { now?: Date | string } = {},
): ValidationResult {
	if (!isObject(raw)) {
		return invalid(
			"not_object",
			"요청 내용을 안전하게 읽지 못했어요. 다시 한 번 입력해 주세요.",
		);
	}

	const intent = raw.intent;
	if (intent === "create_reminder") {
		return validateCreateReminder(raw, normalizeNow(options.now));
	}

	if (intent === "create_crawl_schedule") {
		return validateCreateCrawlSchedule(raw);
	}

	// TODO: update_reminder can be enabled after edit semantics and permission rules are defined.
	return invalid(
		"unsupported_intent",
		"지원하지 않는 요청이에요. 현재는 일정 등록과 메이플 업데이트 감지만 지원해요.",
	);
}

function validateCreateReminder(raw: JsonObject, now: Date): ValidationResult {
	const confidenceResult = validateConfidence(raw.confidence);
	if (!confidenceResult.ok) {
		return confidenceResult;
	}

	const timezoneResult = normalizeTimezone(raw.timezone);
	if (!timezoneResult.ok) {
		return timezoneResult;
	}

	const titleResult = normalizeTitle(raw.title, DEFAULT_REMINDER_TITLE);
	if (!titleResult.ok) {
		return titleResult;
	}

	const repeatResult = normalizeRepeatRule(raw.repeat);
	if (!repeatResult.ok) {
		return repeatResult;
	}

	const repeatRule = repeatResult.value;
	const runAtResult = normalizeRunAt(raw.run_at, repeatRule, now);
	if (!runAtResult.ok) {
		return runAtResult;
	}

	const value: NormalizedLlmReminderIntent = {
		intent: "create_reminder",
		title: titleResult.value,
		run_at: runAtResult.value,
		repeat_rule: repeatRule,
		timezone: SEOUL_TIMEZONE,
		needs_confirmation: true,
		...(confidenceResult.value === undefined
			? {}
			: { confidence: confidenceResult.value }),
	};
	return { ok: true, value };
}

function validateCreateCrawlSchedule(raw: JsonObject): ValidationResult {
	const confidenceResult = validateConfidence(raw.confidence);
	if (!confidenceResult.ok) {
		return confidenceResult;
	}

	const timezoneResult = normalizeTimezone(raw.timezone);
	if (!timezoneResult.ok) {
		return timezoneResult;
	}

	if (raw.source_id !== MAPLESTORY_UPDATE_PRESET.source_id) {
		return invalid(
			"unsupported_crawl_source",
			"메이플 업데이트 감지는 고정된 공식 페이지 기준으로만 등록할 수 있어요.",
		);
	}

	const titleResult = normalizeTitle(raw.title, DEFAULT_CRAWL_TITLE);
	if (!titleResult.ok) {
		return titleResult;
	}

	const intervalResult = normalizeCrawlInterval(raw.interval_minutes);
	if (!intervalResult.ok) {
		return intervalResult;
	}

	const value: NormalizedLlmCrawlScheduleIntent = {
		intent: "create_crawl_schedule",
		source_id: "maplestory_update",
		title: titleResult.value,
		target_url: MAPLESTORY_UPDATE_PRESET.url,
		interval_minutes: intervalResult.value,
		keywords: [...MAPLESTORY_UPDATE_PRESET.keywords],
		timezone: SEOUL_TIMEZONE,
		needs_confirmation: true,
		...(confidenceResult.value === undefined
			? {}
			: { confidence: confidenceResult.value }),
	};
	return { ok: true, value };
}

function normalizeRepeatRule(
	repeat: unknown,
): { ok: true; value: NormalizedRepeatRule | null } | InvalidValidationResult {
	if (repeat === null || repeat === undefined) {
		return { ok: true, value: null };
	}

	if (!isObject(repeat)) {
		return invalid("invalid_repeat", "반복 일정 정보를 정확히 이해하지 못했어요.");
	}

	if (repeat.type === "daily") {
		if (!isValidTimeText(repeat.time)) {
			return invalid("invalid_daily_time", "반복 시간은 HH:mm 형식으로 입력되어야 해요.");
		}

		return {
			ok: true,
			value: {
				type: "daily",
				time: repeat.time,
			},
		};
	}

	if (repeat.type === "weekly") {
		if (!isValidDayOfWeek(repeat.day_of_week)) {
			return invalid("invalid_weekly_day", "매주 반복 요일을 정확히 이해하지 못했어요.");
		}

		if (!isValidTimeText(repeat.time)) {
			return invalid("invalid_weekly_time", "반복 시간은 HH:mm 형식으로 입력되어야 해요.");
		}

		return {
			ok: true,
			value: {
				type: "weekly",
				day_of_week: repeat.day_of_week,
				time: repeat.time,
			},
		};
	}

	if (repeat.type === "interval") {
		const minutes = repeat.minutes;
		if (typeof minutes !== "number" || !Number.isInteger(minutes)) {
			return invalid("invalid_interval_minutes", "반복 간격을 정확히 이해하지 못했어요.");
		}

		if (minutes < MIN_INTERVAL_MINUTES) {
			return invalid(
				"interval_too_short",
				"반복 알림은 최소 5분 간격부터 등록할 수 있어요.",
			);
		}

		if (minutes > MAX_REMINDER_INTERVAL_MINUTES) {
			return invalid("interval_too_long", "반복 알림 간격은 최대 7일까지 등록할 수 있어요.");
		}

		return {
			ok: true,
			value: {
				type: "interval",
				minutes,
			},
		};
	}

	return invalid("invalid_repeat_type", "지원하지 않는 반복 일정 형식이에요.");
}

function normalizeRunAt(
	runAt: unknown,
	repeatRule: NormalizedRepeatRule | null,
	now: Date,
): { ok: true; value: string | null } | InvalidValidationResult {
	if (repeatRule) {
		return { ok: true, value: null };
	}

	if (typeof runAt !== "string" || !runAt.trim()) {
		return invalid(
			"missing_run_at",
			"시간을 정확히 이해하지 못했어요. 예: /알림 내일 오후 9시 30분에 보스 알려줘",
		);
	}

	const parsed = new Date(runAt);
	if (Number.isNaN(parsed.getTime())) {
		return invalid(
			"invalid_run_at",
			"시간을 정확히 이해하지 못했어요. 예: /알림 내일 오후 9시 30분에 보스 알려줘",
		);
	}

	if (parsed.getTime() <= now.getTime()) {
		return invalid("past_run_at", "과거 시간으로는 알림을 등록할 수 없어요.");
	}

	return { ok: true, value: runAt };
}

function normalizeCrawlInterval(
	intervalMinutes: unknown,
): { ok: true; value: number } | InvalidValidationResult {
	if (intervalMinutes === null || intervalMinutes === undefined) {
		return { ok: true, value: MAPLESTORY_UPDATE_PRESET.defaultIntervalMinutes };
	}

	if (typeof intervalMinutes !== "number" || !Number.isInteger(intervalMinutes)) {
		return invalid("invalid_crawl_interval", "검사 주기를 정확히 이해하지 못했어요.");
	}

	if (intervalMinutes < MIN_INTERVAL_MINUTES) {
		return invalid(
			"crawl_interval_too_short",
			"반복 알림은 최소 5분 간격부터 등록할 수 있어요.",
		);
	}

	if (intervalMinutes > MAX_CRAWL_INTERVAL_MINUTES) {
		return invalid("crawl_interval_too_long", "검사 주기는 최대 1440분까지 등록할 수 있어요.");
	}

	return { ok: true, value: intervalMinutes };
}

function normalizeTitle(
	title: unknown,
	defaultTitle: string,
): { ok: true; value: string } | InvalidValidationResult {
	const normalizedTitle = typeof title === "string" ? title.trim() : "";
	return { ok: true, value: normalizeReminderTitle(normalizedTitle, defaultTitle) };
}

function normalizeTimezone(timezone: unknown): { ok: true } | InvalidValidationResult {
	if (timezone === null || timezone === undefined || timezone === SEOUL_TIMEZONE) {
		return { ok: true };
	}

	return invalid("invalid_timezone", "현재는 Asia/Seoul 시간대만 지원해요.");
}

function validateConfidence(
	confidence: unknown,
): { ok: true; value?: number } | InvalidValidationResult {
	if (confidence === null || confidence === undefined) {
		return { ok: true };
	}

	if (typeof confidence !== "number" || Number.isNaN(confidence)) {
		return invalid("invalid_confidence", "요청 내용을 충분히 확신하지 못했어요.");
	}

	if (confidence < 0 || confidence > 1) {
		return invalid("invalid_confidence", "요청 내용을 충분히 확신하지 못했어요.");
	}

	if (confidence < MIN_CONFIDENCE) {
		return invalid(
			"low_confidence",
			"요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
		);
	}

	return { ok: true, value: confidence };
}

function isValidTimeText(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}

	const match = value.match(/^(\d{2}):(\d{2})$/);
	if (!match) {
		return false;
	}

	const hour = Number.parseInt(match[1], 10);
	const minute = Number.parseInt(match[2], 10);
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isValidDayOfWeek(value: unknown): value is LlmDayOfWeek {
	return typeof value === "string" && VALID_DAYS_OF_WEEK.has(value as LlmDayOfWeek);
}

function normalizeNow(now: Date | string | undefined): Date {
	if (now instanceof Date) {
		return Number.isNaN(now.getTime()) ? new Date() : now;
	}

	if (typeof now === "string") {
		const parsed = new Date(now);
		return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
	}

	return new Date();
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string, userMessage: string): InvalidValidationResult {
	return { ok: false, reason, userMessage };
}
