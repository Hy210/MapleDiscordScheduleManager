import {
	buildEventKey,
	fetchMaplestoryUpdatePosts,
	type MapleStoryUpdatePost,
} from "./crawler/maplestory";
import { PRE_REMINDER_OFFSET_MINUTES } from "./config/reminder";
import { MAPLESTORY_UPDATE_PRESET, type CrawlerPreset } from "./crawler/presets";
import { parseWithLlm, shouldUseLlmFallback, type WorkersAiBinding } from "./llm/adapter";
import type { NormalizedLlmIntent, NormalizedRepeatRule } from "./llm/schema";
import {
	extractReminderTitle,
	normalizeReminderTitle,
	type MatchedSpan,
} from "./parser/titleExtractor";

interface Env {
	DB: D1Database;
	// TODO: Run `npm run cf-typegen` after the Wrangler AI binding is active and
	// replace this minimal shape with the generated Workers AI binding type.
	AI?: WorkersAiBinding;
	DISCORD_BOT_TOKEN?: string;
	DISCORD_NOTIFY_ROLE_ID?: string;
	DISCORD_PUBLIC_KEY?: string;
}

type DiscordInteraction = {
	type: number;
	guild_id?: string;
	channel_id?: string;
	member?: {
		user?: DiscordUser;
	};
	user?: DiscordUser;
	data?: {
		name?: string;
		custom_id?: string;
		options?: DiscordInteractionOption[];
	};
};

type DiscordUser = {
	id: string;
};

type DiscordInteractionOption = {
	name: string;
	type: number;
	value?: string;
};

type ReminderCandidate = {
	intent: "create_reminder";
	title: string;
	run_at: string;
	repeat: RepeatRule | null;
	timezone: "Asia/Seoul";
	input: string;
	created_at: string;
};

type RuleParseConfidence = "high" | "medium" | "low";

type RuleReminderParseResult =
	| {
			ok: true;
			value: ReminderCandidate;
			confidence: RuleParseConfidence;
			shouldFallbackToLlm: boolean;
			warnings: string[];
			matchedSpans: string[];
			consumedSpans: MatchedSpan[];
	  }
	| {
			ok: false;
			confidence: "low";
			shouldFallbackToLlm: boolean;
			warnings: string[];
			matchedSpans: string[];
			consumedSpans: MatchedSpan[];
	  };

type CrawlScheduleCandidate = {
	intent: "create_crawl_schedule";
	source_id: CrawlerPreset["source_id"];
	title: string;
	target_url: string;
	keywords: string[];
	interval_minutes: number;
	timezone: "Asia/Seoul";
	input: string;
	created_at: string;
};

type RepeatRule =
	| {
			type: "daily";
			time: string;
	  }
	| {
			type: "weekly";
			day_of_week: DayOfWeek;
			time: string;
	  }
	| {
			type: "interval";
			minutes: number;
	  };

type DayOfWeek =
	| "sunday"
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday";

type TimeOfDay = {
	hour: number;
	minute: number;
};

type AbsoluteDateMatch = {
	year: number | null;
	month: number;
	day: number;
	matchedText: string;
};

type PendingActionRow = {
	id: string;
	action_type: string;
	payload_json: string;
	status: string;
	expires_at: string;
};

type PendingReminderPayload = {
	title: string;
	run_at: string;
	repeat_rule: string | null;
	timezone: "Asia/Seoul";
	notify_channel_id: string;
	created_by: string;
};

type PendingCrawlSchedulePayload = {
	source_id: CrawlerPreset["source_id"];
	title: string;
	target_url: string;
	keywords: string[];
	interval_minutes: number;
	timezone: "Asia/Seoul";
	notify_channel_id: string;
	created_by: string;
};

type ScheduleRow = {
	id: string;
	type: string;
	title: string;
	target_url?: string | null;
	keywords_json?: string | null;
	run_at: string | null;
	repeat_rule?: string | null;
	interval_minutes?: number | null;
	notify_channel_id: string;
	next_run_at: string | null;
	created_by?: string | null;
	parent_schedule_id?: string | null;
	reminder_kind?: string | null;
	offset_minutes?: number | null;
};

type ScheduleListRow = ScheduleRow & {
	is_active: number;
	created_at: string;
	pre_offset_minutes?: number | null;
};

type ScheduleChangeSnapshot = {
	id: string;
	type: string;
	title: string;
	target_url: string | null;
	keywords_json: string | null;
	run_at: string | null;
	repeat_rule: string | null;
	interval_minutes: number | null;
	timezone: string;
	notify_channel_id: string;
	is_active: number;
	next_run_at: string | null;
	last_run_at: string | null;
	last_success_at: string | null;
	last_error: string | null;
	created_by: string | null;
	updated_by: string | null;
	created_at: string;
	updated_at: string;
	parent_schedule_id: string | null;
	reminder_kind: string | null;
	offset_minutes: number | null;
};

type DiscordMessageResponse = {
	id?: string;
};

type AlertMessageRow = {
	id: string;
	message: string | null;
	discord_message_id: string | null;
	discord_channel_id: string | null;
};

type AlertReadRow = {
	user_discord_id: string;
	read_at: string;
};

type CronRunContext = {
	maplestoryUpdatePostsPromise?: Promise<MapleStoryUpdatePost[]>;
};

const DISCORD_PING = 1;
const DISCORD_PONG = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const STRING_OPTION = 3;
const EPHEMERAL_FLAG = 64;
const CONFIRM_PREFIX = "confirm_reminder:";
const CANCEL_PREFIX = "cancel_reminder:";
const ACKNOWLEDGE_ALERT_PREFIX = "acknowledge_alert:";
const DELETE_SCHEDULE_PREFIX = "delete_schedule:";
const CONFIRM_DELETE_SCHEDULE_PREFIX = "confirm_delete_schedule:";
const CANCEL_DELETE_SCHEDULE_PREFIX = "cancel_delete_schedule:";
const SEOUL_TIMEZONE = "Asia/Seoul";
const SEOUL_OFFSET_HOURS = 9;
const AUTO_CHECK_MAPLESTORY_UPDATES = true;
const MAX_AUTO_UPDATE_POSTS_IN_REMINDER = 3;
const CRON_DUE_SCHEDULE_LIMIT = 20;
const MIN_INTERVAL_REMINDER_MINUTES = 5;
const MIN_INTERVAL_REMINDER_MESSAGE =
	"반복 알림은 최소 5분 간격부터 등록할 수 있어요.";
const TIME_PATTERN = String.raw`(?:(오전|오후|아침|저녁|밤|새벽)\s*)?(\d{1,2})(?:(?:\s*시\s*(?:(\d{1,2})\s*분?)?)|(?::(\d{1,2})))`;
const DAY_OF_WEEK_BY_KOREAN: Record<string, DayOfWeek> = {
	일요일: "sunday",
	월요일: "monday",
	화요일: "tuesday",
	수요일: "wednesday",
	목요일: "thursday",
	금요일: "friday",
	토요일: "saturday",
};
const KOREAN_DAY_OF_WEEK_PATTERN =
	"일요일|월요일|화요일|수요일|목요일|금요일|토요일";
const ISO_DAY_OF_WEEK_BY_DAY: Record<DayOfWeek, number> = {
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
	sunday: 7,
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET") {
			if (url.pathname === "/" || url.pathname === "/health") {
				return json({ ok: true, service: "discord-schedule-bot" });
			}
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		if (!env.DISCORD_PUBLIC_KEY) {
			return new Response("DISCORD_PUBLIC_KEY is not configured", { status: 500 });
		}

		const signature = request.headers.get("x-signature-ed25519");
		const timestamp = request.headers.get("x-signature-timestamp");
		const body = await request.text();

		if (!signature || !timestamp) {
			return new Response("Missing Discord signature headers", { status: 401 });
		}

		const isValid = await verifyDiscordRequest({
			body,
			publicKey: env.DISCORD_PUBLIC_KEY,
			signature,
			timestamp,
		});

		if (!isValid) {
			return new Response("Invalid request signature", { status: 401 });
		}

		let interaction: DiscordInteraction;
		try {
			interaction = JSON.parse(body) as DiscordInteraction;
		} catch {
			return new Response("Invalid JSON body", { status: 400 });
		}

		if (interaction.type === DISCORD_PING) {
			return json({ type: DISCORD_PONG });
		}

		return handleDiscordInteraction(interaction, env);
	},

	async scheduled(_event, env, ctx): Promise<void> {
		ctx.waitUntil(processDueSchedules(env, new Date()));
	},
} satisfies ExportedHandler<Env>;

export async function processDueSchedules(env: Env, now: Date): Promise<void> {
	const nowDueIso = formatSeoulIso(toSeoulDate(now));
	const nowUpdateIso = now.toISOString();
	const runContext: CronRunContext = {};
	const result = await env.DB.prepare(
		`SELECT
			id,
			type,
			title,
			target_url,
			keywords_json,
			run_at,
			repeat_rule,
			interval_minutes,
			notify_channel_id,
			next_run_at,
			created_by,
			parent_schedule_id,
			reminder_kind,
			offset_minutes
		FROM schedules
		WHERE is_active = 1
			AND next_run_at IS NOT NULL
			AND next_run_at <= ?
		ORDER BY next_run_at ASC
		LIMIT ${CRON_DUE_SCHEDULE_LIMIT}`,
	)
		.bind(nowDueIso)
		.all<ScheduleRow>();

	for (const schedule of result.results ?? []) {
		if (schedule.type === "reminder") {
			await processReminderSchedule(env, schedule, nowUpdateIso, runContext);
			continue;
		}

		if (schedule.type === "crawl") {
			await processCrawlSchedule(env, schedule, nowUpdateIso, runContext);
		}
	}
}

async function processCrawlSchedule(
	env: Env,
	schedule: ScheduleRow,
	nowIso: string,
	runContext: CronRunContext,
): Promise<void> {
	const intervalMinutes =
		schedule.interval_minutes ?? MAPLESTORY_UPDATE_PRESET.defaultIntervalMinutes;
	try {
		const posts = await getMaplestoryUpdatePostsForCron(runContext);
		const botToken = env.DISCORD_BOT_TOKEN ?? "";
		const newPosts = await storeNewMaplestoryUpdatePosts(env.DB, posts);

		if (newPosts.length > 0 && !botToken) {
			throw new Error("DISCORD_BOT_TOKEN is not configured");
		}

		for (const post of newPosts) {
			await sendDiscordChannelMessage({
				botToken,
				channelId: schedule.notify_channel_id,
				content: formatCrawlAlertMessage(post, env.DISCORD_NOTIFY_ROLE_ID),
				roleId: env.DISCORD_NOTIFY_ROLE_ID,
			});
		}

		await markCrawlScheduleSuccess(
			env.DB,
			schedule.id,
			nowIso,
			addMinutesToSeoulIso(new Date(nowIso), intervalMinutes),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await markCrawlScheduleFailure(env.DB, schedule.id, nowIso, message);
	}
}

async function storeNewMaplestoryUpdatePosts(
	db: D1Database,
	posts: MapleStoryUpdatePost[],
): Promise<MapleStoryUpdatePost[]> {
	const newPosts: MapleStoryUpdatePost[] = [];
	for (const post of posts) {
		const eventKey = await buildEventKey(MAPLESTORY_UPDATE_PRESET.source_key, post);
		const inserted = await insertDetectedEventIfNew(
			db,
			MAPLESTORY_UPDATE_PRESET.source_key,
			eventKey,
			post,
		);
		if (inserted) {
			newPosts.push(post);
		}
	}

	return newPosts;
}

async function insertDetectedEventIfNew(
	db: D1Database,
	sourceKey: string,
	eventKey: string,
	post: MapleStoryUpdatePost,
): Promise<boolean> {
	const existingByUrl = await db
		.prepare(
			`SELECT 1
			FROM detected_events
			WHERE schedule_id = ?
				AND source_url = ?
			LIMIT 1`,
		)
		.bind(sourceKey, post.link)
		.first();
	if (existingByUrl) {
		return false;
	}

	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO detected_events (
				id,
				schedule_id,
				event_key,
				title,
				source_url,
				detected_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			sourceKey,
			eventKey,
			post.title,
			post.link,
			new Date().toISOString(),
		)
		.run();

	return (result.meta?.changes ?? 0) > 0;
}

function formatCrawlAlertMessage(
	post: MapleStoryUpdatePost,
	roleId: string | undefined,
): string {
	const mention = roleId?.trim() ? `<@&${roleId.trim()}>\n` : "";
	return [
		`${mention}[신규 업데이트 감지]`,
		`대상: ${MAPLESTORY_UPDATE_PRESET.label}`,
		`제목: ${post.title}`,
		`날짜: ${post.date}`,
		`URL: ${post.link}`,
	].join("\n");
}

async function markCrawlScheduleSuccess(
	db: D1Database,
	scheduleId: string,
	nowIso: string,
	nextRunAt: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE schedules
			SET
				next_run_at = ?,
				last_run_at = ?,
				last_error = NULL,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			nextRunAt,
			nowIso,
			nowIso,
			scheduleId,
		)
		.run();
}

async function markCrawlScheduleFailure(
	db: D1Database,
	scheduleId: string,
	nowIso: string,
	errorMessage: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE schedules
			SET
				last_run_at = ?,
				last_error = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(nowIso, errorMessage, nowIso, scheduleId)
		.run();
}

async function processReminderSchedule(
	env: Env,
	schedule: ScheduleRow,
	nowIso: string,
	runContext: CronRunContext,
): Promise<void> {
	try {
		if (!env.DISCORD_BOT_TOKEN) {
			throw new Error("DISCORD_BOT_TOKEN is not configured");
		}

		const parentSchedule = await getPreReminderParentSchedule(env.DB, schedule);
		const maplePosts = await getAutoMaplestoryUpdatesForReminder(env.DB, runContext);
		const message = buildAlertMessageWithReadStatus(
			formatReminderAlertMessage(
				schedule,
				env.DISCORD_NOTIFY_ROLE_ID,
				maplePosts,
				parentSchedule,
			),
			[],
		);
		const alertId = crypto.randomUUID();
		const discordMessageId = await sendDiscordChannelMessage({
			botToken: env.DISCORD_BOT_TOKEN,
			channelId: schedule.notify_channel_id,
			content: message,
			components: createAlertAcknowledgeComponents(alertId),
			roleId: env.DISCORD_NOTIFY_ROLE_ID,
		});
		await insertAlert(env.DB, {
			id: alertId,
			scheduleId: schedule.id,
			title: schedule.title,
			message,
			sourceUrl: maplePosts[0]?.link ?? null,
			discordMessageId,
			discordChannelId: schedule.notify_channel_id,
			createdAt: nowIso,
		});

		const nextRunAt = await getNextReminderRunAt(env.DB, schedule, nowIso);
		await markReminderScheduleSuccess(env.DB, schedule.id, nowIso, nextRunAt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await markReminderScheduleFailure(env.DB, schedule.id, nowIso, message);
	}
}

async function getPreReminderParentSchedule(
	db: D1Database,
	schedule: ScheduleRow,
): Promise<ScheduleRow | null> {
	if (!isPreReminderSchedule(schedule) || !schedule.parent_schedule_id) {
		return null;
	}

	return await db
		.prepare(
			`SELECT
				id,
				type,
				title,
				target_url,
				keywords_json,
				run_at,
				repeat_rule,
				interval_minutes,
				notify_channel_id,
				next_run_at,
				created_by,
				parent_schedule_id,
				reminder_kind,
				offset_minutes
			FROM schedules
			WHERE id = ?`,
		)
		.bind(schedule.parent_schedule_id)
		.first<ScheduleRow>();
}

async function getNextReminderRunAt(
	db: D1Database,
	schedule: ScheduleRow,
	nowIso: string,
): Promise<string | null> {
	if (!isPreReminderSchedule(schedule)) {
		return getNextRunAt(schedule.repeat_rule, nowIso);
	}

	const parentSchedule = await getPreReminderParentSchedule(db, schedule);
	if (!parentSchedule) {
		return null;
	}

	return computeNextPreReminderRunAt(parentSchedule, nowIso);
}

async function getAutoMaplestoryUpdatesForReminder(
	db: D1Database,
	runContext: CronRunContext,
): Promise<MapleStoryUpdatePost[]> {
	if (!AUTO_CHECK_MAPLESTORY_UPDATES) {
		return [];
	}

	try {
		const posts = await getMaplestoryUpdatePostsForCron(runContext);
		const newPosts = await storeNewMaplestoryUpdatePosts(db, posts);
		return newPosts.slice(0, MAX_AUTO_UPDATE_POSTS_IN_REMINDER);
	} catch (error) {
		console.warn("MapleStory update auto-check failed", error);
		return [];
	}
}

function getMaplestoryUpdatePostsForCron(
	runContext: CronRunContext,
): Promise<MapleStoryUpdatePost[]> {
	runContext.maplestoryUpdatePostsPromise ??= fetchMaplestoryUpdatePosts(
		MAPLESTORY_UPDATE_PRESET,
	);
	return runContext.maplestoryUpdatePostsPromise;
}

async function sendDiscordChannelMessage(input: {
	botToken: string;
	channelId: string;
	content: string;
	components?: unknown[];
	roleId?: string;
}): Promise<string> {
	const roleId = input.roleId?.trim();
	const response = await fetch(
		`https://discord.com/api/v10/channels/${input.channelId}/messages`,
		{
			method: "POST",
			headers: {
				authorization: `Bot ${input.botToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				content: input.content,
				allowed_mentions: roleId
					? { roles: [roleId], users: [] }
					: suppressAllMentions(),
				...(input.components ? { components: input.components } : {}),
			}),
		},
	);

	if (!response.ok) {
		const responseBody = await response.text();
		throw new Error(
			`Discord message failed with HTTP ${response.status}: ${responseBody}`,
		);
	}

	const responseBody = (await response.json()) as DiscordMessageResponse;
	if (!responseBody.id) {
		throw new Error("Discord message response did not include an id");
	}

	return responseBody.id;
}

async function patchDiscordChannelMessage(input: {
	botToken: string;
	channelId: string;
	messageId: string;
	content: string;
	components?: unknown[];
}): Promise<void> {
	const response = await fetch(
		`https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}`,
		{
			method: "PATCH",
			headers: {
				authorization: `Bot ${input.botToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				content: input.content,
				allowed_mentions: suppressAllMentionsIncludingRoles(),
				...(input.components ? { components: input.components } : {}),
			}),
		},
	);

	if (!response.ok) {
		const responseBody = await response.text();
		throw new Error(
			`Discord message update failed with HTTP ${response.status}: ${responseBody}`,
		);
	}
}

async function insertAlert(
	db: D1Database,
	input: {
		id: string;
		scheduleId: string;
		title: string;
		message: string;
		sourceUrl: string | null;
		discordMessageId: string;
		discordChannelId: string;
		createdAt: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO alerts (
				id,
				schedule_id,
				title,
				message,
				source_url,
				discord_message_id,
				discord_channel_id,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.scheduleId,
			input.title,
			input.message,
			input.sourceUrl,
			input.discordMessageId,
			input.discordChannelId,
			input.createdAt,
		)
		.run();
}

function formatReminderAlertMessage(
	schedule: ScheduleRow,
	roleId: string | undefined,
	maplePosts: MapleStoryUpdatePost[] = [],
	parentSchedule: ScheduleRow | null = null,
): string {
	const mention = roleId?.trim() ? `<@&${roleId.trim()}>\n` : "";
	if (isPreReminderSchedule(schedule)) {
		const lines = [
			`${mention}[${PRE_REMINDER_OFFSET_MINUTES}분 전 알림]`,
			formatPreReminderAlertHeadline(schedule),
			"",
			`본 일정 시간: ${formatMainScheduleTimeForPreReminder(schedule, parentSchedule)}`,
			`알림 시간: ${formatScheduleTime(schedule)}`,
		];
		const repeatText = formatRepeatRule(parseRepeatRule(parentSchedule?.repeat_rule ?? null));
		if (repeatText !== "1회성 일정") {
			lines.push(`반복: ${repeatText}`);
		}
		appendMaplestoryUpdateLines(lines, maplePosts);
		return lines.join("\n");
	}
	const lines = [
		`${mention}[일정 알림]`,
		formatReminderAlertHeadline(schedule),
		"",
		`시간: ${formatScheduleTime(schedule)}`,
	];

	const repeatText = formatRepeatRule(parseRepeatRule(schedule.repeat_rule ?? null));
	if (repeatText !== "1회성 일정") {
		lines.push(`반복: ${repeatText}`);
	}

	if (maplePosts.length > 0) {
		lines.push("", "[신규 메이플 업데이트 감지]");
		for (const post of maplePosts) {
			lines.push(
				`- ${post.title}`,
				`  날짜: ${formatKoreanDateTime(post.date)}`,
				`  URL: ${post.link}`,
			);
		}
	}

	return lines.join("\n");
}

function appendMaplestoryUpdateLines(
	lines: string[],
	maplePosts: MapleStoryUpdatePost[],
): void {
	if (maplePosts.length === 0) {
		return;
	}

	lines.push("", "[신규 메이플 업데이트 감지]");
	for (const post of maplePosts) {
		lines.push(
			`- ${post.title}`,
			`  날짜: ${formatKoreanDateTime(post.date)}`,
			`  URL: ${post.link}`,
		);
	}
}

function formatPreReminderAlertHeadline(schedule: ScheduleRow): string {
	const creator = formatDiscordUserMention(schedule.created_by);
	if (!creator) {
		return "곧 알림 시간이 다가와요!";
	}

	const title = schedule.title.trim();
	if (!title || title === "알림") {
		return `${creator}님이 곧 알림을 보냈어요!`;
	}

	return `${creator}님이 곧 ${formatReminderActionPhrase(title)} 해요!`;
}

function formatMainScheduleTimeForPreReminder(
	schedule: ScheduleRow,
	parentSchedule: ScheduleRow | null,
): string {
	const time =
		parentSchedule?.next_run_at ??
		parentSchedule?.run_at ??
		computeMainRunAtFromPreReminder(schedule);
	return time ? formatKoreanDateTime(time) : "미정";
}

function formatReminderAlertHeadline(schedule: ScheduleRow): string {
	const creator = formatDiscordUserMention(schedule.created_by);
	if (!creator) {
		return "알림 시간이 되었어요!";
	}

	const title = schedule.title.trim();
	if (!title || title === "알림") {
		return `${creator}님이 알림을 보냈어요!`;
	}

	return `${creator}님이 ${formatReminderActionPhrase(title)} 해요!`;
}

function formatReminderActionPhrase(title: string): string {
	return /(가자|하자|돌자)$/u.test(title) ? `${title}고` : `${title} 하자고`;
}

export function buildReadStatusSection(readUserIds: string[]): string {
	const uniqueUserIds = [...new Set(readUserIds.map((id) => id.trim()).filter(Boolean))];
	if (uniqueUserIds.length === 0) {
		return "[확인 현황]\n아직 확인한 사람이 없습니다.";
	}

	return [
		"[확인 현황]",
		...uniqueUserIds.map((userId) => `✅ <@${userId}>`),
	].join("\n");
}

export function stripReadStatusSection(message: string | null | undefined): string {
	if (!message) {
		return "";
	}

	const readStatusIndex = message.lastIndexOf("[확인 현황]");
	if (readStatusIndex < 0) {
		return message.trimEnd();
	}

	return message.slice(0, readStatusIndex).trimEnd();
}

export function buildAlertMessageWithReadStatus(
	baseMessage: string | null | undefined,
	readUserIds: string[],
): string {
	const strippedMessage = stripReadStatusSection(baseMessage);
	const readStatusSection = buildReadStatusSection(readUserIds);
	return strippedMessage ? `${strippedMessage}\n\n${readStatusSection}` : readStatusSection;
}

async function markReminderScheduleSuccess(
	db: D1Database,
	scheduleId: string,
	nowIso: string,
	nextRunAt: string | null,
): Promise<void> {
	if (nextRunAt) {
		await db
			.prepare(
				`UPDATE schedules
				SET
					is_active = 1,
					next_run_at = ?,
					last_run_at = ?,
					last_success_at = ?,
					last_error = NULL,
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(nextRunAt, nowIso, nowIso, nowIso, scheduleId)
			.run();
		return;
	}

	await db
		.prepare(
			`UPDATE schedules
			SET
				is_active = 0,
				next_run_at = NULL,
				last_run_at = ?,
				last_success_at = ?,
				last_error = NULL,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(nowIso, nowIso, nowIso, scheduleId)
		.run();
}

async function markReminderScheduleFailure(
	db: D1Database,
	scheduleId: string,
	nowIso: string,
	errorMessage: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE schedules
			SET
				last_run_at = ?,
				last_error = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(nowIso, errorMessage, nowIso, scheduleId)
		.run();
}

async function handleDiscordInteraction(
	interaction: DiscordInteraction,
	env: Env,
): Promise<Response> {
	if (interaction.type === APPLICATION_COMMAND) {
		return handleSlashCommand(interaction, env);
	}

	if (interaction.type === MESSAGE_COMPONENT) {
		return handleMessageComponent(interaction, env);
	}

	return jsonEphemeralInteractionResponse("지원하지 않는 interaction입니다.");
}

async function handleSlashCommand(
	interaction: DiscordInteraction,
	env: Env,
): Promise<Response> {
	if (interaction.data?.name !== "알림") {
		return jsonEphemeralInteractionResponse("지원하지 않는 명령어입니다.");
	}

	const input = getStringOption(interaction, "내용");
	if (!input) {
		return jsonEphemeralInteractionResponse("알림 내용을 입력해 주세요.");
	}

	if (isHelpIntent(input)) {
		return jsonPublicInteractionResponse(formatHelpMessage(), {
			allowedMentions: suppressAllMentions(),
		});
	}

	if (isScheduleListRequest(input)) {
		const channelId = interaction.channel_id;
		if (!channelId) {
			return jsonEphemeralInteractionResponse("현재 채널 정보를 확인할 수 없습니다.");
		}

		try {
			const schedules = await listActiveSchedulesForChannel(env.DB, channelId);
			const components = createScheduleDeleteComponents(schedules);
			return jsonPublicInteractionResponse(formatScheduleList(schedules), {
				...(components.length > 0 ? { components } : {}),
				allowedMentions: suppressAllMentions(),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`목록 조회 중 오류가 발생했습니다: ${message}`);
		}
	}

	const crawlSchedule = ruleParseCrawlSchedule(input);
	if (crawlSchedule) {
		const channelId = interaction.channel_id;
		const userId = getInteractionUserId(interaction);
		if (!channelId || !userId) {
			return jsonEphemeralInteractionResponse("등록에 필요한 Discord 정보를 확인할 수 없습니다.");
		}

		let pendingId: string;
		try {
			pendingId = await createPendingCrawlScheduleAction(env.DB, crawlSchedule, {
				channelId,
				guildId: interaction.guild_id ?? null,
				userId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`등록 후보 저장 중 오류가 발생했습니다: ${message}`);
		}

		return jsonPublicInteractionResponse(formatCrawlScheduleCandidate(crawlSchedule), {
			components: createConfirmCancelComponents(pendingId),
			allowedMentions: suppressAllMentions(),
		});
	}

	const reminderResult = ruleParseReminderDetailed(input);
	if (!reminderResult.ok || reminderResult.shouldFallbackToLlm) {
		const isTooShortInterval = isTooShortIntervalReminderRequest(input);
		if (isTooShortInterval) {
			return jsonEphemeralInteractionResponse(MIN_INTERVAL_REMINDER_MESSAGE);
		}

		if (
			shouldUseLlmFallback({
				isListRequest: false,
				hasRuleBasedCandidate: false,
				isTooShortIntervalRequest: isTooShortInterval,
			})
		) {
			const llmResponse = await handleLlmScheduleCandidate(input, interaction, env);
			if (llmResponse) {
				return llmResponse;
			}
		}

		return jsonEphemeralInteractionResponse(
			"아직 해석할 수 없는 알림 형식입니다. 예: 내일 오전 9시에 회의 알려줘",
		);
	}

	const reminder = reminderResult.value;
	const channelId = interaction.channel_id;
	const userId = getInteractionUserId(interaction);
	if (!channelId || !userId) {
		return jsonEphemeralInteractionResponse("등록에 필요한 Discord 정보를 확인할 수 없습니다.");
	}

	let pendingId: string;
	try {
		pendingId = await createPendingReminderAction(env.DB, reminder, {
			channelId,
			guildId: interaction.guild_id ?? null,
			userId,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return jsonEphemeralInteractionResponse(`등록 후보 저장 중 오류가 발생했습니다: ${message}`);
	}

	return jsonPublicInteractionResponse(formatReminderCandidate(reminder), {
		components: createConfirmCancelComponents(pendingId),
		allowedMentions: suppressAllMentions(),
	});
}

async function handleMessageComponent(
	interaction: DiscordInteraction,
	env: Env,
): Promise<Response> {
	const customId = interaction.data?.custom_id;
	if (!customId) {
		return jsonEphemeralInteractionResponse("버튼 정보를 확인할 수 없습니다.");
	}

	if (customId.startsWith(ACKNOWLEDGE_ALERT_PREFIX)) {
		const alertId = customId.slice(ACKNOWLEDGE_ALERT_PREFIX.length);
		const userId = getInteractionUserId(interaction);
		if (!userId) {
			return jsonEphemeralInteractionResponse("확인 처리에 필요한 Discord 사용자 정보를 확인할 수 없습니다.");
		}

		try {
			await insertAlertRead(env.DB, alertId, userId);
			try {
				await updateAlertReadStatusMessage(env, alertId);
			} catch (error) {
				console.warn("Alert read status message update failed", error);
			}
			return jsonEphemeralInteractionResponse("확인 처리했습니다.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`확인 처리 중 오류가 발생했습니다: ${message}`);
		}
	}

	if (customId.startsWith(CANCEL_PREFIX)) {
		const pendingId = customId.slice(CANCEL_PREFIX.length);
		const pending = await getPendingAction(env.DB, pendingId);
		if (!isPendingActionUsable(pending, new Date())) {
			return jsonEphemeralInteractionResponse("이미 처리되었거나 만료된 요청입니다.");
		}

		try {
			await markPendingActionConsumed(env.DB, pendingId, "cancelled");
			return jsonEphemeralInteractionResponse("등록을 취소했습니다.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`취소 중 오류가 발생했습니다: ${message}`);
		}
	}

	if (customId.startsWith(CONFIRM_PREFIX)) {
		const pendingId = customId.slice(CONFIRM_PREFIX.length);
		const pending = await getPendingAction(env.DB, pendingId);
		if (!isPendingActionUsable(pending, new Date())) {
			return jsonEphemeralInteractionResponse("이미 처리되었거나 만료된 요청입니다.");
		}

		if (pending.action_type === "create_reminder") {
			const payload = parsePendingReminderPayload(pending.payload_json);
			if (!payload) {
				return jsonEphemeralInteractionResponse("등록 후보 데이터를 안전하게 읽을 수 없습니다.");
			}

			try {
				await insertReminderScheduleFromPending(env.DB, payload);
				await markPendingActionConsumed(env.DB, pendingId, "confirmed");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonEphemeralInteractionResponse(`등록 중 오류가 발생했습니다: ${message}`);
			}

			return jsonPublicInteractionResponse("등록 완료", {
				allowedMentions: suppressAllMentions(),
			});
		}

		if (pending.action_type === "create_crawl_schedule") {
			const payload = parsePendingCrawlSchedulePayload(pending.payload_json);
			if (!payload) {
				return jsonEphemeralInteractionResponse("크롤러 등록 후보 데이터를 안전하게 읽을 수 없습니다.");
			}

			try {
				await insertCrawlScheduleFromPending(env.DB, payload);
				await markPendingActionConsumed(env.DB, pendingId, "confirmed");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonEphemeralInteractionResponse(`크롤러 등록 중 오류가 발생했습니다: ${message}`);
			}

			return jsonPublicInteractionResponse("등록 완료", {
				allowedMentions: suppressAllMentions(),
			});
		}

		return jsonEphemeralInteractionResponse("지원하지 않는 등록 후보입니다.");
	}

	if (customId.startsWith(DELETE_SCHEDULE_PREFIX)) {
		const scheduleId = customId.slice(DELETE_SCHEDULE_PREFIX.length);
		return jsonEphemeralInteractionResponse("정말 삭제할까요?", {
			components: [
				{
					type: 1,
					components: [
						{
							type: 2,
							style: 4,
							label: "삭제",
							custom_id: `${CONFIRM_DELETE_SCHEDULE_PREFIX}${scheduleId}`,
						},
						{
							type: 2,
							style: 2,
							label: "취소",
							custom_id: `${CANCEL_DELETE_SCHEDULE_PREFIX}${scheduleId}`,
						},
					],
				},
			],
		});
	}

	if (customId.startsWith(CANCEL_DELETE_SCHEDULE_PREFIX)) {
		return jsonEphemeralInteractionResponse("삭제를 취소했습니다.");
	}

	if (customId.startsWith(CONFIRM_DELETE_SCHEDULE_PREFIX)) {
		const scheduleId = customId.slice(CONFIRM_DELETE_SCHEDULE_PREFIX.length);
		const userId = getInteractionUserId(interaction);
		if (!userId) {
			return jsonEphemeralInteractionResponse("삭제에 필요한 Discord 사용자 정보를 확인할 수 없습니다.");
		}

		try {
			const result = await confirmDeleteSchedule(env.DB, scheduleId, userId);
			if (result === "not_found") {
				return jsonEphemeralInteractionResponse("없는 일정이거나 이미 삭제된 일정입니다.");
			}

			return jsonPublicInteractionResponse("삭제 완료", {
				allowedMentions: suppressAllMentions(),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`삭제 중 오류가 발생했습니다: ${message}`);
		}
	}

	return jsonEphemeralInteractionResponse("지원하지 않는 버튼입니다.");
}

async function handleLlmScheduleCandidate(
	input: string,
	interaction: DiscordInteraction,
	env: Env,
): Promise<Response | null> {
	const result = await parseWithLlm(input, { now: new Date() }, env);
	if (result.status === "disabled") {
		return null;
	}

	if (result.status === "invalid") {
		return jsonEphemeralInteractionResponse(result.userMessage);
	}

	const channelId = interaction.channel_id;
	const userId = getInteractionUserId(interaction);
	if (!channelId || !userId) {
		return jsonEphemeralInteractionResponse("등록에 필요한 Discord 정보를 확인할 수 없습니다.");
	}

	return createScheduleCandidateResponseFromLlm(input, result.value, interaction, env, {
		channelId,
		userId,
	});
}

async function createScheduleCandidateResponseFromLlm(
	input: string,
	value: NormalizedLlmIntent,
	interaction: DiscordInteraction,
	env: Env,
	context: { channelId: string; userId: string },
): Promise<Response> {
	if (value.intent === "create_crawl_schedule") {
		const crawlSchedule = createCrawlCandidateFromLlm(input, value);
		let pendingId: string;
		try {
			pendingId = await createPendingCrawlScheduleAction(env.DB, crawlSchedule, {
				channelId: context.channelId,
				guildId: interaction.guild_id ?? null,
				userId: context.userId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonEphemeralInteractionResponse(`등록 후보 저장 중 오류가 발생했습니다: ${message}`);
		}

		return jsonPublicInteractionResponse(formatCrawlScheduleCandidate(crawlSchedule), {
			components: createConfirmCancelComponents(pendingId),
			allowedMentions: suppressAllMentions(),
		});
	}

	const reminder = createReminderCandidateFromLlm(input, value);
	if (!reminder) {
		return jsonEphemeralInteractionResponse(
			"시간을 정확히 이해하지 못했어요. 예: /알림 내일 오후 9시 30분에 보스 알려줘",
		);
	}

	let pendingId: string;
	try {
		pendingId = await createPendingReminderAction(env.DB, reminder, {
			channelId: context.channelId,
			guildId: interaction.guild_id ?? null,
			userId: context.userId,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return jsonEphemeralInteractionResponse(`등록 후보 저장 중 오류가 발생했습니다: ${message}`);
	}

	return jsonPublicInteractionResponse(formatReminderCandidate(reminder), {
		components: createConfirmCancelComponents(pendingId),
		allowedMentions: suppressAllMentions(),
	});
}

function createReminderCandidateFromLlm(
	input: string,
	value: Extract<NormalizedLlmIntent, { intent: "create_reminder" }>,
): ReminderCandidate | null {
	const repeat = normalizeRepeatRuleFromLlm(value.repeat_rule);
	const runAt =
		value.run_at ??
		(repeat ? getNextRunAt(JSON.stringify(repeat), new Date().toISOString()) : null);
	if (!runAt) {
		return null;
	}

	return {
		intent: "create_reminder",
		title: normalizeReminderTitle(value.title),
		run_at: runAt,
		repeat,
		timezone: "Asia/Seoul",
		input,
		created_at: new Date().toISOString(),
	};
}

function normalizeRepeatRuleFromLlm(
	repeatRule: NormalizedRepeatRule | null,
): RepeatRule | null {
	if (!repeatRule) {
		return null;
	}

	if (repeatRule.type === "daily") {
		return { type: "daily", time: repeatRule.time };
	}

	if (repeatRule.type === "weekly") {
		return {
			type: "weekly",
			day_of_week: repeatRule.day_of_week,
			time: repeatRule.time,
		};
	}

	return {
		type: "interval",
		minutes: repeatRule.minutes,
	};
}

function createCrawlCandidateFromLlm(
	input: string,
	value: Extract<NormalizedLlmIntent, { intent: "create_crawl_schedule" }>,
): CrawlScheduleCandidate {
	return {
		intent: "create_crawl_schedule",
		source_id: value.source_id,
		title: value.title,
		target_url: MAPLESTORY_UPDATE_PRESET.url,
		keywords: [...MAPLESTORY_UPDATE_PRESET.keywords],
		interval_minutes: value.interval_minutes,
		timezone: "Asia/Seoul",
		input,
		created_at: new Date().toISOString(),
	};
}

export function isScheduleListRequest(input: string): boolean {
	const normalized = input
		.replace(/[?!？！，,。\.]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const compact = normalized.replace(/\s+/g, "");
	if (!compact) {
		return false;
	}

	if (hasScheduleMutationIntent(compact)) {
		return false;
	}

	const hasTarget =
		compact.includes("일정") ||
		compact.includes("알림") ||
		compact.includes("스케줄");
	const hasListWord = compact.includes("목록") || compact.includes("리스트");
	const hasShowWord = compact.includes("보여줘");
	const hasWhatExists = compact.includes("뭐있어");
	const hasStateWord =
		compact.includes("등록된") ||
		compact.includes("예약된") ||
		compact.includes("현재") ||
		compact.includes("지금등록된");

	if (compact === "목록" || compact === "리스트") {
		return true;
	}

	if (hasListWord) {
		return hasTarget || hasShowWord || hasStateWord;
	}

	if (hasTarget && (hasShowWord || hasWhatExists || hasStateWord)) {
		return true;
	}

	return hasStateWord && hasShowWord;
}

function hasScheduleMutationIntent(compact: string): boolean {
	return [
		"삭제",
		"취소",
		"등록해",
		"등록해줘",
		"추가",
		"추가해",
		"추가해줘",
		"잡아줘",
		"잡아",
		"생성",
		"만들어",
		"켜줘",
		"꺼줘",
	].some((keyword) => compact.includes(keyword));
}

export function isHelpIntent(input: string): boolean {
	const normalized = input
		.replace(/[?!？！，,。\.]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const compact = normalized.replace(/\s+/g, "");
	if (!normalized) {
		return false;
	}

	if (looksLikeScheduleRequest(compact)) {
		return false;
	}

	const exactHelpPhrases = new Set([
		"사용법",
		"도움말",
		"명령어",
		"기능",
		"할 수 있는 것",
		"가능한 것",
	]);
	if (exactHelpPhrases.has(normalized)) {
		return true;
	}

	const compactHelpPhrases = [
		"너는뭐야",
		"너뭐야",
		"너는누구야",
		"너누구야",
		"너는무엇을할수있어",
		"너는뭘할수있어",
		"너뭐할수있어",
		"뭐할수있어",
		"사용법알려줘",
		"도움말알려줘",
		"명령어알려줘",
		"기능알려줘",
		"할수있는것",
		"가능한것",
	];
	return compactHelpPhrases.some((phrase) => compact.includes(phrase));
}

function looksLikeScheduleRequest(compactInput: string): boolean {
	const scheduleTokens = [
		"오늘",
		"내일",
		"모레",
		"이번주",
		"다음주",
		"매일",
		"매주",
		"분마다",
		"시간마다",
		"등록",
		"감지",
		"패치",
		"업데이트",
	];
	return scheduleTokens.some((token) => compactInput.includes(token)) || /\d/.test(compactInput);
}

export function formatHelpMessage(): string {
	return [
		"안녕하세요! 저는 Discord 안에서 일정과 메이플 업데이트 알림을 도와주는 알림봇이에요.",
		"",
		"제가 할 수 있는 일:",
		"- 자연어로 일정 등록하기",
		"  예: /알림 내일 오후 9시 30분에 보스 알려줘",
		"- 반복 일정 등록하기",
		"  예: /알림 매주 월요일 오후 9시 30분에 보스 알려줘",
		"  예: /알림 매일 오전 8시에 알려줘",
		"- 등록된 알림 목록 보기",
		"  예: /알림 목록",
		"- 알림 삭제하기",
		"  목록에서 삭제 버튼을 눌러 삭제할 수 있어요.",
		"- 알림 시간이 되면 역할 멘션으로 알려주기",
		"- 알림을 확인한 사람을 [확인했어요] 버튼으로 기록하기",
		"- 일정 알림 시 메이플스토리 신규 업데이트가 있으면 함께 알려주기",
		"",
		"현재 할 수 없는 일:",
		"- 로그인이나 CAPTCHA가 필요한 사이트 확인",
		"- 사용자가 직접 입력한 임의 URL 크롤링",
		"- Discord 앱/휴대폰 알림 설정이 꺼진 사람에게 강제로 푸시 보내기",
		"- 너무 짧은 간격의 반복 알림",
		"- 모든 자연어를 완벽하게 이해하기",
		"",
		"사용 팁:",
		'- 시간을 구체적으로 적어주면 더 잘 알아들어요. 예: "다음주 월요일 오후 9시 30분"',
		'- 반복 일정은 이렇게 적을 수 있어요. 예: "매주 목요일 오전 10시"',
		"- 잘못 등록했다면 목록에서 삭제하고 다시 등록하면 돼요.",
		"- 메이플 업데이트는 고정된 공식 업데이트 페이지 기준으로만 자동 확인해요.",
	].join("\n");
}

export async function listActiveSchedulesForChannel(
	db: D1Database,
	channelId: string,
): Promise<ScheduleListRow[]> {
	const result = await db
		.prepare(
			`SELECT
				s.id,
				s.type,
				s.title,
				s.target_url,
				s.keywords_json,
				s.run_at,
				s.repeat_rule,
				s.interval_minutes,
				s.notify_channel_id,
				s.next_run_at,
				s.is_active,
				s.created_by,
				s.created_at,
				s.parent_schedule_id,
				s.reminder_kind,
				s.offset_minutes,
				pre.offset_minutes AS pre_offset_minutes
			FROM schedules s
			LEFT JOIN schedules pre
				ON pre.parent_schedule_id = s.id
				AND pre.reminder_kind = 'pre'
				AND pre.is_active = 1
			WHERE s.is_active = 1
				AND s.notify_channel_id = ?
				AND (s.reminder_kind IS NULL OR s.reminder_kind = 'main')
			ORDER BY
				CASE WHEN s.next_run_at IS NULL THEN 1 ELSE 0 END ASC,
				s.next_run_at ASC,
				s.created_at DESC
			LIMIT 10`,
		)
		.bind(channelId)
		.all<ScheduleListRow>();

	return [...(result.results ?? [])];
}

export async function confirmDeleteSchedule(
	db: D1Database,
	scheduleId: string,
	changedBy: string,
): Promise<"deleted" | "not_found"> {
	const before = await getActiveScheduleSnapshot(db, scheduleId);
	if (!before) {
		return "not_found";
	}

	const now = new Date().toISOString();
	const preReminders = await getActivePreReminderSnapshots(db, scheduleId);
	await db
		.prepare(
			`UPDATE schedules
			SET
				is_active = 0,
				next_run_at = NULL,
				updated_by = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(changedBy, now, scheduleId)
		.run();
	await db
		.prepare(
			`UPDATE schedules
			SET
				is_active = 0,
				next_run_at = NULL,
				updated_by = ?,
				updated_at = ?
			WHERE parent_schedule_id = ?
				AND reminder_kind = 'pre'
				AND is_active = 1`,
		)
		.bind(changedBy, now, scheduleId)
		.run();

	const after: ScheduleChangeSnapshot = {
		...before,
		is_active: 0,
		next_run_at: null,
		updated_by: changedBy,
		updated_at: now,
	};
	await insertScheduleChange(db, {
		scheduleId,
		changedBy,
		changeType: "delete",
		beforeJson: JSON.stringify(before),
		afterJson: JSON.stringify(after),
	});
	for (const preReminder of preReminders) {
		await insertScheduleChange(db, {
			scheduleId: preReminder.id,
			changedBy,
			changeType: "delete_pre_reminder",
			beforeJson: JSON.stringify(preReminder),
			afterJson: JSON.stringify({
				...preReminder,
				is_active: 0,
				next_run_at: null,
				updated_by: changedBy,
				updated_at: now,
			}),
		});
	}

	return "deleted";
}

async function getActivePreReminderSnapshots(
	db: D1Database,
	parentScheduleId: string,
): Promise<ScheduleChangeSnapshot[]> {
	const result = await db
		.prepare(
			`SELECT
				id,
				type,
				title,
				target_url,
				keywords_json,
				run_at,
				repeat_rule,
				interval_minutes,
				timezone,
				notify_channel_id,
				is_active,
				next_run_at,
				last_run_at,
				last_success_at,
				last_error,
				created_by,
				updated_by,
				created_at,
				updated_at,
				parent_schedule_id,
				reminder_kind,
				offset_minutes
			FROM schedules
			WHERE parent_schedule_id = ?
				AND reminder_kind = 'pre'
				AND is_active = 1`,
		)
		.bind(parentScheduleId)
		.all<ScheduleChangeSnapshot>();

	return [...(result.results ?? [])];
}

export async function createPendingReminderAction(
	db: D1Database,
	reminder: ReminderCandidate,
	context: { channelId: string; guildId: string | null; userId: string },
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
	const payload: PendingReminderPayload = {
		title: reminder.title,
		run_at: reminder.run_at,
		repeat_rule: reminder.repeat ? JSON.stringify(reminder.repeat) : null,
		timezone: reminder.timezone,
		notify_channel_id: context.channelId,
		created_by: context.userId,
	};

	await db
		.prepare(
			`INSERT INTO pending_actions (
				id,
				action_type,
				payload_json,
				status,
				created_by,
				channel_id,
				guild_id,
				expires_at,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			"create_reminder",
			JSON.stringify(payload),
			"pending",
			context.userId,
			context.channelId,
			context.guildId,
			expiresAt,
			nowIso,
			nowIso,
		)
		.run();

	return id;
}

export async function createPendingCrawlScheduleAction(
	db: D1Database,
	candidate: CrawlScheduleCandidate,
	context: { channelId: string; guildId: string | null; userId: string },
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
	const payload: PendingCrawlSchedulePayload = {
		source_id: candidate.source_id,
		title: candidate.title,
		target_url: candidate.target_url,
		keywords: candidate.keywords,
		interval_minutes: candidate.interval_minutes,
		timezone: candidate.timezone,
		notify_channel_id: context.channelId,
		created_by: context.userId,
	};

	await db
		.prepare(
			`INSERT INTO pending_actions (
				id,
				action_type,
				payload_json,
				status,
				created_by,
				channel_id,
				guild_id,
				expires_at,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			"create_crawl_schedule",
			JSON.stringify(payload),
			"pending",
			context.userId,
			context.channelId,
			context.guildId,
			expiresAt,
			nowIso,
			nowIso,
		)
		.run();

	return id;
}

export async function getPendingAction(
	db: D1Database,
	pendingId: string,
): Promise<PendingActionRow | null> {
	const row = await db
		.prepare(
			`SELECT
				id,
				action_type,
				payload_json,
				status,
				expires_at
			FROM pending_actions
			WHERE id = ?`,
		)
		.bind(pendingId)
		.first<PendingActionRow>();

	return row ?? null;
}

export function isPendingActionUsable(
	pending: PendingActionRow | null,
	now: Date,
): pending is PendingActionRow {
	return (
		pending !== null &&
		(pending.action_type === "create_reminder" ||
			pending.action_type === "create_crawl_schedule") &&
		pending.status === "pending" &&
		new Date(pending.expires_at).getTime() > now.getTime()
	);
}

export function parsePendingReminderPayload(
	payloadJson: string,
): PendingReminderPayload | null {
	try {
		const parsed = JSON.parse(payloadJson) as Partial<PendingReminderPayload>;
		if (
			typeof parsed.title === "string" &&
			typeof parsed.run_at === "string" &&
			(parsed.repeat_rule === null || typeof parsed.repeat_rule === "string") &&
			parsed.timezone === SEOUL_TIMEZONE &&
			typeof parsed.notify_channel_id === "string" &&
			typeof parsed.created_by === "string"
		) {
			return {
				title: parsed.title,
				run_at: parsed.run_at,
				repeat_rule: parsed.repeat_rule ?? null,
				timezone: parsed.timezone,
				notify_channel_id: parsed.notify_channel_id,
				created_by: parsed.created_by,
			};
		}
	} catch {
		return null;
	}

	return null;
}

export function parsePendingCrawlSchedulePayload(
	payloadJson: string,
): PendingCrawlSchedulePayload | null {
	try {
		const parsed = JSON.parse(payloadJson) as Partial<PendingCrawlSchedulePayload>;
		if (
			parsed.source_id === MAPLESTORY_UPDATE_PRESET.source_id &&
			typeof parsed.title === "string" &&
			typeof parsed.target_url === "string" &&
			Array.isArray(parsed.keywords) &&
			parsed.keywords.every((keyword) => typeof keyword === "string") &&
			typeof parsed.interval_minutes === "number" &&
			Number.isInteger(parsed.interval_minutes) &&
			parsed.interval_minutes > 0 &&
			parsed.timezone === SEOUL_TIMEZONE &&
			typeof parsed.notify_channel_id === "string" &&
			typeof parsed.created_by === "string"
		) {
			return {
				source_id: parsed.source_id,
				title: parsed.title,
				target_url: parsed.target_url,
				keywords: parsed.keywords,
				interval_minutes: parsed.interval_minutes,
				timezone: parsed.timezone,
				notify_channel_id: parsed.notify_channel_id,
				created_by: parsed.created_by,
			};
		}
	} catch {
		return null;
	}

	return null;
}

export async function markPendingActionConsumed(
	db: D1Database,
	pendingId: string,
	status: "confirmed" | "cancelled",
): Promise<void> {
	const nowDate = new Date();
	const now = nowDate.toISOString();
	await db
		.prepare(
			`UPDATE pending_actions
			SET
				status = ?,
				consumed_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(status, now, now, pendingId)
		.run();
}

export async function insertReminderSchedule(
	db: D1Database,
	reminder: ReminderCandidate,
	context: { channelId: string; userId: string },
): Promise<void> {
	await insertReminderScheduleFromPending(db, {
		title: reminder.title,
		run_at: reminder.run_at,
		repeat_rule: reminder.repeat ? JSON.stringify(reminder.repeat) : null,
		timezone: reminder.timezone,
		notify_channel_id: context.channelId,
		created_by: context.userId,
	});
}

export async function insertReminderScheduleFromPending(
	db: D1Database,
	payload: PendingReminderPayload,
): Promise<void> {
	const nowDate = new Date();
	const now = nowDate.toISOString();
	const scheduleId = crypto.randomUUID();
	const scheduleSnapshot: ScheduleChangeSnapshot = {
		id: scheduleId,
		type: "reminder",
		title: payload.title,
		target_url: null,
		keywords_json: null,
		run_at: payload.run_at,
		repeat_rule: payload.repeat_rule,
		interval_minutes: null,
		timezone: payload.timezone,
		notify_channel_id: payload.notify_channel_id,
		is_active: 1,
		next_run_at: payload.run_at,
		last_run_at: null,
		last_success_at: null,
		last_error: null,
		created_by: payload.created_by,
		updated_by: payload.created_by,
		created_at: now,
		updated_at: now,
		parent_schedule_id: null,
		reminder_kind: "main",
		offset_minutes: null,
	};

	await db
		.prepare(
			`INSERT INTO schedules (
				id,
				type,
				title,
				run_at,
				repeat_rule,
				timezone,
				notify_channel_id,
				is_active,
				next_run_at,
				parent_schedule_id,
				reminder_kind,
				offset_minutes,
				created_by,
				updated_by,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			scheduleSnapshot.id,
			scheduleSnapshot.type,
			scheduleSnapshot.title,
			scheduleSnapshot.run_at,
			scheduleSnapshot.repeat_rule,
			scheduleSnapshot.timezone,
			scheduleSnapshot.notify_channel_id,
			scheduleSnapshot.is_active,
			scheduleSnapshot.next_run_at,
			scheduleSnapshot.parent_schedule_id,
			scheduleSnapshot.reminder_kind,
			scheduleSnapshot.offset_minutes,
			scheduleSnapshot.created_by,
			scheduleSnapshot.updated_by,
			scheduleSnapshot.created_at,
			scheduleSnapshot.updated_at,
		)
		.run();

	await insertScheduleChange(db, {
		scheduleId,
		changedBy: payload.created_by,
		changeType: "create",
		beforeJson: null,
		afterJson: JSON.stringify(scheduleSnapshot),
	});

	const preReminderSnapshot = buildPreReminderScheduleSnapshot(
		scheduleSnapshot,
		payload.created_by,
		now,
		nowDate,
	);
	if (!preReminderSnapshot) {
		return;
	}

	await db
		.prepare(
			`INSERT INTO schedules (
				id,
				type,
				title,
				run_at,
				repeat_rule,
				timezone,
				notify_channel_id,
				is_active,
				next_run_at,
				parent_schedule_id,
				reminder_kind,
				offset_minutes,
				created_by,
				updated_by,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			preReminderSnapshot.id,
			preReminderSnapshot.type,
			preReminderSnapshot.title,
			preReminderSnapshot.run_at,
			preReminderSnapshot.repeat_rule,
			preReminderSnapshot.timezone,
			preReminderSnapshot.notify_channel_id,
			preReminderSnapshot.is_active,
			preReminderSnapshot.next_run_at,
			preReminderSnapshot.parent_schedule_id,
			preReminderSnapshot.reminder_kind,
			preReminderSnapshot.offset_minutes,
			preReminderSnapshot.created_by,
			preReminderSnapshot.updated_by,
			preReminderSnapshot.created_at,
			preReminderSnapshot.updated_at,
		)
		.run();

	await insertScheduleChange(db, {
		scheduleId: preReminderSnapshot.id,
		changedBy: payload.created_by,
		changeType: "create_pre_reminder",
		beforeJson: null,
		afterJson: JSON.stringify(preReminderSnapshot),
	});
}

function buildPreReminderScheduleSnapshot(
	mainSchedule: ScheduleChangeSnapshot,
	createdBy: string,
	nowIso: string,
	nowDate: Date,
): ScheduleChangeSnapshot | null {
	if (mainSchedule.type !== "reminder" || !mainSchedule.run_at) {
		return null;
	}

	if (!isPreReminderEligible(mainSchedule.repeat_rule)) {
		return null;
	}

	const nextRunAt = computeNextPreReminderRunAt(mainSchedule, nowIso);
	if (!nextRunAt || new Date(nextRunAt).getTime() <= nowDate.getTime()) {
		return null;
	}

	return {
		...mainSchedule,
		id: crypto.randomUUID(),
		run_at: nextRunAt,
		repeat_rule: buildPreReminderRepeatRule(mainSchedule.repeat_rule),
		next_run_at: nextRunAt,
		parent_schedule_id: mainSchedule.id,
		reminder_kind: "pre",
		offset_minutes: -PRE_REMINDER_OFFSET_MINUTES,
		created_by: createdBy,
		updated_by: createdBy,
		created_at: nowIso,
		updated_at: nowIso,
		last_run_at: null,
		last_success_at: null,
		last_error: null,
	};
}

export async function insertCrawlScheduleFromPending(
	db: D1Database,
	payload: PendingCrawlSchedulePayload,
): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();
	const scheduleId = crypto.randomUUID();
	const nextRunAt = addMinutesToSeoulIso(now, payload.interval_minutes);
	const scheduleSnapshot: ScheduleChangeSnapshot = {
		id: scheduleId,
		type: "crawl",
		title: payload.title,
		target_url: payload.target_url,
		keywords_json: JSON.stringify(payload.keywords),
		run_at: null,
		repeat_rule: null,
		interval_minutes: payload.interval_minutes,
		timezone: payload.timezone,
		notify_channel_id: payload.notify_channel_id,
		is_active: 1,
		next_run_at: nextRunAt,
		last_run_at: null,
		last_success_at: null,
		last_error: null,
		created_by: payload.created_by,
		updated_by: payload.created_by,
		created_at: nowIso,
		updated_at: nowIso,
		parent_schedule_id: null,
		reminder_kind: "main",
		offset_minutes: null,
	};

	await db
		.prepare(
			`INSERT INTO schedules (
				id,
				type,
				title,
				target_url,
				keywords_json,
				interval_minutes,
				timezone,
				notify_channel_id,
				is_active,
				next_run_at,
				created_by,
				updated_by,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			scheduleSnapshot.id,
			scheduleSnapshot.type,
			scheduleSnapshot.title,
			scheduleSnapshot.target_url,
			scheduleSnapshot.keywords_json,
			scheduleSnapshot.interval_minutes,
			scheduleSnapshot.timezone,
			scheduleSnapshot.notify_channel_id,
			scheduleSnapshot.is_active,
			scheduleSnapshot.next_run_at,
			scheduleSnapshot.created_by,
			scheduleSnapshot.updated_by,
			scheduleSnapshot.created_at,
			scheduleSnapshot.updated_at,
		)
		.run();

	await insertScheduleChange(db, {
		scheduleId,
		changedBy: payload.created_by,
		changeType: "create",
		beforeJson: null,
		afterJson: JSON.stringify(scheduleSnapshot),
	});
}

async function getActiveScheduleSnapshot(
	db: D1Database,
	scheduleId: string,
): Promise<ScheduleChangeSnapshot | null> {
	const row = await db
		.prepare(
			`SELECT
				id,
				type,
				title,
				target_url,
				keywords_json,
				run_at,
				repeat_rule,
				interval_minutes,
				timezone,
				notify_channel_id,
				is_active,
				next_run_at,
				last_run_at,
				last_success_at,
				last_error,
				created_by,
				updated_by,
				created_at,
				updated_at,
				parent_schedule_id,
				reminder_kind,
				offset_minutes
			FROM schedules
			WHERE id = ?
				AND is_active = 1`,
		)
		.bind(scheduleId)
		.first<ScheduleChangeSnapshot>();

	return row ?? null;
}

export async function insertScheduleChange(
	db: D1Database,
	input: {
		scheduleId: string;
		changedBy: string;
		changeType: "create" | "delete" | "create_pre_reminder" | "delete_pre_reminder";
		beforeJson: string | null;
		afterJson: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO schedule_changes (
				id,
				schedule_id,
				changed_by,
				change_type,
				before_json,
				after_json,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.scheduleId,
			input.changedBy,
			input.changeType,
			input.beforeJson,
			input.afterJson,
			new Date().toISOString(),
		)
		.run();
}

export async function insertAlertRead(
	db: D1Database,
	alertId: string,
	userDiscordId: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO alert_reads (
				alert_id,
				user_discord_id,
				read_at
			) VALUES (?, ?, ?)`,
		)
		.bind(alertId, userDiscordId, new Date().toISOString())
		.run();
}

export async function updateAlertReadStatusMessage(
	env: Env,
	alertId: string,
): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN) {
		console.warn("Skipping alert read status update because DISCORD_BOT_TOKEN is not configured");
		return;
	}

	const alert = await getAlertMessage(env.DB, alertId);
	if (!alert?.discord_channel_id || !alert.discord_message_id) {
		return;
	}

	const readUserIds = await listAlertReadUserIds(env.DB, alertId);
	const updatedMessage = buildAlertMessageWithReadStatus(alert.message ?? "", readUserIds);
	await patchDiscordChannelMessage({
		botToken: env.DISCORD_BOT_TOKEN,
		channelId: alert.discord_channel_id,
		messageId: alert.discord_message_id,
		content: updatedMessage,
		components: createAlertAcknowledgeComponents(alertId),
	});
	await updateAlertMessage(env.DB, alertId, updatedMessage);
}

async function getAlertMessage(
	db: D1Database,
	alertId: string,
): Promise<AlertMessageRow | null> {
	const row = await db
		.prepare(
			`SELECT
				id,
				message,
				discord_message_id,
				discord_channel_id
			FROM alerts
			WHERE id = ?`,
		)
		.bind(alertId)
		.first<AlertMessageRow>();

	return row ?? null;
}

async function listAlertReadUserIds(
	db: D1Database,
	alertId: string,
): Promise<string[]> {
	const result = await db
		.prepare(
			`SELECT
				user_discord_id,
				read_at
			FROM alert_reads
			WHERE alert_id = ?
			ORDER BY read_at ASC`,
		)
		.bind(alertId)
		.all<AlertReadRow>();

	return [...new Set((result.results ?? []).map((row) => row.user_discord_id).filter(Boolean))];
}

async function updateAlertMessage(
	db: D1Database,
	alertId: string,
	message: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE alerts
			SET message = ?
			WHERE id = ?`,
		)
		.bind(message, alertId)
		.run();
}

function getInteractionUserId(interaction: DiscordInteraction): string | null {
	return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function getStringOption(
	interaction: DiscordInteraction,
	optionName: string,
): string | null {
	const option = interaction.data?.options?.find(
		(item) => item.name === optionName && item.type === STRING_OPTION,
	);

	return typeof option?.value === "string" ? option.value.trim() : null;
}

export function ruleParseCrawlSchedule(
	input: string,
): CrawlScheduleCandidate | null {
	const normalized = input.replace(/\s+/g, "");
	const mentionsMapleStory = normalized.includes("메이플");
	const mentionsUpdate = ["패치", "업데이트", "패치내역"].some((token) =>
		normalized.includes(token),
	);
	const mentionsDetection = ["올라오면", "감지", "신규", "등록", "켜줘", "알려줘"].some(
		(token) => normalized.includes(token),
	);

	if (!mentionsMapleStory || !mentionsUpdate || !mentionsDetection) {
		return null;
	}

	return {
		intent: "create_crawl_schedule",
		source_id: MAPLESTORY_UPDATE_PRESET.source_id,
		title: `${MAPLESTORY_UPDATE_PRESET.label} 감지`,
		target_url: MAPLESTORY_UPDATE_PRESET.url,
		keywords: [...MAPLESTORY_UPDATE_PRESET.keywords],
		interval_minutes: MAPLESTORY_UPDATE_PRESET.defaultIntervalMinutes,
		timezone: SEOUL_TIMEZONE,
		input,
		created_at: new Date().toISOString(),
	};
}

function isTooShortIntervalReminderRequest(input: string): boolean {
	const intervalMinuteMatch = input.match(/(\d+)\s*분마다/);
	if (!intervalMinuteMatch) {
		return false;
	}

	const minutes = Number.parseInt(intervalMinuteMatch[1], 10);
	return Number.isInteger(minutes) && minutes > 0 && minutes < MIN_INTERVAL_REMINDER_MINUTES;
}

export function ruleParseReminder(
	input: string,
	now = new Date(),
): ReminderCandidate | null {
	const result = ruleParseReminderDetailed(input, now);
	return result.ok && !result.shouldFallbackToLlm ? result.value : null;
}

export function ruleParseReminderDetailed(
	input: string,
	now = new Date(),
): RuleReminderParseResult {
	const analysis = analyzeRuleParserInput(input);
	const sanitizedInput = stripNegatedDateCandidates(input);
	const matchedSpans = collectDateCandidateSpans(sanitizedInput);
	const consumedSpans = collectReminderConsumedSpans(sanitizedInput);
	const parsed = parseReminderCandidateStrict(sanitizedInput, now, input, consumedSpans);

	if (!parsed) {
		return {
			ok: false,
			confidence: "low",
			shouldFallbackToLlm: analysis.shouldFallbackToLlm,
			warnings: analysis.warnings,
			matchedSpans,
			consumedSpans,
		};
	}

	if (analysis.shouldFallbackToLlm) {
		return {
			ok: true,
			value: parsed,
			confidence: analysis.confidence,
			shouldFallbackToLlm: true,
			warnings: analysis.warnings,
			matchedSpans,
			consumedSpans,
		};
	}

	return {
		ok: true,
		value: parsed,
		confidence: "high",
		shouldFallbackToLlm: false,
		warnings: analysis.warnings,
		matchedSpans,
		consumedSpans,
	};
}

function parseReminderCandidateStrict(
	input: string,
	now: Date,
	originalInput = input,
	consumedSpans: MatchedSpan[] = collectReminderConsumedSpans(input),
): ReminderCandidate | null {
	const dailyMatch = input.match(new RegExp(`매일\\s*${TIME_PATTERN}`));
	if (dailyMatch) {
		const time = parseTimeMatch(dailyMatch);
		if (!time) {
			return null;
		}

		const runAt = nextDailyRunAt(time, now);
		return createReminderCandidate(originalInput, runAt, {
			type: "daily",
			time: formatTime(time),
		}, consumedSpans);
	}

	const weeklyMatch = input.match(
		new RegExp(
			`매주\\s*(${KOREAN_DAY_OF_WEEK_PATTERN})\\s*${TIME_PATTERN}`,
		),
	);
	if (weeklyMatch) {
		const [, koreanDayOfWeek] = weeklyMatch;
		const time = parseTimeMatch(weeklyMatch, 2);
		const dayOfWeek = DAY_OF_WEEK_BY_KOREAN[koreanDayOfWeek];
		if (!time || !dayOfWeek) {
			return null;
		}

		const runAt = nextWeeklyRunAt(dayOfWeek, time, now);
		return createReminderCandidate(originalInput, runAt, {
			type: "weekly",
			day_of_week: dayOfWeek,
			time: formatTime(time),
		}, consumedSpans);
	}

	const weeklyAbstractMatch = input.match(
		new RegExp(`매주\\s*(${KOREAN_DAY_OF_WEEK_PATTERN})`),
	);
	if (weeklyAbstractMatch) {
		const [, koreanDayOfWeek] = weeklyAbstractMatch;
		const time = parseAbstractTime(input);
		const dayOfWeek = DAY_OF_WEEK_BY_KOREAN[koreanDayOfWeek];
		if (!time || !dayOfWeek) {
			return null;
		}

		const runAt = nextWeeklyRunAt(dayOfWeek, time, now);
		return createReminderCandidate(originalInput, runAt, {
			type: "weekly",
			day_of_week: dayOfWeek,
			time: formatTime(time),
		}, consumedSpans);
	}

	const dailyAbstractMatch = input.match(/매일/);
	if (dailyAbstractMatch) {
		const time = parseAbstractTime(input);
		if (!time) {
			return null;
		}

		const runAt = nextDailyRunAt(time, now);
		return createReminderCandidate(originalInput, runAt, {
			type: "daily",
			time: formatTime(time),
		}, consumedSpans);
	}

	const intervalMinuteMatch = input.match(/(\d+)\s*분마다/);
	if (intervalMinuteMatch) {
		const minutes = Number.parseInt(intervalMinuteMatch[1], 10);
		if (!Number.isInteger(minutes) || minutes <= 0) {
			return null;
		}

		if (minutes < MIN_INTERVAL_REMINDER_MINUTES) {
			return null;
		}

		return createReminderCandidate(originalInput, addMinutesToSeoulIso(now, minutes), {
			type: "interval",
			minutes,
		}, consumedSpans);
	}

	const intervalHourMatch = input.match(/(\d+)\s*시간마다/);
	if (intervalHourMatch) {
		const hours = Number.parseInt(intervalHourMatch[1], 10);
		if (!Number.isInteger(hours) || hours <= 0) {
			return null;
		}

		const minutes = hours * 60;
		return createReminderCandidate(originalInput, addMinutesToSeoulIso(now, minutes), {
			type: "interval",
			minutes,
		}, consumedSpans);
	}

	const oneTimeRunAt = parseOneTimeRunAt(input, now);
	return oneTimeRunAt ? createReminderCandidate(originalInput, oneTimeRunAt, null, consumedSpans) : null;
}

function createReminderCandidate(
	input: string,
	runAt: string,
	repeat: RepeatRule | null,
	consumedSpans: MatchedSpan[] = [],
): ReminderCandidate {
	return {
		intent: "create_reminder",
		title: extractReminderTitle(input, consumedSpans),
		run_at: runAt,
		repeat,
		timezone: SEOUL_TIMEZONE,
		input,
		created_at: new Date().toISOString(),
	};
}

function analyzeRuleParserInput(input: string): {
	confidence: RuleParseConfidence;
	shouldFallbackToLlm: boolean;
	warnings: string[];
} {
	const warnings: string[] = [];
	const correctionCount = countCorrectionOrNegationWords(input);
	const uncertaintyCount = countUncertaintyWords(input);
	const conflictCount = countActiveDateCandidates(input);
	if (correctionCount > 0) {
		warnings.push("correction_or_negation");
	}
	if (uncertaintyCount > 0) {
		warnings.push("uncertainty");
	}
	if (conflictCount > 1) {
		warnings.push("multiple_date_candidates");
	}

	const shouldFallbackToLlm =
		conflictCount > 1 ||
		uncertaintyCount >= 2 ||
		(correctionCount > 0 && uncertaintyCount > 0);

	if (shouldFallbackToLlm) {
		return {
			confidence: "low",
			shouldFallbackToLlm: true,
			warnings,
		};
	}

	if (correctionCount > 0 || uncertaintyCount > 0) {
		return {
			confidence: "medium",
			shouldFallbackToLlm: false,
			warnings,
		};
	}

	return {
		confidence: "high",
		shouldFallbackToLlm: false,
		warnings,
	};
}

export function hasCorrectionOrNegation(input: string): boolean {
	return countCorrectionOrNegationWords(input) > 0;
}

function countCorrectionOrNegationWords(input: string): number {
	const normalized = input.replace(/\s+/g, "");
	const compactPatterns = [
		"말고",
		"아니고",
		"대신",
		"근데",
		"다시",
		"바꿔서",
	];
	const fillerMatches = input.match(/(?:^|\s)아(?:\s|$)|(?:^|\s)음(?:\s|$)/g) ?? [];
	return compactPatterns.filter((pattern) => normalized.includes(pattern)).length + fillerMatches.length;
}

export function countUncertaintyWords(input: string): number {
	const normalized = input.replace(/\s+/g, "");
	const patterns = ["어디쯤", "그때쯤", "쯤", "정도", "대충", "아마", "나중에"];
	let count = patterns.filter((pattern) => normalized.includes(pattern)).length;
	count += (input.match(/(?:^|\s)한\s*\d/g) ?? []).length;
	return count;
}

export function hasMultipleDateCandidates(input: string): boolean {
	return countActiveDateCandidates(input) > 1;
}

function countActiveDateCandidates(input: string): number {
	return collectDateCandidateSpans(stripNegatedDateCandidates(input)).length;
}

function collectDateCandidateSpans(input: string): string[] {
	const spans: string[] = [];
	let remaining = input;
	for (const pattern of [
		/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/g,
		/\d{4}[/-]\d{1,2}[/-]\d{1,2}/g,
		/\d{1,2}\s*월\s*\d{1,2}\s*일/g,
		/\d{1,2}\/\d{1,2}/g,
		new RegExp(`(?:이번\\s*주|다음\\s*주|돌아오는|다가오는|이번)\\s*(?:${KOREAN_DAY_OF_WEEK_PATTERN})`, "g"),
		/오늘|내일|모레/g,
		new RegExp(KOREAN_DAY_OF_WEEK_PATTERN, "g"),
	]) {
		remaining = remaining.replace(pattern, (matched) => {
			spans.push(matched);
			return " ";
		});
	}
	return [...new Set(spans)];
}

function collectReminderConsumedSpans(input: string): MatchedSpan[] {
	const spans: MatchedSpan[] = [];
	const patterns: Array<{ pattern: RegExp; type: MatchedSpan["type"] }> = [
		{ pattern: /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/gu, type: "date" },
		{ pattern: /\d{4}[/-]\d{1,2}[/-]\d{1,2}/gu, type: "date" },
		{ pattern: /\d{1,2}\s*월\s*\d{1,2}\s*일/gu, type: "date" },
		{ pattern: /\d{1,2}\/\d{1,2}/gu, type: "date" },
		{
			pattern: new RegExp(
				`(?:돌아오는|다가오는)\\s*(?:${KOREAN_DAY_OF_WEEK_PATTERN})`,
				"gu",
			),
			type: "date",
		},
		{
			pattern: new RegExp(
				`(?:이번\\s*주|다음\\s*주|이번)\\s*(?:${KOREAN_DAY_OF_WEEK_PATTERN})?`,
				"gu",
			),
			type: "date",
		},
		{ pattern: /오늘|내일|모레/gu, type: "date" },
		{
			pattern: new RegExp(`매주\\s*(?:${KOREAN_DAY_OF_WEEK_PATTERN})`, "gu"),
			type: "repeat",
		},
		{ pattern: /매일/gu, type: "repeat" },
		{ pattern: /\d+\s*분마다/gu, type: "repeat" },
		{ pattern: /\d+\s*시간마다/gu, type: "repeat" },
		{
			pattern: new RegExp(`${TIME_PATTERN}\\s*(?:에|쯤)?`, "gu"),
			type: "time",
		},
		{ pattern: /(?:아침|저녁|밤|새벽)\s*(?:쯤|에)?/gu, type: "time" },
	];

	for (const { pattern, type } of patterns) {
		for (const match of input.matchAll(pattern)) {
			const text = match[0]?.trim();
			if (text) {
				spans.push({ text, type });
			}
		}
	}

	return spans.sort((left, right) => right.text.length - left.text.length);
}

function stripNegatedDateCandidates(input: string): string {
	return input
		.replace(
			new RegExp(
				`(?:오늘|내일|모레|이번\\s*주|다음\\s*주|${KOREAN_DAY_OF_WEEK_PATTERN})\\s*(?:말고|아니고|대신)\\s*`,
				"g",
			),
			"",
		)
		.trim();
}

function parseOneTimeRunAt(input: string, now: Date): string | null {
	const absoluteDate = parseAbsoluteDate(input);
	if (absoluteDate) {
		const time = parseOneTimeTime(input);
		return time ? combineAbsoluteDateAndTime(absoluteDate, time, now) : null;
	}

	if (hasAbsoluteDateLikeText(input)) {
		return null;
	}

	const time = parseOneTimeTime(input);
	if (!time) {
		return null;
	}

	const seoulDate = parseRelativeDate(input, now) ?? toSeoulDate(now);
	seoulDate.setUTCHours(time.hour, time.minute, 0, 0);
	return formatSeoulIso(seoulDate);
}

function parseOneTimeTime(input: string): TimeOfDay | null {
	const timeMatch = input.match(new RegExp(TIME_PATTERN));
	if (timeMatch) {
		return parseTimeMatch(timeMatch);
	}

	return parseAbstractTime(input);
}

export function parseAbsoluteDate(input: string): AbsoluteDateMatch | null {
	const patterns = [
		/(?<year>\d{4})\s*년\s*(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일/,
		/(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일/,
		/(?<year>\d{4})[/-](?<month>\d{1,2})[/-](?<day>\d{1,2})/,
		/(?<month>\d{1,2})\/(?<day>\d{1,2})/,
	];

	for (const pattern of patterns) {
		const match = input.match(pattern);
		if (!match?.groups) {
			continue;
		}

		const year = match.groups.year ? Number.parseInt(match.groups.year, 10) : null;
		const month = Number.parseInt(match.groups.month, 10);
		const day = Number.parseInt(match.groups.day, 10);
		if (!isValidDateParts(year ?? 2000, month, day)) {
			return null;
		}

		return {
			year,
			month,
			day,
			matchedText: match[0],
		};
	}

	return null;
}

function hasAbsoluteDateLikeText(input: string): boolean {
	return [
		/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/,
		/\d{1,2}\s*월\s*\d{1,2}\s*일/,
		/\d{4}[/-]\d{1,2}[/-]\d{1,2}/,
		/\d{1,2}\/\d{1,2}/,
	].some((pattern) => pattern.test(input));
}

function combineAbsoluteDateAndTime(
	date: AbsoluteDateMatch,
	time: TimeOfDay,
	now: Date,
): string | null {
	const seoulNow = toSeoulDate(now);
	let year = date.year ?? seoulNow.getUTCFullYear();
	if (!isValidDateParts(year, date.month, date.day)) {
		return null;
	}

	const seoulDate = createSeoulWallDate(year, date.month, date.day, time);
	if (date.year === null && seoulDate.getTime() <= seoulNow.getTime()) {
		year += 1;
		if (!isValidDateParts(year, date.month, date.day)) {
			return null;
		}
		return formatSeoulIso(createSeoulWallDate(year, date.month, date.day, time));
	}

	return formatSeoulIso(seoulDate);
}

function createSeoulWallDate(
	year: number,
	month: number,
	day: number,
	time: TimeOfDay,
): Date {
	const date = new Date(Date.UTC(year, month - 1, day, time.hour, time.minute, 0, 0));
	return date;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
		return false;
	}

	if (month < 1 || month > 12 || day < 1) {
		return false;
	}

	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

function parseAbstractTime(input: string): TimeOfDay | null {
	if (/아침\s*(?:쯤|에)?/.test(input)) {
		return { hour: 8, minute: 0 };
	}

	if (/저녁\s*(?:쯤|에)?/.test(input)) {
		return { hour: 19, minute: 0 };
	}

	if (/밤\s*(?:쯤|에)?/.test(input)) {
		return { hour: 22, minute: 0 };
	}

	if (/새벽\s*(?:쯤|에)?/.test(input)) {
		return { hour: 5, minute: 0 };
	}

	return null;
}

export function parseRelativeDate(input: string, now = new Date()): Date | null {
	const seoulDate = toSeoulDate(now);

	if (/\b오늘\b/.test(input) || input.includes("오늘")) {
		return seoulDate;
	}

	if (input.includes("내일")) {
		seoulDate.setUTCDate(seoulDate.getUTCDate() + 1);
		return seoulDate;
	}

	if (input.includes("모레")) {
		seoulDate.setUTCDate(seoulDate.getUTCDate() + 2);
		return seoulDate;
	}

	const upcomingWeekdayMatch = input.match(
		new RegExp(`(돌아오는|다가오는)\\s*(${KOREAN_DAY_OF_WEEK_PATTERN})`),
	);
	if (upcomingWeekdayMatch) {
		const [, , koreanDayOfWeek] = upcomingWeekdayMatch;
		const dayOfWeek = DAY_OF_WEEK_BY_KOREAN[koreanDayOfWeek];
		if (!dayOfWeek) {
			return null;
		}

		const currentIsoDay = toIsoDayOfWeek(seoulDate);
		const targetIsoDay = ISO_DAY_OF_WEEK_BY_DAY[dayOfWeek];
		const daysToAdd = (targetIsoDay - currentIsoDay + 7) % 7;
		seoulDate.setUTCDate(seoulDate.getUTCDate() + daysToAdd);
		return seoulDate;
	}

	const thisWeekdayMatch = input.match(
		new RegExp(`이번\\s*(${KOREAN_DAY_OF_WEEK_PATTERN})`),
	);
	if (thisWeekdayMatch) {
		const [, koreanDayOfWeek] = thisWeekdayMatch;
		const dayOfWeek = DAY_OF_WEEK_BY_KOREAN[koreanDayOfWeek];
		if (!dayOfWeek) {
			return null;
		}

		const currentIsoDay = toIsoDayOfWeek(seoulDate);
		const targetIsoDay = ISO_DAY_OF_WEEK_BY_DAY[dayOfWeek];
		seoulDate.setUTCDate(seoulDate.getUTCDate() + targetIsoDay - currentIsoDay);
		return seoulDate;
	}

	const weekMatch = input.match(
		new RegExp(`(이번\\s*주|다음\\s*주)\\s*(${KOREAN_DAY_OF_WEEK_PATTERN})`),
	);
	if (!weekMatch) {
		return null;
	}

	const [, weekText, koreanDayOfWeek] = weekMatch;
	const dayOfWeek = DAY_OF_WEEK_BY_KOREAN[koreanDayOfWeek];
	if (!dayOfWeek) {
		return null;
	}

	const currentIsoDay = toIsoDayOfWeek(seoulDate);
	const targetIsoDay = ISO_DAY_OF_WEEK_BY_DAY[dayOfWeek];
	const weekOffset = weekText.replace(/\s+/g, "") === "다음주" ? 7 : 0;
	const daysToAdd = targetIsoDay - currentIsoDay + weekOffset;
	seoulDate.setUTCDate(seoulDate.getUTCDate() + daysToAdd);
	return seoulDate;
}

function toIsoDayOfWeek(seoulDate: Date): number {
	const day = seoulDate.getUTCDay();
	return day === 0 ? 7 : day;
}

function parseTimeMatch(match: RegExpMatchArray, startIndex = 1): TimeOfDay | null {
	const meridiem = match[startIndex];
	const hourText = match[startIndex + 1];
	const minuteText = match[startIndex + 2] ?? match[startIndex + 3] ?? "0";
	return parseTime({ meridiem, hourText, minuteText });
}

function parseTime(input: {
	meridiem?: string;
	hourText: string;
	minuteText?: string;
}): TimeOfDay | null {
	const minute = Number.parseInt(input.minuteText ?? "0", 10);
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
		return null;
	}

	const hour = input.meridiem
		? parseKoreanHour(input.meridiem, input.hourText)
		: parseTwentyFourHour(input.hourText);
	if (hour === null) {
		return null;
	}

	return { hour, minute };
}

function parseKoreanHour(meridiem: string, hourText: string): number | null {
	const parsedHour = Number.parseInt(hourText, 10);
	if (!Number.isInteger(parsedHour) || parsedHour < 1 || parsedHour > 12) {
		return null;
	}

	if (meridiem === "오전" || meridiem === "새벽") {
		return parsedHour % 12;
	}

	if (meridiem === "아침") {
		return parsedHour === 12 ? 12 : parsedHour;
	}

	if (meridiem === "밤") {
		return parsedHour === 12 ? 0 : parsedHour + 12;
	}

	return parsedHour === 12 ? 12 : parsedHour + 12;
}

function parseTwentyFourHour(hourText: string): number | null {
	const parsedHour = Number.parseInt(hourText, 10);
	if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
		return null;
	}

	return parsedHour;
}

function nextDailyRunAt(time: TimeOfDay, now: Date): string {
	const seoulDate = toSeoulDate(now);
	seoulDate.setUTCHours(time.hour, time.minute, 0, 0);
	if (seoulDate.getTime() <= toSeoulDate(now).getTime()) {
		seoulDate.setUTCDate(seoulDate.getUTCDate() + 1);
	}

	return formatSeoulIso(seoulDate);
}

function nextWeeklyRunAt(dayOfWeek: DayOfWeek, time: TimeOfDay, now: Date): string {
	const targetDay = dayOfWeekToNumber(dayOfWeek);
	const seoulNow = toSeoulDate(now);
	const seoulDate = new Date(seoulNow.getTime());
	seoulDate.setUTCHours(time.hour, time.minute, 0, 0);

	const currentDay = seoulDate.getUTCDay();
	let daysToAdd = (targetDay - currentDay + 7) % 7;
	if (daysToAdd === 0 && seoulDate.getTime() <= seoulNow.getTime()) {
		daysToAdd = 7;
	}
	seoulDate.setUTCDate(seoulDate.getUTCDate() + daysToAdd);

	return formatSeoulIso(seoulDate);
}

function addMinutesToSeoulIso(now: Date, minutes: number): string {
	return formatSeoulIso(
		toSeoulDate(new Date(now.getTime() + minutes * 60 * 1000)),
	);
}

function dayOfWeekToNumber(dayOfWeek: DayOfWeek): number {
	const order: DayOfWeek[] = [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	];
	return order.indexOf(dayOfWeek);
}

function parseTimeString(time: string): TimeOfDay | null {
	const match = time.match(/^(\d{2}):(\d{2})$/);
	if (!match) {
		return null;
	}

	return parseTime({ hourText: match[1], minuteText: match[2] });
}

function formatTime(time: TimeOfDay): string {
	return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

function toSeoulDate(date: Date): Date {
	return new Date(date.getTime() + SEOUL_OFFSET_HOURS * 60 * 60 * 1000);
}

function formatSeoulIso(seoulDate: Date): string {
	const year = seoulDate.getUTCFullYear();
	const month = seoulDate.getUTCMonth() + 1;
	const day = seoulDate.getUTCDate();
	const hour = seoulDate.getUTCHours();
	const minute = seoulDate.getUTCMinutes();
	const second = seoulDate.getUTCSeconds();

	return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+09:00`;
}

function formatKoreanDateTime(seoulIso: string): string {
	const dateOnlyMatch = seoulIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnlyMatch) {
		const [, year, month, day] = dateOnlyMatch;
		return `${year}년 ${Number(month)}월 ${Number(day)}일`;
	}

	const match = seoulIso.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\+09:00|Z)?$/,
	);
	if (!match) {
		return seoulIso;
	}

	const [, year, month, day, hourText, minute] = match;
	const hour = Number.parseInt(hourText, 10);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
		return seoulIso;
	}

	const meridiem = hour < 12 ? "오전" : "오후";
	const displayHour = hour % 12 === 0 ? 12 : hour % 12;
	const dayOfWeek = formatKoreanDateDayOfWeek(year, month, day);
	return `${year}년 ${Number(month)}월 ${Number(day)}일 ${dayOfWeek} ${meridiem} ${displayHour}시 ${minute}분`;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function formatKoreanDateDayOfWeek(year: string, month: string, day: string): string {
	const labels = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	return labels[date.getUTCDay()];
}

function formatReminderCandidate(reminder: ReminderCandidate): string {
	return [
		"이 일정으로 등록할까요?",
		"",
		`제목: ${reminder.title}`,
		`시간: ${formatKoreanDateTime(reminder.run_at)}`,
		`반복: ${formatRepeatRule(reminder.repeat)}`,
		"알림 위치: 현재 채널",
		"",
		"아직 DB에는 저장하지 않았습니다.",
	].join("\n");
}

function formatCrawlScheduleCandidate(candidate: CrawlScheduleCandidate): string {
	return [
		"이 감지 알림을 등록할까요?",
		"",
		`대상: ${MAPLESTORY_UPDATE_PRESET.label}`,
		"감지 방식: 신규 게시글",
		`검사 주기: ${candidate.interval_minutes}분`,
		"알림 위치: 현재 채널",
		"",
		"아직 DB에는 저장하지 않았습니다.",
	].join("\n");
}

export function formatScheduleList(schedules: ScheduleListRow[]): string {
	if (schedules.length === 0) {
		return "현재 채널에 등록된 활성 알림이 없습니다.";
	}

	return [
		"등록된 알림 목록",
		"",
		...schedules.map((schedule, index) => {
			const item = formatScheduleListItem(schedule, index);
			return schedule.pre_offset_minutes
				? `${item}\n사전 알림: ${getPreReminderLabel()}`
				: item;
		}),
		"",
		"삭제하려면 아래 버튼을 눌러주세요.",
	].join("\n\n");
}

function formatScheduleListItem(schedule: ScheduleListRow, index: number): string {
	if (schedule.type === "crawl") {
		return [
			`${index + 1}. ${schedule.title}`,
			"유형: 사이트 감지",
			`대상: ${formatCrawlScheduleTarget(schedule)}`,
			`주기: ${schedule.interval_minutes ?? MAPLESTORY_UPDATE_PRESET.defaultIntervalMinutes}분`,
			`다음 검사: ${formatScheduleTime(schedule)}`,
			`등록자: ${formatScheduleCreator(schedule.created_by)}`,
			`상태: ${schedule.is_active === 1 ? "ON" : "OFF"}`,
		].join("\n");
	}

	return [
		`${index + 1}. ${schedule.title}`,
		`유형: ${formatScheduleType(schedule.type)}`,
		`시간: ${formatScheduleTime(schedule)}`,
		`반복: ${formatRepeatRule(parseRepeatRule(schedule.repeat_rule ?? null))}`,
		`등록자: ${formatScheduleCreator(schedule.created_by)}`,
		`상태: ${schedule.is_active === 1 ? "ON" : "OFF"}`,
	].join("\n");
}

function formatScheduleTime(schedule: ScheduleRow): string {
	const time = schedule.next_run_at ?? schedule.run_at;
	return time ? formatKoreanDateTime(time) : "미정";
}

function formatScheduleCreator(createdBy: string | null | undefined): string {
	return formatDiscordUserMention(createdBy) ?? "알 수 없음";
}

function formatDiscordUserMention(userId: string | null | undefined): string | null {
	const trimmed = userId?.trim();
	return trimmed ? `<@${trimmed}>` : null;
}

function formatCrawlScheduleTarget(schedule: ScheduleListRow): string {
	if (schedule.target_url === MAPLESTORY_UPDATE_PRESET.url) {
		return MAPLESTORY_UPDATE_PRESET.label;
	}

	return schedule.target_url ?? schedule.title;
}

function formatScheduleType(type: string): string {
	if (type === "reminder") {
		return "일정 알림";
	}

	if (type === "crawl") {
		return "사이트 감지";
	}

	return type;
}

function createScheduleDeleteComponents(schedules: ScheduleListRow[]): unknown[] {
	const buttons = schedules.map((schedule, index) => ({
		type: 2,
		style: 4,
		label: `${index + 1} 삭제`,
		custom_id: `${DELETE_SCHEDULE_PREFIX}${schedule.id}`,
	}));

	const rows = [];
	for (let index = 0; index < buttons.length; index += 5) {
		rows.push({
			type: 1,
			components: buttons.slice(index, index + 5),
		});
	}

	return rows;
}

function createConfirmCancelComponents(pendingId: string): unknown[] {
	return [
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 1,
					label: "등록",
					custom_id: `${CONFIRM_PREFIX}${pendingId}`,
				},
				{
					type: 2,
					style: 2,
					label: "취소",
					custom_id: `${CANCEL_PREFIX}${pendingId}`,
				},
			],
		},
	];
}

function createAlertAcknowledgeComponents(alertId: string): unknown[] {
	return [
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 1,
					label: "확인했어요",
					custom_id: `${ACKNOWLEDGE_ALERT_PREFIX}${alertId}`,
				},
			],
		},
	];
}

function isPreReminderSchedule(schedule: Pick<ScheduleRow, "reminder_kind">): boolean {
	return schedule.reminder_kind === "pre";
}

function getPreReminderLabel(): string {
	return `${PRE_REMINDER_OFFSET_MINUTES}분 전`;
}

function isPreReminderEligible(repeatRuleJson: string | null): boolean {
	const repeat = parseRepeatRule(repeatRuleJson);
	return repeat?.type !== "interval";
}

function computePreReminderRunAt(mainRunAt: string): string {
	return addMinutesToSeoulIso(new Date(mainRunAt), -PRE_REMINDER_OFFSET_MINUTES);
}

function computeMainRunAtFromPreReminder(schedule: ScheduleRow): string | null {
	const offset = schedule.offset_minutes ?? -PRE_REMINDER_OFFSET_MINUTES;
	const time = schedule.next_run_at ?? schedule.run_at;
	return time ? addMinutesToSeoulIso(new Date(time), Math.abs(offset)) : null;
}

function computeNextPreReminderRunAt(
	parentSchedule: Pick<ScheduleRow, "run_at" | "repeat_rule">,
	nowIso: string,
): string | null {
	if (!isPreReminderEligible(parentSchedule.repeat_rule ?? null)) {
		return null;
	}

	const repeat = parseRepeatRule(parentSchedule.repeat_rule ?? null);
	if (!repeat) {
		if (!parentSchedule.run_at) {
			return null;
		}

		const preRunAt = computePreReminderRunAt(parentSchedule.run_at);
		return new Date(preRunAt).getTime() > new Date(nowIso).getTime() ? preRunAt : null;
	}

	let searchIso = nowIso;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const nextMainRunAt = getNextRunAt(JSON.stringify(repeat), searchIso);
		if (!nextMainRunAt) {
			return null;
		}
		const preRunAt = computePreReminderRunAt(nextMainRunAt);
		if (new Date(preRunAt).getTime() > new Date(nowIso).getTime()) {
			return preRunAt;
		}
		searchIso = new Date(new Date(nextMainRunAt).getTime() + 1000).toISOString();
	}

	return null;
}

function buildPreReminderRepeatRule(parentRepeatRuleJson: string | null): string | null {
	const repeat = parseRepeatRule(parentRepeatRuleJson);
	if (!repeat || repeat.type === "interval") {
		return null;
	}

	const baseDate =
		repeat.type === "weekly"
			? new Date(`2026-04-${pad2(19 + ISO_DAY_OF_WEEK_BY_DAY[repeat.day_of_week])}T${repeat.time}:00+09:00`)
			: new Date(`2026-04-20T${repeat.time}:00+09:00`);
	const preDate = toSeoulDate(
		new Date(baseDate.getTime() - PRE_REMINDER_OFFSET_MINUTES * 60 * 1000),
	);
	const time = formatTime({
		hour: preDate.getUTCHours(),
		minute: preDate.getUTCMinutes(),
	});

	if (repeat.type === "daily") {
		return JSON.stringify({ type: "daily", time });
	}

	const days: DayOfWeek[] = [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	];
	return JSON.stringify({
		type: "weekly",
		day_of_week: days[preDate.getUTCDay()],
		time,
	});
}

function getNextRunAt(repeatRuleJson: string | null | undefined, nowIso: string): string | null {
	const repeatRule = parseRepeatRule(repeatRuleJson ?? null);
	if (!repeatRule) {
		return null;
	}

	const now = new Date(nowIso);
	if (repeatRule.type === "interval") {
		return addMinutesToSeoulIso(now, repeatRule.minutes);
	}

	if (repeatRule.type === "daily") {
		const time = parseTimeString(repeatRule.time);
		return time ? nextDailyRunAt(time, now) : null;
	}

	const time = parseTimeString(repeatRule.time);
	return time ? nextWeeklyRunAt(repeatRule.day_of_week, time, now) : null;
}

function parseRepeatRule(repeatRuleJson: string | null): RepeatRule | null {
	if (!repeatRuleJson) {
		return null;
	}

	try {
		const parsed = JSON.parse(repeatRuleJson) as Partial<RepeatRule>;
		if (parsed.type === "daily" && typeof parsed.time === "string") {
			return { type: "daily", time: parsed.time };
		}

		if (
			parsed.type === "weekly" &&
			typeof parsed.day_of_week === "string" &&
			typeof parsed.time === "string"
		) {
			return {
				type: "weekly",
				day_of_week: parsed.day_of_week as DayOfWeek,
				time: parsed.time,
			};
		}

		if (parsed.type === "interval" && typeof parsed.minutes === "number") {
			return { type: "interval", minutes: parsed.minutes };
		}
	} catch {
		return null;
	}

	return null;
}

function formatRepeatRule(repeat: RepeatRule | null): string {
	if (!repeat) {
		return "1회성 일정";
	}

	if (repeat.type === "daily") {
		return `매일 ${formatKoreanTimeOfDay(repeat.time)}`;
	}

	if (repeat.type === "weekly") {
		return `매주 ${formatDayOfWeek(repeat.day_of_week)} ${formatKoreanTimeOfDay(repeat.time)}`;
	}

	if (repeat.minutes % 60 === 0) {
		return `${repeat.minutes / 60}시간마다`;
	}

	return `${repeat.minutes}분마다`;
}

function formatKoreanTimeOfDay(time: string): string {
	const parsed = parseTimeString(time);
	if (!parsed) {
		return time;
	}

	const meridiem = parsed.hour < 12 ? "오전" : "오후";
	const displayHour = parsed.hour % 12 === 0 ? 12 : parsed.hour % 12;
	return `${meridiem} ${displayHour}시 ${pad2(parsed.minute)}분`;
}

function formatDayOfWeek(dayOfWeek: DayOfWeek): string {
	const labels: Record<DayOfWeek, string> = {
		sunday: "일요일",
		monday: "월요일",
		tuesday: "화요일",
		wednesday: "수요일",
		thursday: "목요일",
		friday: "금요일",
		saturday: "토요일",
	};
	return labels[dayOfWeek];
}

type InteractionResponseOptions = {
	allowedMentions?: unknown;
	components?: unknown[];
};

export function jsonPublicInteractionResponse(
	content: string,
	options: InteractionResponseOptions = {},
): Response {
	return jsonInteractionResponse(content, options, false);
}

export function jsonEphemeralInteractionResponse(
	content: string,
	options: InteractionResponseOptions = {},
): Response {
	return jsonInteractionResponse(content, options, true);
}

function jsonInteractionResponse(
	content: string,
	options: InteractionResponseOptions,
	ephemeral: boolean,
): Response {
	return json({
		type: CHANNEL_MESSAGE_WITH_SOURCE,
		data: {
			content,
			...(ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
			...(options.allowedMentions ? { allowed_mentions: options.allowedMentions } : {}),
			...(options.components ? { components: options.components } : {}),
		},
	});
}

function suppressAllMentions(): { parse: []; users: [] } {
	return { parse: [], users: [] };
}

function suppressAllMentionsIncludingRoles(): { parse: []; users: []; roles: [] } {
	return { parse: [], users: [], roles: [] };
}

function json(payload: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(payload), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
}

async function verifyDiscordRequest(input: {
	body: string;
	publicKey: string;
	signature: string;
	timestamp: string;
}): Promise<boolean> {
	try {
		const algorithm = "Ed25519";
		const key = await crypto.subtle.importKey(
			"raw",
			hexToUint8Array(input.publicKey),
			algorithm,
			false,
			["verify"],
		);

		return await crypto.subtle.verify(
			algorithm,
			key,
			hexToUint8Array(input.signature),
			new TextEncoder().encode(input.timestamp + input.body),
		);
	} catch {
		return false;
	}
}

function hexToUint8Array(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new Error("Invalid hex string");
	}

	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
