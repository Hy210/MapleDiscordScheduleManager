export type MatchedSpan = {
	text: string;
	type: "date" | "time" | "repeat" | "request";
};

const DEFAULT_REMINDER_TITLE = "알림";
const MAX_REMINDER_TITLE_LENGTH = 80;

const REQUEST_SUFFIX_PATTERNS = [
	/\s*(?:알려줘|알림줘|알람줘|말해줘|등록해줘|예약해줘|리마인드해줘|기억해줘|확인해줘)\s*$/u,
	/\s*해줘\s*$/u,
];

const FALLBACK_REMOVE_PATTERNS: Array<{ pattern: RegExp; type: MatchedSpan["type"] }> = [
	{ pattern: /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/gu, type: "date" },
	{ pattern: /\d{4}[/-]\d{1,2}[/-]\d{1,2}/gu, type: "date" },
	{ pattern: /\d{1,2}\s*월\s*\d{1,2}\s*일/gu, type: "date" },
	{ pattern: /\d{1,2}\/\d{1,2}/gu, type: "date" },
	{ pattern: /(?:돌아오는|다가오는)\s*(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)/gu, type: "date" },
	{ pattern: /(?:다음|이번)\s*주\s*(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)?/gu, type: "date" },
	{ pattern: /(?:오늘|내일|모레)/gu, type: "date" },
	{ pattern: /매주\s*(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)/gu, type: "repeat" },
	{ pattern: /매일/gu, type: "repeat" },
	{ pattern: /\d+\s*분마다/gu, type: "repeat" },
	{ pattern: /\d+\s*시간마다/gu, type: "repeat" },
	{ pattern: /(?:(?:오전|오후|아침|저녁|밤|새벽)\s*)?\d{1,2}\s*시\s*(?:\d{1,2}\s*분?)?/gu, type: "time" },
	{ pattern: /\d{1,2}:\d{2}/gu, type: "time" },
	{ pattern: /(?:아침|저녁|밤|새벽)\s*(?:쯤|에)?/gu, type: "time" },
];

export function extractReminderTitle(input: string, matchedSpans: MatchedSpan[] = []): string {
	let title = input;

	for (const span of matchedSpans) {
		title = removeLiteral(title, span.text);
	}

	for (const { pattern } of FALLBACK_REMOVE_PATTERNS) {
		title = title.replace(pattern, " ");
	}

	title = normalizeSpacing(title);
	title = removeRequestSuffix(title);
	title = normalizeInvitationSuffix(title);
	title = removeLeadingParticles(title);
	title = removeTrailingParticles(title);
	title = normalizeSpacing(title);

	return normalizeReminderTitle(title);
}

export function normalizeReminderTitle(
	title: string,
	fallback = DEFAULT_REMINDER_TITLE,
): string {
	const normalized = normalizeSpacing(title);
	if (!normalized || isOnlyReminderNoise(normalized)) {
		return fallback;
	}

	return [...normalized].slice(0, MAX_REMINDER_TITLE_LENGTH).join("");
}

function removeLiteral(input: string, text: string): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return input;
	}

	return input.replaceAll(trimmed, " ");
}

function removeRequestSuffix(input: string): string {
	let result = input;
	let changed = true;
	while (changed) {
		changed = false;
		for (const pattern of REQUEST_SUFFIX_PATTERNS) {
			const next = result.replace(pattern, "");
			if (next !== result) {
				result = next;
				changed = true;
			}
		}
	}
	return result;
}

function normalizeInvitationSuffix(input: string): string {
	return input.replace(/\s*(가자|하자|돌자)고\s*$/u, "$1");
}

function removeTrailingParticles(input: string): string {
	return input
		.replace(/\s*(?:에|에는|으로|로|을|를|은|는|이|가|좀|같이|우리|나한테)\s*$/u, "")
		.replace(/\s*(?:때|쯤)\s*$/u, "");
}

function removeLeadingParticles(input: string): string {
	return input.replace(/^(?:에|에는|으로|로|을|를|은|는|이|가|좀|같이|우리|나한테)\s+/u, "");
}

function normalizeSpacing(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function isOnlyReminderNoise(input: string): boolean {
	const compact = input.replace(/\s+/g, "");
	return /^(?:알림|알람|일정|리마인드|등록|예약|확인|해줘|알려줘)+$/u.test(compact);
}
