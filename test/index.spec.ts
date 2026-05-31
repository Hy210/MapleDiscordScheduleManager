import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
	buildEventKey,
	fetchMaplestoryUpdatePosts,
} from "../src/crawler/maplestory";
import worker, {
	buildAlertMessageWithReadStatus,
	buildReminderUpdateFromInput,
	buildScheduleOverrideFromInput,
	buildReadStatusSection,
	confirmDeleteSchedule,
	confirmScheduleOverride,
	confirmUpdateReminderSchedule,
	createPendingCrawlScheduleAction,
	createPendingReminderAction,
	createPendingScheduleOverrideAction,
	createPendingUpdateReminderAction,
	formatHelpMessage,
	formatScheduleList,
	insertCrawlScheduleFromPending,
	insertReminderSchedule,
	insertAlertRead,
	isHelpIntent,
	isPendingActionUsable,
	isScheduleListRequest,
	jsonEphemeralInteractionResponse,
	jsonPublicInteractionResponse,
	listActiveSchedulesForChannel,
	markPendingActionConsumed,
	parsePendingCrawlSchedulePayload,
	parsePendingReminderPayload,
	parsePendingScheduleOverridePayload,
	parsePendingUpdateReminderPayload,
	parseRelativeDate,
	processDueSchedules,
	runDailyCleanup,
	ruleParseReminderDetailed,
	ruleParseCrawlSchedule,
	ruleParseReminder,
	stripReadStatusSection,
	updateAlertReadStatusMessage,
} from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type TestScheduleSnapshot = Parameters<typeof buildReminderUpdateFromInput>[0];
type TestOverrideRow = NonNullable<Parameters<typeof buildScheduleOverrideFromInput>[2]>;

function makeReminderSnapshot(
	overrides: Partial<TestScheduleSnapshot> = {},
): TestScheduleSnapshot {
	return {
		id: "schedule_1",
		type: "reminder",
		title: "Boss",
		target_url: null,
		keywords_json: null,
		run_at: "2026-04-26T09:00:00+09:00",
		repeat_rule: null,
		interval_minutes: null,
		timezone: "Asia/Seoul",
		notify_channel_id: "channel_123",
		is_active: 1,
		next_run_at: "2026-04-26T09:00:00+09:00",
		last_run_at: null,
		last_success_at: null,
		last_error: null,
		created_by: "user_111",
		updated_by: "user_111",
		created_at: "2026-04-25T00:00:00.000Z",
		updated_at: "2026-04-25T00:00:00.000Z",
		parent_schedule_id: null,
		reminder_kind: "main",
		offset_minutes: null,
		...overrides,
	};
}

function makeOverrideRow(overrides: Partial<TestOverrideRow> = {}): TestOverrideRow {
	return {
		id: "override_1",
		schedule_id: "schedule_1",
		title: null,
		run_at: "2026-04-26T22:00:00+09:00",
		status: "pending",
		created_by: "user_456",
		consumed_at: null,
		created_at: "2026-04-25T00:00:00.000Z",
		updated_at: "2026-04-25T00:00:00.000Z",
		...overrides,
	};
}

describe("Discord interaction endpoint", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("builds public interaction responses without the ephemeral flag", async () => {
		const response = jsonPublicInteractionResponse("공개 응답", {
			allowedMentions: { parse: [], users: [] },
		});
		const body = (await response.json()) as {
			type: number;
			data: { content: string; flags?: number; allowed_mentions?: unknown };
		};

		expect(body.type).toBe(4);
		expect(body.data.content).toBe("공개 응답");
		expect(body.data.flags).toBeUndefined();
		expect(body.data.allowed_mentions).toEqual({ parse: [], users: [] });
	});

	it("builds ephemeral interaction responses with the ephemeral flag", async () => {
		const response = jsonEphemeralInteractionResponse("비공개 응답");
		const body = (await response.json()) as {
			type: number;
			data: { content: string; flags?: number };
		};

		expect(body.type).toBe(4);
		expect(body.data.content).toBe("비공개 응답");
		expect(body.data.flags).toBe(64);
	});

	it("builds alert read status sections without duplicate users", () => {
		expect(buildReadStatusSection([])).toBe(
			"[확인 현황]\n아직 확인한 사람이 없습니다.",
		);
		expect(buildReadStatusSection(["user_1", "user_2", "user_1"])).toBe(
			"[확인 현황]\n✅ <@user_1>\n✅ <@user_2>",
		);
	});

	it("rebuilds alert messages with a single read status section", () => {
		const original = [
			"[일정 알림]",
			"회의",
			"",
			"[확인 현황]",
			"아직 확인한 사람이 없습니다.",
		].join("\n");

		expect(stripReadStatusSection(original)).toBe("[일정 알림]\n회의");
		expect(buildAlertMessageWithReadStatus(original, ["user_1"])).toBe(
			"[일정 알림]\n회의\n\n[확인 현황]\n✅ <@user_1>",
		);
	});

	it("detects help and self-introduction requests without catching schedule-like text", () => {
		for (const input of [
			"너는 뭐야",
			"너 뭐야",
			"너는 누구야",
			"너는 무엇을 할 수 있어?",
			"너 뭐 할 수 있어",
			"뭐 할 수 있어",
			"사용법",
			"사용법 알려줘",
			"도움말",
			"명령어",
			"명령어 알려줘",
			"기능 알려줘",
			"할 수 있는 것",
			"가능한 것",
		]) {
			expect(isHelpIntent(input)).toBe(true);
		}

		expect(isHelpIntent("내일 뭐 할 수 있어?")).toBe(false);
		expect(isHelpIntent("내일 오후 9시에 보스 알려줘")).toBe(false);
		expect(isHelpIntent("메이플 업데이트 감지 켜줘")).toBe(false);
	});

	it("detects schedule list intent without catching schedule changes", () => {
		for (const input of [
			"목록",
			"목록 보여줘",
			"일정 목록",
			"일정목록",
			"알림 목록",
			"알림목록",
			"등록된 알림 보여줘",
			"등록된 일정 보여줘",
			"지금 등록된 거 보여줘",
			"내 알림 뭐 있어",
			"알림 뭐있어",
			"일정 뭐 있어",
			"현재 알림 보여줘",
			"현재 일정 보여줘",
			"예약된 알림 보여줘",
			"예약된 일정 목록",
			"등록된 목록",
			"스케줄 보여줘",
			"스케줄 목록",
			"리스트 보여줘",
		]) {
			expect(isScheduleListRequest(input), input).toBe(true);
		}

		for (const input of [
			"내일 오후 9시에 보스 알려줘",
			"5월 9일 저녁에 보스 알려줘",
			"알림 등록해줘",
			"일정 추가해줘",
			"보스 일정 잡아줘",
			"보스 보여줘",
			"메이플 업데이트 보여줘",
			"너는 뭐 할 수 있어",
			"도움말 보여줘",
			"삭제해줘",
			"취소해줘",
			"알림 삭제 목록",
		]) {
			expect(isScheduleListRequest(input), input).toBe(false);
		}
	});

	it("formats the help message with supported and unsupported capabilities", () => {
		const message = formatHelpMessage();

		expect(message).toContain("일정과 메이플 업데이트 알림");
		expect(message).toContain("/알림 내일 오후 9시 30분에 보스 알려줘");
		expect(message).toContain("[확인했어요]");
		expect(message).toContain("사용자가 직접 입력한 임의 URL 크롤링");
		expect(message).toContain("삭제하고 다시 등록");
	});

	it("parses simple Korean reminder text", () => {
		const reminder = ruleParseReminder(
			"내일 오전 9시에 회의 알려줘",
			new Date("2026-04-25T03:00:00.000Z"),
		);

		expect(reminder).toMatchObject({
			intent: "create_reminder",
			title: "회의",
			run_at: "2026-04-26T09:00:00+09:00",
			repeat: null,
			timezone: "Asia/Seoul",
			input: "내일 오전 9시에 회의 알려줘",
		});
	});

	it("inserts a confirmed reminder into schedules", async () => {
		const scheduleBinds: unknown[] = [];
		const changeBinds: unknown[] = [];
		const db = {
			prepare: (sql: string) => {
				if (sql.includes("INSERT INTO schedules")) {
					return {
						bind: (...values: unknown[]) => {
							scheduleBinds.push(...values);
							return {
								run: async () => ({ success: true }),
							};
						},
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(...values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await insertReminderSchedule(
			db,
			{
				intent: "create_reminder",
				title: "알림",
				run_at: "2026-04-26T09:00:00+09:00",
				repeat: null,
				timezone: "Asia/Seoul",
				input: "내일 오전 9시에 회의 알려줘",
				created_at: "2026-04-25T03:00:00.000Z",
			},
			{ channelId: "channel_123", userId: "user_456" },
		);

		expect(typeof scheduleBinds[0]).toBe("string");
		expect(scheduleBinds.slice(1, 14)).toEqual([
			"reminder",
			"알림",
			"2026-04-26T09:00:00+09:00",
			null,
			"Asia/Seoul",
			"channel_123",
			1,
			"2026-04-26T09:00:00+09:00",
			null,
			"main",
			null,
			"user_456",
			"user_456",
		]);
		expect(typeof scheduleBinds[14]).toBe("string");
		expect(typeof scheduleBinds[15]).toBe("string");
		expect(typeof changeBinds[0]).toBe("string");
		expect(changeBinds[1]).toBe(scheduleBinds[0]);
		expect(changeBinds[2]).toBe("user_456");
		expect(changeBinds[3]).toBe("create");
		expect(changeBinds[4]).toBeNull();
		expect(JSON.parse(String(changeBinds[5]))).toMatchObject({
			id: scheduleBinds[0],
			type: "reminder",
			title: "알림",
			is_active: 1,
			created_by: "user_456",
		});
	});

	it("automatically creates a thirty-minute pre-reminder for one-time reminders", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T11:00:00.000Z"));
		const scheduleBinds: unknown[][] = [];
		const changeBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => {
				if (sql.includes("INSERT INTO schedules")) {
					return {
						bind: (...values: unknown[]) => {
							scheduleBinds.push(values);
							return { run: async () => ({ success: true }) };
						},
					};
				}

				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		try {
			await insertReminderSchedule(
				db,
				{
					intent: "create_reminder",
					title: "보스",
					run_at: "2026-05-09T21:00:00+09:00",
					repeat: null,
					timezone: "Asia/Seoul",
					input: "5월 9일 오후 9시에 보스 알려줘",
					created_at: "2026-05-09T11:00:00.000Z",
				},
				{ channelId: "channel_123", userId: "user_456" },
			);
		} finally {
			vi.useRealTimers();
		}

		expect(scheduleBinds).toHaveLength(2);
		const [main, pre] = scheduleBinds;
		expect(main[8]).toBe("2026-05-09T21:00:00+09:00");
		expect(main[10]).toBe("main");
		expect(pre[3]).toBe("2026-05-09T20:30:00+09:00");
		expect(pre[8]).toBe("2026-05-09T20:30:00+09:00");
		expect(pre[9]).toBe(main[0]);
		expect(pre[10]).toBe("pre");
		expect(pre[11]).toBe(-30);
		expect(changeBinds.map((values) => values[3])).toEqual([
			"create",
			"create_pre_reminder",
		]);
	});

	it("skips pre-reminders when the pre-reminder time already passed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T11:45:00.000Z"));
		const scheduleBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					if (sql.includes("INSERT INTO schedules")) {
						scheduleBinds.push(values);
					}
					return { run: async () => ({ success: true }) };
				},
			}),
		} as unknown as D1Database;

		try {
			await insertReminderSchedule(
				db,
				{
					intent: "create_reminder",
					title: "보스",
					run_at: "2026-05-09T21:00:00+09:00",
					repeat: null,
					timezone: "Asia/Seoul",
					input: "오후 9시에 보스 알려줘",
					created_at: "2026-05-09T11:45:00.000Z",
				},
				{ channelId: "channel_123", userId: "user_456" },
			);
		} finally {
			vi.useRealTimers();
		}

		expect(scheduleBinds).toHaveLength(1);
		expect(scheduleBinds[0][10]).toBe("main");
	});

	it("computes pre-reminder times across daily and weekly day boundaries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-25T03:00:00.000Z"));
		const scheduleBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					if (sql.includes("INSERT INTO schedules")) {
						scheduleBinds.push(values);
					}
					return { run: async () => ({ success: true }) };
				},
			}),
		} as unknown as D1Database;

		try {
			await insertReminderSchedule(
				db,
				{
					intent: "create_reminder",
					title: "daily",
					run_at: "2026-04-26T00:10:00+09:00",
					repeat: { type: "daily", time: "00:10" },
					timezone: "Asia/Seoul",
					input: "매일 오전 0시 10분",
					created_at: "2026-04-25T03:00:00.000Z",
				},
				{ channelId: "channel_123", userId: "user_456" },
			);
			await insertReminderSchedule(
				db,
				{
					intent: "create_reminder",
					title: "weekly",
					run_at: "2026-04-27T00:10:00+09:00",
					repeat: { type: "weekly", day_of_week: "monday", time: "00:10" },
					timezone: "Asia/Seoul",
					input: "매주 월요일 오전 0시 10분",
					created_at: "2026-04-25T03:00:00.000Z",
				},
				{ channelId: "channel_123", userId: "user_456" },
			);
		} finally {
			vi.useRealTimers();
		}

		expect(scheduleBinds[1][8]).toBe("2026-04-25T23:40:00+09:00");
		expect(JSON.parse(String(scheduleBinds[1][4]))).toMatchObject({
			type: "daily",
			time: "23:40",
		});
		expect(scheduleBinds[3][8]).toBe("2026-04-26T23:40:00+09:00");
		expect(JSON.parse(String(scheduleBinds[3][4]))).toMatchObject({
			type: "weekly",
			day_of_week: "sunday",
			time: "23:40",
		});
	});

	it("does not create pre-reminders for interval reminders", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-25T03:00:00.000Z"));
		const scheduleBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					if (sql.includes("INSERT INTO schedules")) {
						scheduleBinds.push(values);
					}
					return { run: async () => ({ success: true }) };
				},
			}),
		} as unknown as D1Database;

		try {
			await insertReminderSchedule(
				db,
				{
					intent: "create_reminder",
					title: "interval",
					run_at: "2026-04-25T12:30:00+09:00",
					repeat: { type: "interval", minutes: 30 },
					timezone: "Asia/Seoul",
					input: "30분마다 알려줘",
					created_at: "2026-04-25T03:00:00.000Z",
				},
				{ channelId: "channel_123", userId: "user_456" },
			);
		} finally {
			vi.useRealTimers();
		}

		expect(scheduleBinds).toHaveLength(1);
	});

	it("stores reminder candidates in pending_actions", async () => {
		const binds: unknown[] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("INSERT INTO pending_actions");
					binds.push(...values);
					return {
						run: async () => ({ success: true }),
					};
				},
			}),
		} as unknown as D1Database;

		const pendingId = await createPendingReminderAction(
			db,
			{
				intent: "create_reminder",
				title: "알림",
				run_at: "2026-04-26T09:00:00+09:00",
				repeat: { type: "daily", time: "09:00" },
				timezone: "Asia/Seoul",
				input: "매일 오전 9시에 알려줘",
				created_at: "2026-04-25T03:00:00.000Z",
			},
			{
				channelId: "channel_123",
				guildId: "guild_123",
				userId: "user_456",
			},
		);

		expect(typeof pendingId).toBe("string");
		expect(binds[0]).toBe(pendingId);
		expect(binds[1]).toBe("create_reminder");
		expect(parsePendingReminderPayload(String(binds[2]))).toEqual({
			title: "알림",
			run_at: "2026-04-26T09:00:00+09:00",
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			timezone: "Asia/Seoul",
			notify_channel_id: "channel_123",
			created_by: "user_456",
		});
		expect(binds[3]).toBe("pending");
		expect(binds[4]).toBe("user_456");
		expect(binds[5]).toBe("channel_123");
		expect(binds[6]).toBe("guild_123");
		expect(new Date(String(binds[7])).getTime()).toBeGreaterThan(Date.now());
	});

	it("parses MapleStory crawl preset requests", () => {
		for (const input of [
			"메이플 패치 올라오면 알려줘",
			"메이플 업데이트 감지 켜줘",
			"메이플 신규 패치내역 알려줘",
			"메이플 패치 감지 등록해줘",
		]) {
			expect(ruleParseCrawlSchedule(input)).toMatchObject({
				intent: "create_crawl_schedule",
				source_id: "maplestory_update",
				title: "메이플스토리 업데이트 감지",
				target_url: "https://m.maplestory.nexon.com/news/update",
				keywords: ["업데이트", "클라이언트", "패치"],
				interval_minutes: 10,
				timezone: "Asia/Seoul",
				input,
			});
		}
	});

	it("stores crawl schedule candidates in pending_actions", async () => {
		const binds: unknown[] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("INSERT INTO pending_actions");
					binds.push(...values);
					return {
						run: async () => ({ success: true }),
					};
				},
			}),
		} as unknown as D1Database;

		const candidate = ruleParseCrawlSchedule("메이플 패치 올라오면 알려줘");
		expect(candidate).not.toBeNull();
		const pendingId = await createPendingCrawlScheduleAction(db, candidate!, {
			channelId: "channel_123",
			guildId: "guild_123",
			userId: "user_456",
		});

		expect(typeof pendingId).toBe("string");
		expect(binds[0]).toBe(pendingId);
		expect(binds[1]).toBe("create_crawl_schedule");
		expect(parsePendingCrawlSchedulePayload(String(binds[2]))).toEqual({
			source_id: "maplestory_update",
			title: "메이플스토리 업데이트 감지",
			target_url: "https://m.maplestory.nexon.com/news/update",
			keywords: ["업데이트", "클라이언트", "패치"],
			interval_minutes: 10,
			timezone: "Asia/Seoul",
			notify_channel_id: "channel_123",
			created_by: "user_456",
		});
		expect(binds[3]).toBe("pending");
	});

	it("stores reminder update candidates in pending_actions", async () => {
		const binds: unknown[] = [];
		const before = makeReminderSnapshot();
		const after = { ...before, title: "New Boss" };
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("INSERT INTO pending_actions");
					binds.push(...values);
					return { run: async () => ({ success: true }) };
				},
			}),
		} as unknown as D1Database;

		const pendingId = await createPendingUpdateReminderAction(db, {
			scheduleId: before.id,
			before,
			after,
			notifyChannelId: "channel_123",
			userId: "user_456",
			changeInput: "제목을 New Boss로 바꿔줘",
			preReminderAction: "upsert",
		});

		expect(binds[0]).toBe(pendingId);
		expect(binds[1]).toBe("update_reminder");
		expect(parsePendingUpdateReminderPayload(String(binds[2]))).toMatchObject({
			schedule_id: before.id,
			notify_channel_id: "channel_123",
			created_by: "user_456",
			change_input: "제목을 New Boss로 바꿔줘",
			pre_reminder_action: "upsert",
			after: { title: "New Boss" },
		});
	});

	it("parses reminder update payloads defensively", () => {
		const before = makeReminderSnapshot();
		const payload = {
			schedule_id: before.id,
			before,
			after: { ...before, title: "New Boss" },
			notify_channel_id: "channel_123",
			created_by: "user_456",
			change_input: "제목을 New Boss로 바꿔줘",
			pre_reminder_action: "upsert",
		};

		expect(parsePendingUpdateReminderPayload(JSON.stringify(payload))).toMatchObject({
			schedule_id: before.id,
		});
		expect(parsePendingUpdateReminderPayload("{")).toBeNull();
		expect(
			parsePendingUpdateReminderPayload(
				JSON.stringify({ ...payload, pre_reminder_action: "bad" }),
			),
		).toBeNull();
	});

	it("stores one-time override candidates in pending_actions", async () => {
		const binds: unknown[] = [];
		const beforeSchedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
		});
		const afterOverride = {
			id: "override_2",
			schedule_id: beforeSchedule.id,
			title: "Hard Boss",
			run_at: "2026-04-26T22:00:00+09:00",
			status: "pending" as const,
			created_by: "user_456",
			created_at: "2026-04-25T00:00:00.000Z",
			updated_at: "2026-04-25T00:00:00.000Z",
		};
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("INSERT INTO pending_actions");
					binds.push(...values);
					return { run: async () => ({ success: true }) };
				},
			}),
		} as unknown as D1Database;

		const pendingId = await createPendingScheduleOverrideAction(db, {
			scheduleId: beforeSchedule.id,
			beforeSchedule,
			existingOverride: null,
			afterOverride,
			notifyChannelId: "channel_123",
			userId: "user_456",
			changeInput: "오늘 오후 10시에 제목은 Hard Boss로",
			preReminderAction: "upsert",
		});

		expect(binds[0]).toBe(pendingId);
		expect(binds[1]).toBe("create_schedule_override");
		expect(parsePendingScheduleOverridePayload(String(binds[2]))).toMatchObject({
			schedule_id: beforeSchedule.id,
			existing_override: null,
			after_override: {
				title: "Hard Boss",
				run_at: "2026-04-26T22:00:00+09:00",
			},
		});
	});

	it("parses one-time override payloads defensively", () => {
		const beforeSchedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "monday", time: "09:00" }),
		});
		const payload = {
			schedule_id: beforeSchedule.id,
			before_schedule: beforeSchedule,
			existing_override: makeOverrideRow(),
			after_override: {
				id: "override_2",
				schedule_id: beforeSchedule.id,
				title: null,
				run_at: "2026-04-27T22:00:00+09:00",
				status: "pending",
				created_by: "user_456",
				created_at: "2026-04-25T00:00:00.000Z",
				updated_at: "2026-04-25T00:00:00.000Z",
			},
			created_by: "user_456",
			change_input: "오후 10시로",
			pre_reminder_action: "upsert",
		};

		expect(parsePendingScheduleOverridePayload(JSON.stringify(payload))).toMatchObject({
			schedule_id: beforeSchedule.id,
			existing_override: { id: "override_1" },
		});
		expect(parsePendingScheduleOverridePayload("{")).toBeNull();
		expect(
			parsePendingScheduleOverridePayload(
				JSON.stringify({ ...payload, after_override: { ...payload.after_override, status: "bad" } }),
			),
		).toBeNull();
	});

	it("inserts confirmed crawl schedules and records change history", async () => {
		const scheduleBinds: unknown[] = [];
		const changeBinds: unknown[] = [];
		const db = {
			prepare: (sql: string) => {
				if (sql.includes("INSERT INTO schedules")) {
					return {
						bind: (...values: unknown[]) => {
							scheduleBinds.push(...values);
							return { run: async () => ({ success: true }) };
						},
					};
				}

				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(...values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await insertCrawlScheduleFromPending(db, {
			source_id: "maplestory_update",
			title: "메이플스토리 업데이트 감지",
			target_url: "https://m.maplestory.nexon.com/news/update",
			keywords: ["업데이트", "클라이언트", "패치"],
			interval_minutes: 10,
			timezone: "Asia/Seoul",
			notify_channel_id: "channel_123",
			created_by: "user_456",
		});

		expect(typeof scheduleBinds[0]).toBe("string");
		expect(scheduleBinds.slice(1, 10)).toEqual([
			"crawl",
			"메이플스토리 업데이트 감지",
			"https://m.maplestory.nexon.com/news/update",
			JSON.stringify(["업데이트", "클라이언트", "패치"]),
			10,
			"Asia/Seoul",
			"channel_123",
			1,
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/),
		]);
		expect(changeBinds[2]).toBe("user_456");
		expect(changeBinds[3]).toBe("create");
		expect(JSON.parse(String(changeBinds[5]))).toMatchObject({
			type: "crawl",
			title: "메이플스토리 업데이트 감지",
			target_url: "https://m.maplestory.nexon.com/news/update",
			interval_minutes: 10,
			created_by: "user_456",
		});
	});

	it("validates and consumes pending actions", async () => {
		const validPending = {
			id: "pending_1",
			action_type: "create_reminder",
			payload_json: "{}",
			status: "pending",
			expires_at: "2026-04-25T03:15:00.000Z",
		};
		expect(isPendingActionUsable(validPending, new Date("2026-04-25T03:00:00.000Z"))).toBe(
			true,
		);
		expect(isPendingActionUsable(validPending, new Date("2026-04-25T03:16:00.000Z"))).toBe(
			false,
		);
		expect(
			isPendingActionUsable(
				{ ...validPending, status: "confirmed" },
				new Date("2026-04-25T03:00:00.000Z"),
			),
		).toBe(false);

		const binds: unknown[] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("UPDATE pending_actions");
					binds.push(...values);
					return {
						run: async () => ({ success: true }),
					};
				},
			}),
		} as unknown as D1Database;

		await markPendingActionConsumed(db, "pending_1", "cancelled");
		expect(binds[0]).toBe("cancelled");
		expect(typeof binds[1]).toBe("string");
		expect(typeof binds[2]).toBe("string");
		expect(binds[3]).toBe("pending_1");
	});

	it("stores alert acknowledgements idempotently", async () => {
		const binds: unknown[] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					expect(sql).toContain("INSERT OR IGNORE INTO alert_reads");
					binds.push(...values);
					return {
						run: async () => ({ success: true, meta: { changes: 1 } }),
					};
				},
			}),
		} as unknown as D1Database;

		await insertAlertRead(db, "alert_123", "user_456");

		expect(binds[0]).toBe("alert_123");
		expect(binds[1]).toBe("user_456");
		expect(typeof binds[2]).toBe("string");
	});

	it("updates the original alert message with read users without re-pinging mentions", async () => {
		const updateBinds: unknown[] = [];
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM alerts")) {
					return {
						bind: (alertId: string) => ({
							first: async () => {
								expect(alertId).toBe("alert_123");
								return {
									id: "alert_123",
									message:
										"<@&role_123>\n[일정 알림]\n회의\n\n[확인 현황]\n아직 확인한 사람이 없습니다.",
									discord_channel_id: "channel_123",
									discord_message_id: "message_123",
								};
							},
						}),
					};
				}

				if (sql.includes("FROM alert_reads")) {
					return {
						bind: (alertId: string) => ({
							all: async () => {
								expect(alertId).toBe("alert_123");
								return {
									results: [
										{ user_discord_id: "user_1", read_at: "2026-04-25T00:00:00.000Z" },
										{ user_discord_id: "user_2", read_at: "2026-04-25T00:01:00.000Z" },
										{ user_discord_id: "user_1", read_at: "2026-04-25T00:02:00.000Z" },
									],
								};
							},
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("UPDATE alerts");
						updateBinds.push(...values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await updateAlertReadStatusMessage(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
			},
			"alert_123",
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://discord.com/api/v10/channels/channel_123/messages/message_123",
			expect.objectContaining({
				method: "PATCH",
				headers: {
					authorization: "Bot bot_token",
					"content-type": "application/json",
				},
			}),
		);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			content: string;
			allowed_mentions: unknown;
			components: unknown[];
		};
		expect(body.content).toBe(
			"<@&role_123>\n[일정 알림]\n회의\n\n[확인 현황]\n✅ <@user_1>\n✅ <@user_2>",
		);
		expect(body.allowed_mentions).toEqual({ parse: [], users: [], roles: [] });
		expect(JSON.stringify(body.components)).toContain("acknowledge_alert:alert_123");
		expect(updateBinds).toEqual([body.content, "alert_123"]);
	});

	it("does not update alerts.message when the Discord message patch fails", async () => {
		const updateBinds: unknown[] = [];
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM alerts")) {
					return {
						bind: () => ({
							first: async () => ({
								id: "alert_123",
								message: "[일정 알림]\n회의",
								discord_channel_id: "channel_123",
								discord_message_id: "message_123",
							}),
						}),
					};
				}

				if (sql.includes("FROM alert_reads")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [{ user_discord_id: "user_1", read_at: "2026-04-25T00:00:00.000Z" }],
							}),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(...values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			updateAlertReadStatusMessage(
				{
					...env,
					DB: db,
					DISCORD_BOT_TOKEN: "bot_token",
				},
				"alert_123",
			),
		).rejects.toThrow("Discord message update failed with HTTP 500");

		expect(updateBinds).toEqual([]);
	});

	it("records schedule change history when deleting a schedule", async () => {
		const updateBinds: unknown[] = [];
		const changeBinds: unknown[] = [];
		const beforeSchedule = {
			id: "schedule_1",
			type: "reminder",
			title: "회의",
			target_url: null,
			keywords_json: null,
			run_at: "2026-04-26T09:00:00+09:00",
			repeat_rule: null,
			interval_minutes: null,
			timezone: "Asia/Seoul",
			notify_channel_id: "channel_123",
			is_active: 1,
			next_run_at: "2026-04-26T09:00:00+09:00",
			last_run_at: null,
			last_success_at: null,
			last_error: null,
			created_by: "user_111",
			updated_by: "user_111",
			created_at: "2026-04-25T00:00:00.000Z",
			updated_at: "2026-04-25T00:00:00.000Z",
		};

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules") && sql.includes("parent_schedule_id = ?")) {
					return {
						bind: () => ({
							all: async () => ({ results: [] }),
						}),
					};
				}

				if (sql.includes("FROM schedules")) {
					return {
						bind: (scheduleId: string) => ({
							first: async () => {
								expect(scheduleId).toBe("schedule_1");
								return beforeSchedule;
							},
						}),
					};
				}

				if (sql.includes("UPDATE schedules")) {
					return {
						bind: (...values: unknown[]) => {
							updateBinds.push(...values);
							return { run: async () => ({ success: true }) };
						},
					};
				}

				if (sql.includes("UPDATE schedule_overrides")) {
					return {
						bind: () => ({ run: async () => ({ success: true }) }),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(...values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await expect(confirmDeleteSchedule(db, "schedule_1", "user_222")).resolves.toBe(
			"deleted",
		);

		expect(updateBinds[0]).toBe("user_222");
		expect(typeof updateBinds[1]).toBe("string");
		expect(updateBinds[2]).toBe("schedule_1");
		expect(changeBinds[1]).toBe("schedule_1");
		expect(changeBinds[2]).toBe("user_222");
		expect(changeBinds[3]).toBe("delete");
		expect(JSON.parse(String(changeBinds[4]))).toMatchObject({
			id: "schedule_1",
			is_active: 1,
		});
		expect(JSON.parse(String(changeBinds[5]))).toMatchObject({
			id: "schedule_1",
			is_active: 0,
			next_run_at: null,
			updated_by: "user_222",
		});
	});

	it("confirms reminder updates and records update history", async () => {
		const before = makeReminderSnapshot();
		const after = {
			...before,
			title: "New Boss",
			repeat_rule: JSON.stringify({ type: "interval", minutes: 30 }),
			next_run_at: "2026-06-26T10:00:00+09:00",
			run_at: "2026-06-26T10:00:00+09:00",
		};
		const updateBinds: unknown[][] = [];
		const changeBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules") && sql.includes("parent_schedule_id = ?")) {
					return {
						bind: () => ({
							all: async () => ({ results: [] }),
						}),
					};
				}
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							first: async () => before,
						}),
					};
				}
				if (sql.includes("UPDATE schedules")) {
					return {
						bind: (...values: unknown[]) => {
							updateBinds.push(values);
							return { run: async () => ({ success: true }) };
						},
					};
				}
				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			confirmUpdateReminderSchedule(
				db,
				{
					schedule_id: before.id,
					before,
					after,
					notify_channel_id: "channel_123",
					created_by: "user_456",
					change_input: "제목을 New Boss로 바꿔줘",
					pre_reminder_action: "upsert",
				},
				"user_789",
			),
		).resolves.toBe("updated");

		expect(updateBinds[0]).toEqual([
			"New Boss",
			"2026-06-26T10:00:00+09:00",
			JSON.stringify({ type: "interval", minutes: 30 }),
			"2026-06-26T10:00:00+09:00",
			"user_789",
			expect.any(String),
			before.id,
		]);
		expect(changeBinds[0][1]).toBe(before.id);
		expect(changeBinds[0][2]).toBe("user_789");
		expect(changeBinds[0][3]).toBe("update");
		expect(JSON.parse(String(changeBinds[0][5]))).toMatchObject({
			title: "New Boss",
			updated_by: "user_789",
		});
	});

	it("confirms one-time overrides, replaces existing overrides, and moves next_run_at", async () => {
		const before = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-06-26T09:00:00+09:00",
			run_at: "2026-06-26T09:00:00+09:00",
		});
		const existingOverride = makeOverrideRow({
			run_at: "2026-06-26T21:00:00+09:00",
		});
		const afterOverride = {
			id: "override_2",
			schedule_id: before.id,
			title: "Hard Boss",
			run_at: "2026-06-26T22:00:00+09:00",
			status: "pending" as const,
			created_by: "user_456",
			created_at: "2026-04-25T00:00:00.000Z",
			updated_at: "2026-04-25T00:00:00.000Z",
		};
		const updateBinds: unknown[][] = [];
		const insertOverrideBinds: unknown[][] = [];
		const changeBinds: unknown[][] = [];
		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedule_overrides")) {
					return {
						bind: () => ({
							first: async () => existingOverride,
						}),
					};
				}
				if (sql.includes("FROM schedules") && sql.includes("parent_schedule_id = ?")) {
					return {
						bind: () => ({
							all: async () => ({ results: [] }),
						}),
					};
				}
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							first: async () => before,
						}),
					};
				}
				if (sql.includes("INSERT INTO schedule_overrides")) {
					return {
						bind: (...values: unknown[]) => {
							insertOverrideBinds.push(values);
							return { run: async () => ({ success: true }) };
						},
					};
				}
				if (sql.includes("INSERT INTO schedules")) {
					return {
						bind: () => ({ run: async () => ({ success: true }) }),
					};
				}
				if (sql.includes("UPDATE")) {
					return {
						bind: (...values: unknown[]) => {
							updateBinds.push(values);
							return { run: async () => ({ success: true }) };
						},
					};
				}
				return {
					bind: (...values: unknown[]) => {
						expect(sql).toContain("INSERT INTO schedule_changes");
						changeBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			confirmScheduleOverride(
				db,
				{
					schedule_id: before.id,
					before_schedule: before,
					existing_override: existingOverride,
					after_override: afterOverride,
					created_by: "user_456",
					change_input: "오후 10시에 제목은 Hard Boss로",
					pre_reminder_action: "upsert",
				},
				"user_789",
			),
		).resolves.toBe("created");

		expect(updateBinds.some((values) => values.includes(existingOverride.id))).toBe(true);
		expect(insertOverrideBinds[0]).toEqual([
			"override_2",
			before.id,
			"Hard Boss",
			"2026-06-26T22:00:00+09:00",
			"pending",
			"user_789",
			null,
			expect.any(String),
			expect.any(String),
		]);
		expect(updateBinds.some((values) => values[0] === "2026-06-26T22:00:00+09:00")).toBe(
			true,
		);
		expect(changeBinds[0][3]).toBe("override_replace");
	});

	it("parses repeat reminders", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		expect(ruleParseReminder("매일 오전 9시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T09:00:00+09:00",
			repeat: { type: "daily", time: "09:00" },
		});
		expect(ruleParseReminder("매주 월요일 오전 10시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-27T10:00:00+09:00",
			repeat: { type: "weekly", day_of_week: "monday", time: "10:00" },
		});
		expect(ruleParseReminder("30분마다 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T12:30:00+09:00",
			repeat: { type: "interval", minutes: 30 },
		});
		expect(ruleParseReminder("5분마다 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T12:05:00+09:00",
			repeat: { type: "interval", minutes: 5 },
		});
		expect(ruleParseReminder("2시간마다 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T14:00:00+09:00",
			repeat: { type: "interval", minutes: 120 },
		});
	});

	it("rejects interval reminders shorter than five minutes", () => {
		expect(ruleParseReminder("4분마다 알려줘", new Date("2026-04-25T03:00:00.000Z"))).toBeNull();
	});

	it("parses minute-level reminder times", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		expect(
			ruleParseReminder("매주 월요일 오후 9시 30분에 알려줘", now),
		).toMatchObject({
			run_at: "2026-04-27T21:30:00+09:00",
			repeat: { type: "weekly", day_of_week: "monday", time: "21:30" },
		});
		expect(ruleParseReminder("매일 오전 8시 15분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T08:15:00+09:00",
			repeat: { type: "daily", time: "08:15" },
		});
		expect(ruleParseReminder("내일 오후 3시 45분에 회의 알려줘", now)).toMatchObject({
			intent: "create_reminder",
			title: "회의",
			run_at: "2026-04-26T15:45:00+09:00",
		});
		expect(ruleParseReminder("오늘 21:30에 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T21:30:00+09:00",
		});
		expect(ruleParseReminder("오전 12시 30분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T00:30:00+09:00",
		});
		expect(ruleParseReminder("오후 12시 30분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T12:30:00+09:00",
		});
	});

	it("extracts reminder titles from natural Korean schedule text", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminder("내일 오후 9시에 보스가자고 해줘", now)).toMatchObject({
			title: "보스가자",
			run_at: "2026-04-26T21:00:00+09:00",
		});
		expect(ruleParseReminder("다음주 월요일 오전 10시에 놀러가자고 알려줘", now)).toMatchObject({
			title: "놀러가자",
			run_at: "2026-04-27T10:00:00+09:00",
		});
		expect(ruleParseReminder("5월 9일 9시에 물약 확인 해줘", now)).toMatchObject({
			title: "물약 확인",
			run_at: "2026-05-09T21:00:00+09:00",
		});
		expect(ruleParseReminder("매주 월요일 저녁쯤에 보스돌자고 해줘", now)).toMatchObject({
			title: "보스돌자",
			run_at: "2026-04-27T19:00:00+09:00",
			repeat: { type: "weekly", day_of_week: "monday", time: "19:00" },
		});
		expect(ruleParseReminder("내일 아침에 출석체크 해줘", now)).toMatchObject({
			title: "출석체크",
			run_at: "2026-04-26T08:00:00+09:00",
		});
		expect(ruleParseReminder("내일 오후 9시에 알려줘", now)).toMatchObject({
			title: "알림",
			run_at: "2026-04-26T21:00:00+09:00",
		});
		expect(ruleParseReminder("30분마다 물약 확인 해줘", now)).toMatchObject({
			title: "물약 확인",
			run_at: "2026-04-25T10:30:00+09:00",
			repeat: { type: "interval", minutes: 30 },
		});
		expect(ruleParseReminder("5월 9일 저녁쯤 보스가자고 해줘", now)).toMatchObject({
			title: "보스가자",
			run_at: "2026-05-09T19:00:00+09:00",
		});
	});

	it("parses one-time relative date reminders", () => {
		const now = new Date("2026-04-25T01:00:00.000Z");

		expect(ruleParseReminder("내일 오후 9시에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:00:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("내일 오후 9시 30분에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("다음주 월요일 오후 9시 30분에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-27T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("다음 주 화요일 21:30에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-28T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("오늘 오후 11시에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T23:00:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("모레 오전 8시 15분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-27T08:15:00+09:00",
			repeat: null,
		});
	});

	it("keeps next-week one-time reminders separate from weekly repeats", () => {
		const now = new Date("2026-04-25T01:00:00.000Z");

		expect(ruleParseReminder("매주 월요일 오후 9시 30분에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-27T21:30:00+09:00",
			repeat: { type: "weekly", day_of_week: "monday", time: "21:30" },
		});
		expect(ruleParseReminder("다음주 월요일 오후 9시 30분에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-04-27T21:30:00+09:00",
			repeat: null,
		});
	});

	it("rejects relative date reminders without enough information", () => {
		const now = new Date("2026-04-25T01:00:00.000Z");

		expect(ruleParseReminder("다음주에 알려줘", now)).toBeNull();
		expect(ruleParseReminder("내일 알려줘", now)).toBeNull();
	});

	it("parses absolute date one-time reminders before date-less fallback", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminder("5월 9일 아침 9시에 보스가자고 해", now)).toMatchObject({
			run_at: "2026-05-09T09:00:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("5월9일 오전 9시에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T09:00:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("05월 09일 오후 9시 30분에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("2026년 5월 9일 21:30에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("5/9 오전 9시에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T09:00:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("2026-05-09 21:30에 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T21:30:00+09:00",
			repeat: null,
		});
		expect(ruleParseReminder("5월 9일 저녁쯤 보스 알려줘", now)).toMatchObject({
			run_at: "2026-05-09T19:00:00+09:00",
			repeat: null,
		});
	});

	it("rejects absolute date reminders with missing time or invalid dates", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminder("5월 9일 보스 알려줘", now)).toBeNull();
		expect(ruleParseReminder("13월 1일 오전 9시에 보스 알려줘", now)).toBeNull();
		expect(ruleParseReminder("2월 30일 오전 9시에 보스 알려줘", now)).toBeNull();
	});

	it("rolls yearless absolute dates into next year when already past", () => {
		const now = new Date("2026-06-01T10:00:00+09:00");

		expect(ruleParseReminder("5월 9일 오전 9시에 보스 알려줘", now)).toMatchObject({
			run_at: "2027-05-09T09:00:00+09:00",
			repeat: null,
		});
	});

	it("marks clear rule parser results as high confidence", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminderDetailed("내일 오후 9시에 보스 알려줘", now)).toMatchObject({
			ok: true,
			confidence: "high",
			shouldFallbackToLlm: false,
			value: {
				run_at: "2026-04-26T21:00:00+09:00",
				repeat: null,
			},
		});
		expect(ruleParseReminderDetailed("5월 9일 아침 9시에 보스가자고 해", now)).toMatchObject({
			ok: true,
			confidence: "high",
			shouldFallbackToLlm: false,
			value: {
				run_at: "2026-05-09T09:00:00+09:00",
				repeat: null,
			},
		});
	});

	it("falls back to LLM for correction-heavy or uncertain date text", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(
			ruleParseReminderDetailed("내일말고 5월에 어디쯤 아 한 9일정도 저녁에 보스가자고 해줘", now),
		).toMatchObject({
			ok: true,
			shouldFallbackToLlm: true,
		});
		expect(ruleParseReminderDetailed("오늘 아니고 내일이나 모레쯤 밤에 알려줘", now)).toMatchObject({
			shouldFallbackToLlm: true,
		});
		expect(ruleParseReminderDetailed("대충 5월 초쯤 보스가자고 해줘", now)).toMatchObject({
			ok: false,
			shouldFallbackToLlm: true,
		});
	});

	it("uses rule parser for simple correction cases with a clear final date", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminderDetailed("오늘 말고 내일 오후 9시에 보스 알려줘", now)).toMatchObject({
			ok: true,
			shouldFallbackToLlm: false,
			value: {
				run_at: "2026-04-26T21:00:00+09:00",
				repeat: null,
			},
		});
		expect(ruleParseReminderDetailed("내일 말고 5월 9일 저녁에 보스 알려줘", now)).toMatchObject({
			ok: true,
			shouldFallbackToLlm: false,
			value: {
				run_at: "2026-05-09T19:00:00+09:00",
				repeat: null,
			},
		});
	});

	it("parses abstract weekly reminders with the rule parser", () => {
		const now = new Date("2026-04-25T10:00:00+09:00");

		expect(ruleParseReminderDetailed("매주 월요일 저녁쯤에 보스 알려줘", now)).toMatchObject({
			ok: true,
			shouldFallbackToLlm: false,
			value: {
				run_at: "2026-04-27T19:00:00+09:00",
				repeat: { type: "weekly", day_of_week: "monday", time: "19:00" },
			},
		});
	});

	it("parses relative date helper values in Asia/Seoul", () => {
		const now = new Date("2026-04-25T01:00:00.000Z");

		expect(parseRelativeDate("이번주 월요일", now)?.getUTCDate()).toBe(20);
		expect(parseRelativeDate("이번 주 일요일", now)?.getUTCDate()).toBe(26);
		expect(parseRelativeDate("다음주 월요일", now)?.getUTCDate()).toBe(27);
		expect(parseRelativeDate("다음 주 화요일", now)?.getUTCDate()).toBe(28);
	});

	it("parses compact and numeric time forms", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		expect(ruleParseReminder("내일 오후 9시30분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("내일 오후 9:30에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("내일 21시 30분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("내일 21시30분에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("내일 21:30에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
	});

	it("parses 반 (half-hour) as 30 minutes", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		expect(ruleParseReminder("내일 오후 9시 반에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("내일 오후 9시반에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:30:00+09:00",
		});
		expect(ruleParseReminder("매주 일요일 오전 9시 반에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T09:30:00+09:00",
			repeat: { type: "weekly", day_of_week: "sunday", time: "09:30" },
		});
		expect(ruleParseReminder("매일 오후 9시 반에 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T21:30:00+09:00",
			repeat: { type: "daily", time: "21:30" },
		});
	});

	it("defaults to PM when no meridiem is given", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		// 1–11시: 오후로 간주
		expect(ruleParseReminder("내일 9시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:00:00+09:00",
		});
		expect(ruleParseReminder("내일 1시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T13:00:00+09:00",
		});
		expect(ruleParseReminder("내일 11시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T23:00:00+09:00",
		});

		// 12시: 정오 그대로
		expect(ruleParseReminder("내일 12시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T12:00:00+09:00",
		});

		// 0시: 자정 그대로
		expect(ruleParseReminder("내일 0시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T00:00:00+09:00",
		});

		// 13–23시: 24시간 표기, 그대로
		expect(ruleParseReminder("내일 13시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T13:00:00+09:00",
		});
		expect(ruleParseReminder("내일 21시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:00:00+09:00",
		});

		// 반복 일정도 동일 적용
		expect(ruleParseReminder("매일 9시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-25T21:00:00+09:00",
			repeat: { type: "daily", time: "21:00" },
		});
		expect(ruleParseReminder("매주 목요일 9시에 알려줘", now)).toMatchObject({
			repeat: { type: "weekly", day_of_week: "thursday", time: "21:00" },
		});

		// 오전/오후 명시 시 기존 동작 유지
		expect(ruleParseReminder("내일 오전 9시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T09:00:00+09:00",
		});
		expect(ruleParseReminder("내일 오후 9시에 알려줘", now)).toMatchObject({
			run_at: "2026-04-26T21:00:00+09:00",
		});
	});

	it("rejects invalid reminder times", () => {
		const now = new Date("2026-04-25T03:00:00.000Z");

		expect(ruleParseReminder("오후 9시 99분에 알려줘", now)).toBeNull();
		expect(ruleParseReminder("25시 10분에 알려줘", now)).toBeNull();
		expect(ruleParseReminder("오후 13시 30분에 알려줘", now)).toBeNull();
	});

	it("sends due reminder schedules and marks them complete", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("discord.com")
				? new Response(JSON.stringify({ id: "message_123" }), { status: 200 })
				: new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT")) {
					expect(sql).toContain("LIMIT 20");
					return {
						bind: (dueTime: string) => ({
							all: async () => {
								expect(dueTime).toBe("2026-04-26T09:00:00+09:00");
								return {
									results: [
										{
											id: "schedule_1",
											type: "reminder",
											title: "회의",
											run_at: "2026-04-26T09:00:00+09:00",
											notify_channel_id: "channel_123",
											next_run_at: "2026-04-26T09:00:00+09:00",
											created_by: "user_123",
										},
										{
											id: "schedule_2",
											type: "crawl",
											title: "크롤링",
											run_at: null,
											notify_channel_id: "channel_456",
											next_run_at: "2026-04-26T09:00:00+09:00",
										},
									],
								};
							},
						}),
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: undefined,
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://discord.com/api/v10/channels/channel_123/messages",
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bot bot_token",
					"content-type": "application/json",
				},
				body: expect.stringContaining("acknowledge_alert:"),
			}),
		);
		const discordCall = fetchMock.mock.calls.find(
			([url]) => url === "https://discord.com/api/v10/channels/channel_123/messages",
		);
		const body = JSON.parse(String(discordCall?.[1]?.body)) as {
			allowed_mentions: unknown;
			content: string;
		};
		expect(body.content).toContain("<@user_123>님이 회의 하자고 해요!");
		expect(body.content).toContain("시간: 2026년 4월 26일 일요일 오전 9시 00분");
		expect(body.content).toContain("[확인 현황]");
		expect(body.content).toContain("아직 확인한 사람이 없습니다.");
		expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
		expect(updateBinds).toEqual([
			[
				"2026-04-26T00:00:00.000Z",
				"2026-04-26T00:00:00.000Z",
				"2026-04-26T00:00:00.000Z",
				"schedule_1",
			],
			[
				"2026-04-26T09:10:00+09:00",
				"2026-04-26T00:00:00.000Z",
				"2026-04-26T00:00:00.000Z",
				"schedule_2",
			],
		]);
	});

	it("deactivates one-time pre-reminders after they are sent", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("discord.com")
				? new Response(JSON.stringify({ id: "message_pre" }), { status: 200 })
				: new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT") && sql.includes("WHERE id = ?")) {
					return {
						bind: () => ({
							first: async () => ({
								id: "schedule_main",
								type: "reminder",
								title: "보스가자",
								run_at: "2026-05-09T21:00:00+09:00",
								repeat_rule: null,
								notify_channel_id: "channel_123",
								next_run_at: "2026-05-09T21:00:00+09:00",
								created_by: "user_123",
								reminder_kind: "main",
							}),
						}),
					};
				}

				if (sql.includes("SELECT")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "schedule_pre",
										type: "reminder",
										title: "보스가자",
										run_at: "2026-05-09T20:30:00+09:00",
										repeat_rule: null,
										notify_channel_id: "channel_123",
										next_run_at: "2026-05-09T20:30:00+09:00",
										created_by: "user_123",
										parent_schedule_id: "schedule_main",
										reminder_kind: "pre",
										offset_minutes: -30,
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
			},
			new Date("2026-05-09T11:30:00.000Z"),
		);

		const discordCall = fetchMock.mock.calls.find(
			([url]) => url === "https://discord.com/api/v10/channels/channel_123/messages",
		);
		const body = JSON.parse(String(discordCall?.[1]?.body)) as { content: string };
		expect(body.content).toContain("[30분 전 알림]");
		expect(body.content).toContain("<@user_123>님이 곧 보스가자고 해요!");
		expect(body.content).toContain("본 일정 시간: 2026년 5월 9일 토요일 오후 9시 00분");
		expect(body.content).toContain("알림 시간: 2026년 5월 9일 토요일 오후 8시 30분");
		expect(body.content).not.toContain("반복");
		expect(body.content).not.toContain("1회성 일정");
		expect(updateBinds).toContainEqual([
			"2026-05-09T11:30:00.000Z",
			"2026-05-09T11:30:00.000Z",
			"2026-05-09T11:30:00.000Z",
			"schedule_pre",
		]);
	});

	it("mentions the configured notify role in reminder messages", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("discord.com")
				? new Response(JSON.stringify({ id: "message_role" }), { status: 200 })
				: new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "schedule_role",
										type: "reminder",
										title: "보스가자",
										run_at: "2026-04-26T09:00:00+09:00",
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
										created_by: "user_123",
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				return {
					bind: () => ({
						run: async () => ({ success: true }),
					}),
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: "role_123",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://discord.com/api/v10/channels/channel_123/messages",
			expect.objectContaining({
				body: expect.stringContaining("<@&role_123>"),
			}),
		);
		const discordCall = fetchMock.mock.calls.find(
			([url]) => url === "https://discord.com/api/v10/channels/channel_123/messages",
		);
		const body = JSON.parse(String(discordCall?.[1]?.body)) as {
			allowed_mentions: unknown;
			content: string;
		};
		expect(body.content).toContain("<@user_123>님이 보스가자고 해요!");
		expect(body.allowed_mentions).toEqual({ roles: ["role_123"], users: [] });
	});

	it("automatically appends new MapleStory updates to reminder alerts once globally", async () => {
		const updateBinds: unknown[][] = [];
		let detectedInsertCount = 0;
		const html = `<a href="/news/update/777"><span>클라이언트 업데이트 안내</span><span>2026.04.25</span></a>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(html, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "message_auto_1" }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "message_auto_2" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "reminder_1",
										type: "reminder",
										title: "첫 알림",
										run_at: "2026-04-26T09:00:00+09:00",
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
									{
										id: "reminder_2",
										type: "reminder",
										title: "두 번째 알림",
										run_at: "2026-04-26T09:01:00+09:00",
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:01:00+09:00",
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("FROM detected_events")) {
					return {
						bind: () => ({
							first: async () => null,
						}),
					};
				}

				if (sql.includes("INSERT") && sql.includes("detected_events")) {
					return {
						bind: (...values: unknown[]) => {
							detectedInsertCount += 1;
							expect(values[1]).toBe("source:maplestory_update");
							const changes = detectedInsertCount === 1 ? 1 : 0;
							return {
								run: async () => ({
									success: true,
									meta: { changes },
								}),
							};
						},
					};
				}

				if (sql.includes("INSERT INTO alerts")) {
					return {
						bind: () => ({
							run: async () => ({ success: true }),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: "role_123",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		const firstDiscordBody = JSON.parse(
			String(fetchMock.mock.calls[1]?.[1]?.body),
		) as { content: string };
		const secondDiscordBody = JSON.parse(
			String(fetchMock.mock.calls[2]?.[1]?.body),
		) as { content: string };

		expect(firstDiscordBody.content).toContain("[신규 메이플 업데이트 감지]");
		expect(firstDiscordBody.content).toContain("클라이언트 업데이트 안내");
		expect(firstDiscordBody.content).toContain("날짜: 2026년 4월 25일");
		expect(firstDiscordBody.content).toContain(
			"https://maplestory.nexon.com/news/update/777",
		);
		expect(secondDiscordBody.content).not.toContain("[신규 메이플 업데이트 감지]");
		expect(
			updateBinds.filter((values) => values.at(-1) === "reminder_1" || values.at(-1) === "reminder_2"),
		).toHaveLength(2);
		expect(
			fetchMock.mock.calls.filter(
				([url]) => url === "https://m.maplestory.nexon.com/news/update",
			),
		).toHaveLength(1);
	});

	it("detects new MapleStory update posts and sends Discord alerts", async () => {
		const detectedBinds: unknown[][] = [];
		const updateBinds: unknown[][] = [];
		let insertCount = 0;
		const html = [
			`<a href="/news/update/123"><span>클라이언트 1.2.3 업데이트 안내</span><span>2026.04.25</span></a>`,
			`<a href="/news/update/124"><span>신규 패치 안내</span><span>2026.04.24</span></a>`,
		].join("");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(html, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "message_crawl" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "crawl_1",
										type: "crawl",
										title: "메이플스토리 업데이트 감지",
										target_url: "https://m.maplestory.nexon.com/news/update",
										run_at: null,
										interval_minutes: 10,
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("FROM detected_events")) {
					return {
						bind: () => ({
							first: async () => null,
						}),
					};
				}

				if (sql.includes("INSERT") && sql.includes("detected_events")) {
					return {
						bind: (...values: unknown[]) => {
							insertCount += 1;
							const changes = insertCount === 1 ? 0 : 1;
							if (changes > 0) {
								detectedBinds.push(values);
							}
							return {
								run: async () => ({
									success: true,
									meta: { changes },
								}),
							};
						},
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: "role_123",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://m.maplestory.nexon.com/news/update",
			expect.objectContaining({
				headers: {
					"user-agent": "MapleJarvis Discord schedule crawler",
				},
			}),
		);
		expect(detectedBinds).toHaveLength(1);
		expect(detectedBinds[0][1]).toBe("source:maplestory_update");
		expect(detectedBinds[0][3]).toBe("신규 패치 안내");
		expect(detectedBinds[0][4]).toBe("https://maplestory.nexon.com/news/update/124");
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://discord.com/api/v10/channels/channel_123/messages",
			expect.objectContaining({
				body: JSON.stringify({
					content:
						"<@&role_123>\n[신규 업데이트 감지]\n대상: 메이플스토리 업데이트\n제목: 신규 패치 안내\n날짜: 2026-04-24\nURL: https://maplestory.nexon.com/news/update/124",
					allowed_mentions: {
						roles: ["role_123"],
						users: [],
					},
				}),
			}),
		);
		expect(updateBinds).toEqual([
			[
				"2026-04-26T09:10:00+09:00",
				"2026-04-26T00:00:00.000Z",
				"2026-04-26T00:00:00.000Z",
				"crawl_1",
			],
		]);
	});

	it("canonicalizes MapleStory update URL casing before storing detected events", async () => {
		const detectedBinds: unknown[][] = [];
		const updateBinds: unknown[][] = [];
		const html = `<a href="/News/update/800"><span>클라이언트 업데이트 안내</span><span>2026.04.25</span></a>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(html, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "message_crawl" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "crawl_1",
										type: "crawl",
										title: "메이플스토리 업데이트 감지",
										target_url: "https://m.maplestory.nexon.com/news/update",
										run_at: null,
										interval_minutes: 10,
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("FROM detected_events")) {
					return {
						bind: () => ({
							first: async () => null,
						}),
					};
				}

				if (sql.includes("INSERT") && sql.includes("detected_events")) {
					return {
						bind: (...values: unknown[]) => {
							detectedBinds.push(values);
							return {
								run: async () => ({
									success: true,
									meta: { changes: 1 },
								}),
							};
						},
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: "role_123",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		expect(detectedBinds).toHaveLength(1);
		expect(detectedBinds[0][4]).toBe(
			"https://maplestory.nexon.com/news/update/800",
		);
		expect(updateBinds).toContainEqual([
			"2026-04-26T09:10:00+09:00",
			"2026-04-26T00:00:00.000Z",
			"2026-04-26T00:00:00.000Z",
			"crawl_1",
		]);
	});

	it("does not resend alerts for MapleStory update URLs already stored with older event keys", async () => {
		let detectedInsertCount = 0;
		const updateBinds: unknown[][] = [];
		const html = `<a href="/news/update/800"><span>클라이언트 업데이트 안내</span><span>2026.04.25</span></a>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(html, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "crawl_1",
										type: "crawl",
										title: "메이플스토리 업데이트 감지",
										target_url: "https://m.maplestory.nexon.com/news/update",
										run_at: null,
										interval_minutes: 10,
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
								],
							}),
						}),
					};
				}

				if (sql.includes("FROM detected_events")) {
					return {
						bind: (sourceKey: string, sourceUrl: string) => {
							expect(sourceKey).toBe("source:maplestory_update");
							expect(sourceUrl).toBe("https://maplestory.nexon.com/news/update/800");
							return {
								first: async () => ({ 1: 1 }),
							};
						},
					};
				}

				if (sql.includes("INSERT") && sql.includes("detected_events")) {
					return {
						bind: () => {
							detectedInsertCount += 1;
							return { run: async () => ({ success: true }) };
						},
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
				DISCORD_NOTIFY_ROLE_ID: "role_123",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		expect(detectedInsertCount).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(updateBinds).toEqual([
			[
				"2026-04-26T09:10:00+09:00",
				"2026-04-26T00:00:00.000Z",
				"2026-04-26T00:00:00.000Z",
				"crawl_1",
			],
		]);
	});

	it("builds stable MapleStory event keys from source key and canonical link", async () => {
		const html = `<a href="/News/update/800"><span>클라이언트 업데이트 안내</span><span>2026.04.25</span></a>`;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(new Response(html, { status: 200 })),
		);

		const [post] = await fetchMaplestoryUpdatePosts();
		const canonicalPost = {
			title: "클라이언트 업데이트 안내",
			date: "2026-04-25",
			link: "https://maplestory.nexon.com/news/update/800",
		};

		expect(post).toEqual(canonicalPost);
		await expect(buildEventKey("source:maplestory_update", post)).resolves.toBe(
			await buildEventKey("source:maplestory_update", canonicalPost),
		);
		await expect(buildEventKey("source:maplestory_update", post)).resolves.toBe(
			await buildEventKey("source:maplestory_update", {
				...canonicalPost,
				date: "날짜 미상",
			}),
		);
		await expect(buildEventKey("source:maplestory_update", post)).resolves.toBe(
			await buildEventKey("source:maplestory_update", {
				...canonicalPost,
				title: "수정 클라이언트 업데이트 안내",
			}),
		);
		await expect(buildEventKey("source:maplestory_update", post)).resolves.not.toBe(
			await buildEventKey("source:maplestory_update", {
				...canonicalPost,
				link: "https://maplestory.nexon.com/news/update/801",
			}),
		);
	});

	it("records crawl fetch failures without throwing out of cron", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("FROM schedules")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "crawl_fail",
										type: "crawl",
										title: "메이플스토리 업데이트 감지",
										target_url: "https://m.maplestory.nexon.com/news/update",
										run_at: null,
										interval_minutes: 10,
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
								],
							}),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return { run: async () => ({ success: true }) };
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			processDueSchedules(
				{
					...env,
					DB: db,
					DISCORD_BOT_TOKEN: "bot_token",
				},
				new Date("2026-04-26T00:00:00.000Z"),
			),
		).resolves.toBeUndefined();

		expect(updateBinds).toEqual([
			[
				"2026-04-26T00:00:00.000Z",
				"MapleStory update fetch failed. primary=Crawl fetch failed with HTTP 500; fallback=Crawl fetch failed with HTTP 500",
				"2026-04-26T00:00:00.000Z",
				"crawl_fail",
			],
		]);
	});

	it("records reminder failures without stopping later schedules", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("{}", { status: 200 }))
			.mockResolvedValueOnce(new Response("nope", { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "message_ok" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "schedule_fail",
										type: "reminder",
										title: "실패",
										run_at: "2026-04-26T09:00:00+09:00",
										notify_channel_id: "channel_fail",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
									{
										id: "schedule_ok",
										type: "reminder",
										title: "성공",
										run_at: "2026-04-26T09:01:00+09:00",
										notify_channel_id: "channel_ok",
										next_run_at: "2026-04-26T09:01:00+09:00",
									},
								],
							}),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
			},
			new Date("2026-04-26T00:01:00.000Z"),
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(updateBinds[0]).toEqual([
			"2026-04-26T00:01:00.000Z",
			"Discord message failed with HTTP 500: nope",
			"2026-04-26T00:01:00.000Z",
			"schedule_fail",
		]);
		expect(updateBinds.find((values) => values.at(-1) === "schedule_ok")).toEqual([
			"2026-04-26T00:01:00.000Z",
			"2026-04-26T00:01:00.000Z",
			"2026-04-26T00:01:00.000Z",
			"schedule_ok",
		]);
	});

	it("keeps repeat reminders active and advances next_run_at", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("discord.com")
				? new Response(JSON.stringify({ id: "message_repeat" }), { status: 200 })
				: new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "schedule_repeat",
										type: "reminder",
										title: "반복",
										run_at: "2026-04-25T09:00:00+09:00",
										repeat_rule: JSON.stringify({
											type: "interval",
											minutes: 30,
										}),
										notify_channel_id: "channel_repeat",
										next_run_at: "2026-04-26T09:00:00+09:00",
									},
								],
							}),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		const discordCall = fetchMock.mock.calls.find(
			([url]) => url === "https://discord.com/api/v10/channels/channel_repeat/messages",
		);
		const body = JSON.parse(String(discordCall?.[1]?.body)) as { content: string };
		expect(body.content).toContain("시간: 2026년 4월 26일 일요일 오전 9시 00분");
		expect(body.content).not.toContain("시간: 2026년 4월 25일 토요일 오전 9시 00분");
		expect(updateBinds.find((values) => values.at(-1) === "schedule_repeat")).toEqual([
			"2026-04-26T09:30:00+09:00",
			"2026-04-26T00:00:00.000Z",
			"2026-04-26T00:00:00.000Z",
			"2026-04-26T00:00:00.000Z",
			"schedule_repeat",
		]);
	});

	it("uses repeat_rule minutes when advancing daily reminders", async () => {
		const updateBinds: unknown[][] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("discord.com")
				? new Response(JSON.stringify({ id: "message_daily" }), { status: 200 })
				: new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const db = {
			prepare: (sql: string) => {
				if (sql.includes("SELECT")) {
					return {
						bind: () => ({
							all: async () => ({
								results: [
									{
										id: "schedule_daily",
										type: "reminder",
										title: "매일",
										run_at: "2026-04-26T08:15:00+09:00",
										repeat_rule: JSON.stringify({
											type: "daily",
											time: "08:15",
										}),
										notify_channel_id: "channel_daily",
										next_run_at: "2026-04-26T08:15:00+09:00",
									},
								],
							}),
						}),
					};
				}

				return {
					bind: (...values: unknown[]) => {
						updateBinds.push(values);
						return {
							run: async () => ({ success: true }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await processDueSchedules(
			{
				...env,
				DB: db,
				DISCORD_BOT_TOKEN: "bot_token",
			},
			new Date("2026-04-26T00:00:00.000Z"),
		);

		const scheduleUpdate = updateBinds.find((values) => values.at(-1) === "schedule_daily");
		expect(scheduleUpdate?.[0]).toBe("2026-04-27T08:15:00+09:00");
	});

	it("builds title-only reminder updates without changing schedule time", () => {
		const before = makeReminderSnapshot();
		const result = buildReminderUpdateFromInput(
			before,
			"제목을 New Boss로 바꿔줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			after: {
				title: "New Boss",
				run_at: before.run_at,
				repeat_rule: before.repeat_rule,
				next_run_at: before.next_run_at,
			},
		});
	});

	it("changes only the time for one-time reminders while keeping the date", () => {
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({ run_at: "2026-04-26T09:00:00+09:00" }),
			"오후 10시로 바꿔줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			after: {
				run_at: "2026-04-26T22:00:00+09:00",
				next_run_at: "2026-04-26T22:00:00+09:00",
				repeat_rule: null,
			},
		});
	});

	it("defaults to PM and supports 반 in update modal time input", () => {
		const now = new Date("2026-04-25T00:00:00.000Z");
		const base = makeReminderSnapshot({ run_at: "2026-04-26T09:00:00+09:00" });

		// 오전/오후 없는 1–11시 → 오후로 간주
		expect(buildReminderUpdateFromInput(base, "9시로 바꿔줘", now)).toMatchObject({
			ok: true,
			after: { run_at: "2026-04-26T21:00:00+09:00" },
		});

		// 반 → 30분
		expect(buildReminderUpdateFromInput(base, "9시 반으로 바꿔줘", now)).toMatchObject({
			ok: true,
			after: { run_at: "2026-04-26T21:30:00+09:00" },
		});

		// 오전 명시 시 기존 동작 유지 (기존 시간과 달라야 변경 감지됨)
		const baseEvening = makeReminderSnapshot({ run_at: "2026-04-26T21:00:00+09:00" });
		expect(buildReminderUpdateFromInput(baseEvening, "오전 9시로 바꿔줘", now)).toMatchObject({
			ok: true,
			after: { run_at: "2026-04-26T09:00:00+09:00" },
		});
	});

	it("updates daily repeat time and recalculates the next run", () => {
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
				run_at: "2026-04-26T09:00:00+09:00",
				next_run_at: "2026-04-26T09:00:00+09:00",
			}),
			"오후 10시로 바꿔줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			after: {
				repeat_rule: JSON.stringify({ type: "daily", time: "22:00" }),
				next_run_at: "2026-04-25T22:00:00+09:00",
			},
		});
	});

	it("keeps the next run and clears repeat when requested", () => {
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "monday", time: "09:00" }),
				run_at: "2026-04-27T09:00:00+09:00",
				next_run_at: "2026-04-27T09:00:00+09:00",
			}),
			"반복 없애줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			after: {
				repeat_rule: null,
				run_at: "2026-04-27T09:00:00+09:00",
				next_run_at: "2026-04-27T09:00:00+09:00",
			},
		});
	});

	it("rejects time-only updates for interval reminders", () => {
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				repeat_rule: JSON.stringify({ type: "interval", minutes: 30 }),
				run_at: "2026-04-25T10:30:00+09:00",
				next_run_at: "2026-04-25T10:30:00+09:00",
			}),
			"오후 10시로 바꿔줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({ ok: false });
	});

	it("omits pre reminders when the calculated pre reminder time is past", () => {
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				run_at: "2026-04-25T21:30:00+09:00",
				next_run_at: "2026-04-25T21:30:00+09:00",
			}),
			"오후 10시로 바꿔줘",
			new Date("2026-04-25T21:45:00+09:00"),
		);

		expect(result).toMatchObject({
			ok: true,
			preReminderAction: "disable",
			after: { next_run_at: "2026-04-25T22:00:00+09:00" },
		});
	});

	it("moves the update date to the next occurrence of a bare weekday", () => {
		// now = 2026-04-25 (토요일 KST). 다음 목요일 = 2026-04-30
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "saturday", time: "21:00" }),
				run_at: "2026-04-25T21:00:00+09:00",
				next_run_at: "2026-04-25T21:00:00+09:00",
			}),
			"목요일 오후 9시 30분으로 바꿔줘",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			after: { next_run_at: "2026-04-30T21:30:00+09:00" },
		});
	});

	it("moves the update date to today when the bare weekday matches today and time is in the future", () => {
		// now = 2026-04-23 (목요일 KST) 오전 10시. 목요일 21:30은 아직 미래
		const result = buildReminderUpdateFromInput(
			makeReminderSnapshot({
				repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
				run_at: "2026-04-24T09:00:00+09:00",
				next_run_at: "2026-04-24T09:00:00+09:00",
			}),
			"목요일 오후 9시 30분으로 바꿔줘",
			new Date("2026-04-23T01:00:00.000Z"), // UTC 01:00 = KST 10:00
		);

		expect(result).toMatchObject({
			ok: true,
			after: { next_run_at: "2026-04-23T21:30:00+09:00" },
		});
	});

	it("builds one-time overrides from time-only input using the next occurrence date", () => {
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-04-26T09:00:00+09:00",
			run_at: "2026-04-26T09:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"오후 10시로",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				title: null,
				run_at: "2026-04-26T22:00:00+09:00",
			},
			preReminderAction: "upsert",
		});
	});

	it("defaults to PM and supports 반 in override modal time input", () => {
		const now = new Date("2026-04-25T00:00:00.000Z");
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-04-26T09:00:00+09:00",
			run_at: "2026-04-26T09:00:00+09:00",
		});

		// 오전/오후 없는 1–11시 → 오후로 간주
		expect(buildScheduleOverrideFromInput(schedule, "9시로", null, "user_456", now)).toMatchObject({
			ok: true,
			afterOverride: { run_at: "2026-04-26T21:00:00+09:00" },
		});

		// 반 → 30분
		expect(buildScheduleOverrideFromInput(schedule, "9시 반으로", null, "user_456", now)).toMatchObject({
			ok: true,
			afterOverride: { run_at: "2026-04-26T21:30:00+09:00" },
		});

		// 오전 명시 시 기존 동작 유지
		expect(buildScheduleOverrideFromInput(schedule, "오전 9시로", null, "user_456", now)).toMatchObject({
			ok: true,
			afterOverride: { run_at: "2026-04-26T09:00:00+09:00" },
		});
	});

	it("builds one-time overrides from title-only input while keeping the next run time", () => {
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "monday", time: "09:00" }),
			next_run_at: "2026-04-27T09:00:00+09:00",
			run_at: "2026-04-27T09:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"이번만 제목을 Hard Boss로",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				title: "Hard Boss",
				run_at: "2026-04-27T09:00:00+09:00",
			},
		});
	});

	it("rejects one-time overrides for non daily-weekly schedules", () => {
		const result = buildScheduleOverrideFromInput(
			makeReminderSnapshot({ repeat_rule: JSON.stringify({ type: "interval", minutes: 30 }) }),
			"오후 10시로",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({ ok: false });
	});

	it("moves the date to the next occurrence of a bare weekday", () => {
		// now = 2026-04-25 (토요일 KST). 다음 목요일 = 2026-04-30
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "saturday", time: "21:00" }),
			next_run_at: "2026-04-25T21:00:00+09:00",
			run_at: "2026-04-25T21:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"목요일 오후 9시 30분",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				title: null,
				run_at: "2026-04-30T21:30:00+09:00",
			},
		});
	});

	it("moves the date to tomorrow when 내일 is specified", () => {
		// now = 2026-04-25 KST. 내일 = 2026-04-26
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-04-26T09:00:00+09:00",
			run_at: "2026-04-26T09:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"내일 오후 9시 30분",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				run_at: "2026-04-26T21:30:00+09:00",
			},
		});
	});

	it("moves the date to the day after tomorrow when 모레 is specified", () => {
		// now = 2026-04-25 KST. 모레 = 2026-04-27
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-04-26T09:00:00+09:00",
			run_at: "2026-04-26T09:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"모레 오후 9시 30분",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				run_at: "2026-04-27T21:30:00+09:00",
			},
		});
	});

	it("moves the date to next week's weekday when 다음 주 is specified", () => {
		// now = 2026-04-25 (토요일 KST). 다음 주 목요일 = 2026-04-30 (+7 from current week's Thursday)
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "weekly", day_of_week: "saturday", time: "21:00" }),
			next_run_at: "2026-04-25T21:00:00+09:00",
			run_at: "2026-04-25T21:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"다음 주 목요일 오후 9시 30분",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				run_at: "2026-04-30T21:30:00+09:00",
			},
		});
	});

	it("moves the date to an absolute date when MM월 DD일 is specified", () => {
		// 6월 10일 오후 9시 30분
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "09:00" }),
			next_run_at: "2026-04-26T09:00:00+09:00",
			run_at: "2026-04-26T09:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"6월 10일 오후 9시 30분",
			null,
			"user_456",
			new Date("2026-04-25T00:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: true,
			afterOverride: {
				run_at: "2026-06-10T21:30:00+09:00",
			},
		});
	});

	it("rejects when the resolved date is in the past", () => {
		// now = 2026-04-25 오전 10시. 오늘 오전 8시는 이미 과거
		const schedule = makeReminderSnapshot({
			repeat_rule: JSON.stringify({ type: "daily", time: "21:00" }),
			next_run_at: "2026-04-25T21:00:00+09:00",
			run_at: "2026-04-25T21:00:00+09:00",
		});

		const result = buildScheduleOverrideFromInput(
			schedule,
			"오늘 오전 8시",
			null,
			"user_456",
			new Date("2026-04-25T01:00:00.000Z"), // UTC 01:00 = KST 10:00
		);

		expect(result).toMatchObject({ ok: false });
	});

	it("lists active schedules for the current channel", async () => {
		let boundChannelId = "";
		const db = {
			prepare: (sql: string) => {
				expect(sql).toContain("WHERE s.is_active = 1");
				expect(sql).toContain("s.notify_channel_id = ?");
				expect(sql).toContain("s.reminder_kind IS NULL OR s.reminder_kind = 'main'");
				expect(sql).toContain("LIMIT 5");
				return {
					bind: (channelId: string) => {
						boundChannelId = channelId;
						return {
							all: async () => ({
								results: [
									{
										id: "schedule_1",
										type: "reminder",
										title: "회의",
										run_at: "2026-04-26T09:00:00+09:00",
										notify_channel_id: "channel_123",
										next_run_at: "2026-04-26T09:00:00+09:00",
										is_active: 1,
										repeat_rule: JSON.stringify({
											type: "weekly",
											day_of_week: "monday",
											time: "21:30",
										}),
										created_by: "user_123",
										created_at: "2026-04-25T00:00:00.000Z",
									},
								],
							}),
						};
					},
				};
			},
		} as unknown as D1Database;

		const schedules = await listActiveSchedulesForChannel(db, "channel_123");

		expect(boundChannelId).toBe("channel_123");
		expect(schedules).toEqual([
			{
				id: "schedule_1",
				type: "reminder",
				title: "회의",
				run_at: "2026-04-26T09:00:00+09:00",
				notify_channel_id: "channel_123",
				next_run_at: "2026-04-26T09:00:00+09:00",
				repeat_rule: JSON.stringify({
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				}),
				created_by: "user_123",
				is_active: 1,
				created_at: "2026-04-25T00:00:00.000Z",
			},
		]);
	});

	it("formats schedule lists with Korean time and non-pinging creator mentions", async () => {
		const content = formatScheduleList([
			{
				id: "schedule_1",
				type: "reminder",
				title: "회의",
				run_at: "2026-04-26T09:00:00+09:00",
				repeat_rule: JSON.stringify({
					type: "daily",
					time: "09:30",
				}),
				notify_channel_id: "channel_123",
				next_run_at: "2026-04-26T09:00:00+09:00",
				is_active: 1,
				created_by: "user_123",
				created_at: "2026-04-25T00:00:00.000Z",
				pre_offset_minutes: -30,
			},
		]);

		expect(content).toContain("시간: 2026년 4월 26일 일요일 오전 9시 00분");
		expect(content).toContain("반복: 매일 오전 9시 30분");
		expect(content).toContain("등록자: <@user_123>");
	});

	it("includes weekdays in schedule list times while keeping weekly repeat labels", async () => {
		const content = formatScheduleList([
			{
				id: "schedule_1",
				type: "reminder",
				title: "보스",
				run_at: "2026-04-27T21:30:00+09:00",
				repeat_rule: JSON.stringify({
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				}),
				notify_channel_id: "channel_123",
				next_run_at: "2026-04-27T21:30:00+09:00",
				is_active: 1,
				created_by: "user_123",
				created_at: "2026-04-25T00:00:00.000Z",
			},
		]);

		expect(content).toContain("시간: 2026년 4월 27일 월요일 오후 9시 30분");
		expect(content).toContain("반복: 매주 월요일 오후 9시 30분");
	});

	it("shows 이번만 변경 annotation when pending override exists", () => {
		const content = formatScheduleList([
			{
				id: "schedule_1",
				type: "reminder",
				title: "보스",
				run_at: "2026-04-27T21:30:00+09:00",
				repeat_rule: JSON.stringify({
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				}),
				notify_channel_id: "channel_123",
				next_run_at: "2026-04-28T22:00:00+09:00",
				is_active: 1,
				created_by: "user_123",
				created_at: "2026-04-25T00:00:00.000Z",
				pending_override_run_at: "2026-04-28T22:00:00+09:00",
				pending_override_title: null,
			},
		]);

		expect(content).toContain("2026년 4월 28일 화요일 오후 10시 00분 (이번만 변경)");
		expect(content).not.toContain("이번만 변경:");
	});

	it("shows 이번만 변경 with title when override includes title change", () => {
		const content = formatScheduleList([
			{
				id: "schedule_1",
				type: "reminder",
				title: "보스",
				run_at: "2026-04-27T21:30:00+09:00",
				repeat_rule: JSON.stringify({
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				}),
				notify_channel_id: "channel_123",
				next_run_at: "2026-04-28T22:00:00+09:00",
				is_active: 1,
				created_by: "user_123",
				created_at: "2026-04-25T00:00:00.000Z",
				pending_override_run_at: "2026-04-28T22:00:00+09:00",
				pending_override_title: "하드 보스",
			},
		]);

		expect(content).toContain("2026년 4월 28일 화요일 오후 10시 00분 (이번만 변경: 하드 보스)");
	});

	it("responds to health checks (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "discord-schedule-bot",
		});
	});

	it("responds to health checks (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "discord-schedule-bot",
		});
	});

	it("does not expose development GET endpoints in production routes", async () => {
		for (const path of ["/db-test", "/maple-test", "/cron-test"]) {
			const request = new IncomingRequest(`http://example.com${path}`);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(405);
		}
	});

	it("rejects Discord POST requests when the public key is not configured", async () => {
		const request = new IncomingRequest("http://example.com", {
			method: "POST",
			body: JSON.stringify({ type: 1 }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("DISCORD_PUBLIC_KEY is not configured");
	});
});

describe("Daily cleanup", () => {
	function makeCleanupDb(onSql?: (sql: string) => void) {
		return {
			prepare: (sql: string) => {
				onSql?.(sql);
				return { run: async () => ({ success: true }) };
			},
		} as unknown as D1Database;
	}

	it("deletes from all 7 tables in the correct order", async () => {
		const deletedTables: string[] = [];
		const db = makeCleanupDb((sql) => {
			const match = sql.match(/DELETE FROM (\w+)/);
			if (match) deletedTables.push(match[1]);
		});

		await runDailyCleanup({ ...env, DB: db });

		expect(deletedTables).toEqual([
			"pending_actions",
			"alert_reads",
			"alerts",
			"schedule_overrides",
			"schedule_changes",
			"schedules",
			"detected_events",
		]);
	});

	it("only deletes inactive schedules", async () => {
		let schedulesSql = "";
		const db = makeCleanupDb((sql) => {
			if (sql.includes("DELETE FROM schedules")) schedulesSql = sql;
		});

		await runDailyCleanup({ ...env, DB: db });

		expect(schedulesSql).toContain("is_active = 0");
	});

	it("only deletes non-pending actions", async () => {
		let pendingActionsSql = "";
		const db = makeCleanupDb((sql) => {
			if (sql.includes("DELETE FROM pending_actions")) pendingActionsSql = sql;
		});

		await runDailyCleanup({ ...env, DB: db });

		expect(pendingActionsSql).toContain("status != 'pending'");
	});

	it("only deletes non-pending schedule overrides", async () => {
		let overridesSql = "";
		const db = makeCleanupDb((sql) => {
			if (sql.includes("DELETE FROM schedule_overrides")) overridesSql = sql;
		});

		await runDailyCleanup({ ...env, DB: db });

		expect(overridesSql).toContain("'consumed'");
		expect(overridesSql).toContain("'replaced'");
		expect(overridesSql).toContain("'cancelled'");
	});
});
