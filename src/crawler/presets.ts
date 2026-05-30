export type CrawlerPreset = {
	source_id: string;
	source_key: string;
	label: string;
	url: string;
	fallback_url: string;
	defaultIntervalMinutes: number;
	keywords: string[];
};

export const MAPLESTORY_UPDATE_PRESET = {
	source_id: "maplestory_update",
	source_key: "source:maplestory_update",
	label: "메이플스토리 업데이트",
	url: "https://m.maplestory.nexon.com/news/update",
	fallback_url: "https://maplestory.nexon.com/news/update",
	defaultIntervalMinutes: 10,
	keywords: ["업데이트", "클라이언트", "패치"],
} satisfies CrawlerPreset;

export const CRAWLER_PRESETS = [MAPLESTORY_UPDATE_PRESET] as const;
