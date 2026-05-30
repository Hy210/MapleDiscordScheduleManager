import { validateLlmIntent } from "./validator";
import type { NormalizedLlmIntent } from "./schema";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

type WorkersAiMessage = {
	role: "system" | "user";
	content: string;
};

type WorkersAiRunInput = {
	messages: WorkersAiMessage[];
	max_tokens: number;
	temperature: number;
};

export type WorkersAiBinding = {
	run(model: string, input: WorkersAiRunInput): Promise<unknown>;
};

export type WorkersAiEnv = {
	// TODO: Run `npm run cf-typegen` after deploying the AI binding and replace this
	// minimal shape with the generated Workers AI binding type when available.
	AI?: WorkersAiBinding;
};

export type LlmParseResult =
	| { status: "ok"; value: NormalizedLlmIntent }
	| { status: "invalid"; reason: string; userMessage: string }
	| { status: "disabled" };

export function shouldUseLlmFallback(input: {
	isListRequest: boolean;
	hasRuleBasedCandidate: boolean;
	isTooShortIntervalRequest: boolean;
}): boolean {
	return (
		!input.isListRequest &&
		!input.hasRuleBasedCandidate &&
		!input.isTooShortIntervalRequest
	);
}

export async function parseWithLlm(
	input: string,
	context: { now?: Date | string } = {},
	env: WorkersAiEnv,
): Promise<LlmParseResult> {
	if (!env.AI) {
		return { status: "disabled" };
	}

	try {
		const aiResult = await env.AI.run(WORKERS_AI_MODEL, {
			messages: [
				{
					role: "system",
					content: buildSystemPrompt(),
				},
				{
					role: "user",
					content: JSON.stringify({
						input,
						now: normalizeNowText(context.now),
						timezone: "Asia/Seoul",
					}),
				},
			],
			max_tokens: 512,
			temperature: 0.1,
		});
		const text = extractWorkersAiText(aiResult);
		if (!text) {
			return {
				status: "invalid",
				reason: "empty_llm_response",
				userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
			};
		}

		const raw = parseJsonObject(text);
		if (!raw) {
			return {
				status: "invalid",
				reason: "invalid_llm_json",
				userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
			};
		}

		const validation = validateLlmIntent(raw, context);
		if (!validation.ok) {
			return {
				status: "invalid",
				reason: validation.reason,
				userMessage: validation.userMessage,
			};
		}

		return { status: "ok", value: validation.value };
	} catch (error) {
		console.warn("Workers AI LLM fallback failed", error);
		return {
			status: "invalid",
			reason: "workers_ai_failed",
			userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
		};
	}
}

function buildSystemPrompt(): string {
	return [
		"You convert Korean Discord schedule commands into one JSON object only.",
		"Return no markdown, no code fences, no explanation.",
		"Allowed intents are create_reminder and create_crawl_schedule only.",
		"Timezone must be Asia/Seoul.",
		"needs_confirmation must be true.",
		"Do not invent URLs. User URL crawling is not supported.",
		"For MapleStory update detection, use source_id maplestory_update only.",
		"For reminders, output title, run_at, repeat, timezone, confidence, needs_confirmation.",
		"For one-time reminders, run_at must be an ISO string with +09:00 offset and repeat must be null.",
		"For repeat reminders, repeat may be daily, weekly, or interval.",
		"Repeat examples: {\"type\":\"daily\",\"time\":\"09:30\"}, {\"type\":\"weekly\",\"day_of_week\":\"monday\",\"time\":\"21:30\"}, {\"type\":\"interval\",\"minutes\":30}.",
		"For crawl schedules, output source_id, title, interval_minutes, timezone, confidence, needs_confirmation.",
		"If the user asks to list, delete, update, chat, or asks something unsupported, use an unsupported intent such as unknown.",
	].join("\n");
}

function extractWorkersAiText(result: unknown): string | null {
	if (typeof result === "string") {
		return result;
	}

	if (!isObject(result)) {
		return null;
	}

	for (const key of ["response", "text", "result", "output"]) {
		const value = result[key];
		if (typeof value === "string") {
			return value;
		}
	}

	const choices = result.choices;
	if (Array.isArray(choices)) {
		const first = choices[0];
		if (isObject(first)) {
			if (typeof first.text === "string") {
				return first.text;
			}
			if (isObject(first.message) && typeof first.message.content === "string") {
				return first.message.content;
			}
		}
	}

	return null;
}

function parseJsonObject(text: string): unknown | null {
	const trimmed = text.trim();
	const direct = tryParseJson(trimmed);
	if (direct) {
		return direct;
	}

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced) {
		const parsed = tryParseJson(fenced[1].trim());
		if (parsed) {
			return parsed;
		}
	}

	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return tryParseJson(trimmed.slice(start, end + 1));
	}

	return null;
}

function tryParseJson(text: string): unknown | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function normalizeNowText(now: Date | string | undefined): string {
	if (now instanceof Date) {
		return now.toISOString();
	}

	return now ?? new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
