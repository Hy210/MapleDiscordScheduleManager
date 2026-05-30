import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envPath = resolve(projectRoot, ".env");

const requiredEnvKeys = [
	"DISCORD_APPLICATION_ID",
	"DISCORD_BOT_TOKEN",
	"DISCORD_GUILD_ID",
];

const envFileValues = loadEnvFile(envPath);
const env = Object.fromEntries(
	requiredEnvKeys.map((key) => [key, process.env[key] || envFileValues[key] || ""]),
);

const missingKeys = requiredEnvKeys.filter((key) => !env[key]);
if (missingKeys.length > 0) {
	console.error(`Missing required environment variables: ${missingKeys.join(", ")}`);
	console.error(`Set them in ${envPath} or export them before running this script.`);
	process.exit(1);
}

const command = {
	name: "알림",
	description: "자연어로 일정 또는 알림 요청을 등록합니다.",
	options: [
		{
			name: "내용",
			description: "예: 내일 오전 9시에 회의 알려줘",
			type: 3,
			required: true,
		},
	],
};

const url = `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;

const response = await fetch(url, {
	method: "POST",
	headers: {
		authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
		"content-type": "application/json",
	},
	body: JSON.stringify(command),
});

const responseText = await response.text();
let responseBody;
try {
	responseBody = JSON.parse(responseText);
} catch {
	responseBody = responseText;
}

if (!response.ok) {
	console.error(`Failed to register slash command. HTTP ${response.status}`);
	console.error(responseBody);
	process.exit(1);
}

console.log("Registered slash command:");
console.log(`- id: ${responseBody.id}`);
console.log(`- name: /${responseBody.name}`);
console.log(`- description: ${responseBody.description}`);

function loadEnvFile(path) {
	if (!existsSync(path)) {
		return {};
	}

	const values = {};
	const lines = readFileSync(path, "utf8").split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const separatorIndex = trimmed.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1).trim();
		values[key] = unquote(rawValue);
	}

	return values;
}

function unquote(value) {
	const first = value.at(0);
	const last = value.at(-1);
	if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}

	return value;
}
