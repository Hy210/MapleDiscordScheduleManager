import { describe, expect, it, vi } from "vitest";
import {
	parseWithLlm,
	shouldUseLlmFallback,
	WORKERS_AI_MODEL,
	type WorkersAiEnv,
} from "../src/llm/adapter";

describe("Workers AI LLM adapter", () => {
	it("does not request LLM fallback when rule parsing already succeeded", () => {
		expect(
			shouldUseLlmFallback({
				isListRequest: false,
				hasRuleBasedCandidate: true,
				isTooShortIntervalRequest: false,
			}),
		).toBe(false);
	});

	it("does not request LLM fallback for system-style list requests", () => {
		expect(
			shouldUseLlmFallback({
				isListRequest: true,
				hasRuleBasedCandidate: false,
				isTooShortIntervalRequest: false,
			}),
		).toBe(false);
	});

	it("returns disabled when the Workers AI binding is missing", async () => {
		await expect(parseWithLlm("보스 잡는 날 알려줘", {}, {})).resolves.toEqual({
			status: "disabled",
		});
	});

	it("uses env.AI.run with the configured Workers AI model", async () => {
		const run = vi.fn(async () => ({
			response: JSON.stringify({
				intent: "create_reminder",
				title: "보스",
				run_at: "2026-04-25T21:30:00+09:00",
				repeat: null,
				timezone: "Asia/Seoul",
				confidence: 0.9,
				needs_confirmation: true,
			}),
		}));
		const env: WorkersAiEnv = { AI: { run } };

		const result = await parseWithLlm("오늘 밤 보스 알려줘", { now: "2026-04-25T10:00:00+09:00" }, env);

		expect(run).toHaveBeenCalledWith(
			WORKERS_AI_MODEL,
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({ role: "user" }),
				]),
			}),
		);
		expect(result).toMatchObject({
			status: "ok",
			value: {
				intent: "create_reminder",
				title: "보스",
				needs_confirmation: true,
			},
		});
	});

	it("returns validator errors instead of accepting unsafe LLM output", async () => {
		const env: WorkersAiEnv = {
			AI: {
				run: vi.fn(async () => ({
					response: JSON.stringify({
						intent: "create_reminder",
						title: "보스",
						run_at: "2026-04-25T21:30:00+09:00",
						repeat: null,
						confidence: 0.4,
					}),
				})),
			},
		};

		await expect(
			parseWithLlm("애매한 알림", { now: "2026-04-25T10:00:00+09:00" }, env),
		).resolves.toMatchObject({
			status: "invalid",
			reason: "low_confidence",
		});
	});

	it("rejects non-JSON Workers AI responses safely", async () => {
		const env: WorkersAiEnv = {
			AI: {
				run: vi.fn(async () => ({ response: "일정 등록하면 될 것 같아요." })),
			},
		};

		await expect(parseWithLlm("보스 알려줘", {}, env)).resolves.toMatchObject({
			status: "invalid",
			reason: "invalid_llm_json",
		});
	});
});
