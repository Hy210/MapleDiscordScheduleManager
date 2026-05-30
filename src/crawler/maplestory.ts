import { MAPLESTORY_UPDATE_PRESET, type CrawlerPreset } from "./presets";

export type MapleStoryUpdatePost = {
	title: string;
	date: string;
	link: string;
};

const MAPLESTORY_LINK_BASE_URL = "https://maplestory.nexon.com";
const CRAWL_FETCH_TIMEOUT_MS = 8000;
const CRAWL_MAX_HTML_CHARS = 500_000;
const CRAWL_MAX_POSTS = 5;

export async function fetchMaplestoryUpdatePosts(
	preset: CrawlerPreset = MAPLESTORY_UPDATE_PRESET,
): Promise<MapleStoryUpdatePost[]> {
	try {
		return await fetchMaplestoryUpdatePostsFromUrl(preset.url);
	} catch (primaryError) {
		if (!preset.fallback_url) {
			throw primaryError;
		}

		try {
			return await fetchMaplestoryUpdatePostsFromUrl(preset.fallback_url);
		} catch (fallbackError) {
			const primaryMessage =
				primaryError instanceof Error ? primaryError.message : String(primaryError);
			const fallbackMessage =
				fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			throw new Error(
				`MapleStory update fetch failed. primary=${primaryMessage}; fallback=${fallbackMessage}`,
			);
		}
	}
}

export async function buildEventKey(
	sourceKey: string,
	post: MapleStoryUpdatePost,
): Promise<string> {
	const raw = `${sourceKey}|${post.link}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(raw),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function fetchMaplestoryUpdatePostsFromUrl(
	url: string,
): Promise<MapleStoryUpdatePost[]> {
	const html = await fetchTextWithTimeout(url, CRAWL_FETCH_TIMEOUT_MS);
	return extractMapleStoryUpdatePosts(html, url).slice(0, CRAWL_MAX_POSTS);
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: {
				"user-agent": "MapleJarvis Discord schedule crawler",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`Crawl fetch failed with HTTP ${response.status}`);
		}

		const html = await response.text();
		return html.slice(0, CRAWL_MAX_HTML_CHARS);
	} finally {
		clearTimeout(timeoutId);
	}
}

function extractMapleStoryUpdatePosts(
	html: string,
	baseUrl: string,
): MapleStoryUpdatePost[] {
	const normalizedHtml = html.replace(/\r?\n/g, " ");
	const posts = new Map<string, MapleStoryUpdatePost>();
	const anchorPattern =
		/<a\b[^>]*href=["']([^"']*(?:\/news\/update|News\/Update)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

	for (const match of normalizedHtml.matchAll(anchorPattern)) {
		const link = normalizeUrl(match[1], baseUrl);
		const anchorHtml = match[2];
		const text = normalizeText(stripHtml(anchorHtml));
		const title = extractPostTitle(text);
		if (!title || isUpdateListNavigation(title)) {
			continue;
		}

		const date = extractPostDate(anchorHtml) ?? extractPostDate(text) ?? "날짜 미상";
		const key = `${title}|${date}|${link}`;
		if (!posts.has(key)) {
			posts.set(key, { title, date, link });
		}
	}

	if (posts.size > 0) {
		return [...posts.values()];
	}

	return extractMapleStoryUpdatePostsFromText(html, baseUrl);
}

function extractMapleStoryUpdatePostsFromText(
	html: string,
	baseUrl: string,
): MapleStoryUpdatePost[] {
	const text = normalizeText(stripHtml(html));
	const fallbackPattern =
		/((?:클라이언트|업데이트|패치)[^0-9]{2,120}?)\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/g;
	const posts: MapleStoryUpdatePost[] = [];
	for (const match of text.matchAll(fallbackPattern)) {
		posts.push({
			title: normalizeText(match[1]),
			date: normalizeDate(match[2]),
			link: normalizeUrl(baseUrl, baseUrl),
		});
		if (posts.length >= CRAWL_MAX_POSTS) {
			break;
		}
	}

	return posts;
}

function stripHtml(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ");
}

function normalizeText(text: string): string {
	return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function extractPostTitle(text: string): string | null {
	const cleaned = text
		.replace(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}.*/g, "")
		.replace(/\b\d{2,}\b/g, "")
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}

function isUpdateListNavigation(title: string): boolean {
	return ["업데이트", "공지사항", "뉴스", "목록"].includes(title);
}

function extractPostDate(input: string): string | null {
	const match = input.match(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/);
	return match ? normalizeDate(match[0]) : null;
}

function normalizeDate(date: string): string {
	const match = date.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
	if (!match) {
		return date;
	}

	return `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`;
}

function normalizeUrl(url: string, baseUrl: string): string {
	try {
		return canonicalizeMaplestoryUpdateUrl(
			new URL(url, MAPLESTORY_LINK_BASE_URL),
		).toString();
	} catch {
		try {
			return canonicalizeMaplestoryUpdateUrl(new URL(url, baseUrl)).toString();
		} catch {
			return url;
		}
	}
}

function canonicalizeMaplestoryUpdateUrl(url: URL): URL {
	if (url.hostname !== "maplestory.nexon.com") {
		return url;
	}

	const match = url.pathname.match(/^\/news\/update\/(\d+)$/i);
	if (!match) {
		return url;
	}

	url.pathname = `/news/update/${match[1]}`;
	return url;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}
