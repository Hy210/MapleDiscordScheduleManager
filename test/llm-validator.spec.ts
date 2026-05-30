import { describe, expect, it } from "vitest";
import { validateLlmIntent } from "../src/llm/validator";

const NOW = "2026-04-25T10:00:00+09:00";

describe("LLM intent validator", () => {
	it("accepts a valid one-time reminder", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				run_at: "2026-04-25T21:30:00+09:00",
				repeat: null,
				timezone: "Asia/Seoul",
				confidence: 0.91,
				needs_confirmation: false,
			},
			{ now: NOW },
		);

		expect(result).toEqual({
			ok: true,
			value: {
				intent: "create_reminder",
				title: "보스",
				run_at: "2026-04-25T21:30:00+09:00",
				repeat_rule: null,
				timezone: "Asia/Seoul",
				needs_confirmation: true,
				confidence: 0.91,
			},
		});
	});

	it("rejects past one-time reminders", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				run_at: "2026-04-25T09:30:00+09:00",
				repeat: null,
				timezone: "Asia/Seoul",
				confidence: 0.91,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({ ok: false, reason: "past_run_at" });
	});

	it("accepts a valid weekly repeat", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				repeat: {
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				},
				timezone: "Asia/Seoul",
				confidence: 0.9,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({
			ok: true,
			value: {
				intent: "create_reminder",
				run_at: null,
				repeat_rule: {
					type: "weekly",
					day_of_week: "monday",
					time: "21:30",
				},
				needs_confirmation: true,
			},
		});
	});

	it("rejects an invalid weekly day_of_week", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				repeat: {
					type: "weekly",
					day_of_week: "월요일",
					time: "21:30",
				},
				confidence: 0.9,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({ ok: false, reason: "invalid_weekly_day" });
	});

	it("rejects interval repeats shorter than five minutes", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "물약",
				repeat: { type: "interval", minutes: 3 },
				confidence: 0.9,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({ ok: false, reason: "interval_too_short" });
	});

	it("accepts interval repeats from five minutes", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "물약",
				repeat: { type: "interval", minutes: 5 },
				confidence: 0.9,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({
			ok: true,
			value: {
				run_at: null,
				repeat_rule: { type: "interval", minutes: 5 },
			},
		});
	});

	it("rejects HH:mm values outside the valid range", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				repeat: { type: "daily", time: "24:00" },
				confidence: 0.9,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({ ok: false, reason: "invalid_daily_time" });
	});

	it("rejects low confidence results", () => {
		const result = validateLlmIntent(
			{
				intent: "create_reminder",
				title: "보스",
				run_at: "2026-04-25T21:30:00+09:00",
				repeat: null,
				confidence: 0.4,
			},
			{ now: NOW },
		);

		expect(result).toMatchObject({ ok: false, reason: "low_confidence" });
	});

	it("accepts the MapleStory crawl schedule preset", () => {
		const result = validateLlmIntent({
			intent: "create_crawl_schedule",
			source_id: "maplestory_update",
			title: "메이플스토리 업데이트 감지",
			interval_minutes: 10,
			confidence: 0.88,
			needs_confirmation: false,
		});

		expect(result).toEqual({
			ok: true,
			value: {
				intent: "create_crawl_schedule",
				source_id: "maplestory_update",
				title: "메이플스토리 업데이트 감지",
				target_url: "https://m.maplestory.nexon.com/news/update",
				interval_minutes: 10,
				keywords: ["업데이트", "클라이언트", "패치"],
				timezone: "Asia/Seoul",
				needs_confirmation: true,
				confidence: 0.88,
			},
		});
	});

	it("rejects unknown crawl schedule sources", () => {
		const result = validateLlmIntent({
			intent: "create_crawl_schedule",
			source_id: "unknown_site",
			confidence: 0.9,
		});

		expect(result).toMatchObject({ ok: false, reason: "unsupported_crawl_source" });
	});

	it("ignores LLM-provided target_url and uses the preset URL", () => {
		const result = validateLlmIntent({
			intent: "create_crawl_schedule",
			source_id: "maplestory_update",
			target_url: "https://example.com/user-provided",
			confidence: 0.9,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				target_url: "https://m.maplestory.nexon.com/news/update",
				interval_minutes: 10,
			},
		});
	});
});
