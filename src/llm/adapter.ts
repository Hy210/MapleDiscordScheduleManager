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

export type LlmOverrideParseResult =
	| { status: "ok"; run_at: string; title: string | null }
	| { status: "invalid"; userMessage: string }
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
		"For editing an existing reminder, use update_reminder.",
		"Timezone must be Asia/Seoul.",
		"needs_confirmation must be true.",
		"Do not invent URLs. User URL crawling is not supported.",
		"For MapleStory update detection, use source_id maplestory_update only.",
		"For reminders, output title, run_at, repeat, timezone, confidence, needs_confirmation.",
		"For one-time reminders, run_at must be an ISO string with +09:00 offset and repeat must be null.",
		"For repeat reminders, repeat may be daily, weekly, or interval.",
		"Repeat examples: {\"type\":\"daily\",\"time\":\"09:30\"}, {\"type\":\"weekly\",\"day_of_week\":\"monday\",\"time\":\"21:30\"}, {\"type\":\"interval\",\"minutes\":30}.",
		"For crawl schedules, output source_id, title, interval_minutes, timezone, confidence, needs_confirmation.",
		"For update_reminder, output only changed fields among title, run_at, repeat, clear_repeat, timezone, confidence, needs_confirmation.",
		"If the user asks to list, delete, chat, or asks something unsupported, use an unsupported intent such as unknown.",
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

const MIN_OVERRIDE_CONFIDENCE = 0.65;

export async function parseWithLlmForOverride(
	input: string,
	context: { now?: Date | string },
	env: WorkersAiEnv,
): Promise<LlmOverrideParseResult> {
	if (!env.AI) {
		return { status: "disabled" };
	}

	try {
		const aiResult = await env.AI.run(WORKERS_AI_MODEL, {
			messages: [
				{
					role: "system",
					content: buildOverrideSystemPrompt(),
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
			max_tokens: 256,
			temperature: 0.1,
		});

		const text = extractWorkersAiText(aiResult);
		if (!text) {
			return {
				status: "invalid",
				userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
			};
		}

		const raw = parseJsonObject(text);
		if (!raw) {
			return {
				status: "invalid",
				userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
			};
		}

		const confidence = typeof raw.confidence === "number" ? raw.confidence : 1;
		if (confidence < MIN_OVERRIDE_CONFIDENCE) {
			return {
				status: "invalid",
				userMessage: "요청을 정확히 이해하지 못했어요. 날짜와 시간을 구체적으로 입력해 주세요.",
			};
		}

		if (typeof raw.run_at !== "string" || !raw.run_at.trim()) {
			return {
				status: "invalid",
				userMessage: "변경할 시간을 정확히 이해하지 못했어요. 예: 목요일 오후 9시 30분",
			};
		}

		const parsed = new Date(raw.run_at);
		if (Number.isNaN(parsed.getTime())) {
			return {
				status: "invalid",
				userMessage: "변경할 시간을 정확히 이해하지 못했어요. 예: 목요일 오후 9시 30분",
			};
		}

		const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
		if (parsed.getTime() <= now.getTime()) {
			return {
				status: "invalid",
				userMessage: "이번만 변경할 시간이 과거가 됩니다.",
			};
		}

		const title =
			raw.title === null || raw.title === undefined
				? null
				: typeof raw.title === "string" && raw.title.trim()
					? raw.title.trim()
					: null;

		return { status: "ok", run_at: raw.run_at, title };
	} catch (error) {
		console.warn("Workers AI LLM override fallback failed", error);
		return {
			status: "invalid",
			userMessage: "요청을 정확히 이해하지 못했어요. 조금 더 구체적으로 입력해 주세요.",
		};
	}
}

function buildOverrideSystemPrompt(): string {
	return [
		"You extract a one-time override datetime (and optionally a new title) from a Korean Discord message.",
		"The user wants to change a repeating reminder just this once.",
		"Return ONLY a JSON object with no markdown, no code fences, no explanation.",
		"Output format: { \"run_at\": \"<ISO 8601 with +09:00 offset>\", \"title\": <string or null>, \"confidence\": <0 to 1> }",
		"run_at must be a specific future datetime in Asia/Seoul timezone (+09:00 offset). It must never be null.",
		"If the input mentions only a weekday (e.g. 목요일), interpret it as the next upcoming occurrence of that weekday from now.",
		"If the input mentions 내일 (tomorrow) or 모레 (day after tomorrow), compute the date relative to now.",
		"title should be the new reminder title if explicitly mentioned, otherwise null.",
		"If you cannot determine a specific future datetime with confidence >= 0.65, set confidence below 0.65.",
	].join("\n");
}
