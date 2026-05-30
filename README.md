# Discord Schedule Bot

Cloudflare Workers, D1, Cron Trigger로 동작하는 Discord 일정 알림 봇입니다.
사용자가 Discord slash command로 알림을 등록하면 정해진 시간에 채널로 알림을 보내고, 모든 reminder 알림에는 메이플스토리 공식 업데이트 확인을 자동으로 함께 수행합니다.

## 주요 기능

- `/알림` slash command 기반 일정 등록
- 등록 전 `[등록]`, `[취소]` 버튼 확인
- 1회성, 매일, 매주, N분마다, N시간마다 반복 알림
- N분마다 반복 알림 최소 5분 제한
- 일정 목록 조회와 삭제 전 재확인
- `pending_actions`를 통한 등록 후보 저장
- `schedule_changes`를 통한 등록/삭제 이력 저장
- Cloudflare Cron 기반 알림 발송
- 알림용 Discord Role mention
- 알림 메시지의 `[확인했어요]` 버튼
- `alerts`, `alert_reads` 기반 확인자 추적
- 원본 알림 메시지 하단에 확인한 사람 목록 표시
- 메이플스토리 업데이트 고정 preset 크롤링
- reminder 알림마다 메이플스토리 신규 업데이트 자동 확인
- `detected_events` 기반 메이플 업데이트 중복 알림 방지
- Cron 1회 실행 안에서 메이플 업데이트 fetch 결과 캐시
- 규칙 기반 파서 실패 시 Cloudflare Workers AI 기반 LLM fallback
- LLM 결과 서버 검증 후에만 등록 후보/pending_actions 흐름으로 연결

## 사용 명령어 예시

Discord에서 `/알림` 명령어의 `내용` 옵션에 자연어 문장을 입력합니다.

```text
내일 오후 9시에 보스 알려줘
오늘 오후 9시 30분에 테스트 알려줘
매일 오전 9시에 출석 알려줘
매주 월요일 오후 9시 30분에 보스 알려줘
30분마다 물약 확인 알려줘
2시간마다 휴식 알려줘
알림 목록
등록된 알림 보여줘
메이플 패치 올라오면 알려줘
메이플 업데이트 감지 켜줘
```

등록 후보 메시지는 채널 전체에 공개되고, `[등록]` 버튼을 누르면 실제 일정으로 저장됩니다.

## 필요한 Cloudflare Secrets

운영 Worker에는 Wrangler secret으로 아래 값을 설정합니다. 실제 값은 저장소에 커밋하지 마세요.

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_NOTIFY_ROLE_ID
```

- `DISCORD_PUBLIC_KEY`: Discord Developer Portal의 application public key
- `DISCORD_BOT_TOKEN`: Discord Bot token
- `DISCORD_NOTIFY_ROLE_ID`: Cron 알림에서 mention할 Discord Role ID

LLM fallback은 Cloudflare Workers AI binding `AI`를 사용합니다. `OPENAI_API_KEY`는 필요하지 않으며 기본 운영 secret으로 요구하지 않습니다.

slash command 등록 스크립트는 로컬 `.env` 또는 환경변수에서 아래 값을 사용합니다.

```text
DISCORD_APPLICATION_ID
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
DISCORD_NOTIFY_ROLE_ID
```

## Wrangler Login

Cloudflare 계정에 로그인합니다.

```bash
npx wrangler login
```

로그인 상태 확인:

```bash
npx wrangler whoami
```

## D1 Database 생성 및 Migration 적용

새 환경에서 D1 database를 처음 만든다면:

```bash
npx wrangler d1 create discord-schedule-db
```

생성 후 출력되는 `database_id`를 `wrangler.jsonc`의 `d1_databases` 항목에 반영합니다. binding 이름은 코드 기준으로 `DB`를 사용합니다.

로컬 D1 migration:

```bash
npx wrangler d1 migrations apply discord-schedule-db --local
```

운영 D1 migration:

```bash
npx wrangler d1 migrations apply discord-schedule-db --remote
```

현재 migration:

- `migrations/0001_init.sql`: schedules, schedule_changes, alerts, alert_reads, detected_events 등 기본 테이블
- `migrations/0002_pending_actions.sql`: pending_actions 테이블

## Workers AI Binding

`wrangler.jsonc`에 Workers AI binding이 설정되어 있습니다.

```json
"ai": {
  "binding": "AI"
}
```

코드에서는 `env.AI.run()`을 통해 Workers AI를 호출합니다. AI binding이 없으면 LLM fallback은 비활성화되고 기존 규칙 기반 파싱 실패 안내가 반환됩니다.

Wrangler 설정을 바꾼 뒤 타입을 갱신합니다.

```bash
npm run cf-typegen
```

## Discord App 설정

Discord Developer Portal에서 application과 bot을 준비합니다.

1. Application 생성
2. Bot 생성 및 token 발급
3. `PUBLIC KEY` 확인 후 `DISCORD_PUBLIC_KEY` secret으로 설정
4. OAuth2 URL Generator에서 `bot`, `applications.commands` scope 선택
5. Bot permissions는 메시지 전송과 slash command 사용에 필요한 권한을 부여
6. 생성된 OAuth2 URL로 서버에 bot 초대
7. Interactions Endpoint URL에 배포된 Worker URL을 설정

예:

```text
https://<worker-domain>/interactions
```

## Slash Command 등록

로컬 `.env`를 준비한 뒤 guild command를 등록합니다.

```bash
npm run register-command
```

등록 스크립트는 `scripts/register-command.mjs`를 사용합니다. 빠른 확인을 위해 guild command 방식으로 등록하며, 필요한 값은 `.env.example`을 참고해 로컬 `.env`에만 넣습니다.

## Deploy

```bash
npm run deploy
```

또는:

```bash
npx wrangler deploy
```

## Cron 설정

`wrangler.jsonc`에 Cron Trigger가 설정되어 있습니다.

```json
"triggers": {
  "crons": ["* * * * *"]
}
```

Cron은 due 상태의 `schedules`를 조회해 reminder와 crawl schedule을 처리합니다. reminder 알림 처리 중 메이플스토리 업데이트 확인도 자동으로 실행됩니다.

## 사전 알림 정책

- 일정 등록 시 기본으로 사전 알림이 자동 생성됩니다.
- 사전 알림 기준은 `src/config/reminder.ts`의 `PRE_REMINDER_OFFSET_MINUTES` 상수로 관리합니다.
- 기본값은 30분입니다.
- `N분마다`, `N시간마다` 같은 interval 반복 일정은 사전 알림 생성 대상에서 제외됩니다.
- 사전 알림도 일반 알림처럼 메이플 업데이트 자동 확인과 `[확인했어요]` 버튼이 동작합니다.
- 사전 알림 시간이 전날로 넘어가는 경우 실제 전날에 알림이 옵니다.

## 로컬 개발

의존성 설치:

```bash
npm install
```

로컬 개발 서버:

```bash
npm run dev
```

타입 검사:

```bash
npx tsc --noEmit
```

테스트:

```bash
npm test
```

Cloudflare 타입 갱신:

```bash
npm run cf-typegen
```

## 테스트 시나리오

기본 동작:

```text
/알림 내일 오후 9시에 보스 알려줘
```

확인할 것:

- 등록 후보 메시지가 채널 전체에 공개되는지
- `[등록]` 클릭 후 등록 완료 메시지가 채널 전체에 공개되는지
- D1 `schedules`에 reminder가 저장되는지
- Cron 실행 시 Discord 알림이 발송되는지
- 알림 메시지에 `[확인했어요]` 버튼이 있는지
- 버튼 클릭 시 `alert_reads`에 저장되는지
- 원본 메시지의 `[확인 현황]`에 확인자가 표시되는지
- 같은 사용자가 다시 눌러도 확인자 목록에 중복 표시되지 않는지
- 원본 메시지 수정 시 Role mention, user mention이 다시 ping되지 않는지

목록/삭제:

```text
/알림 알림 목록
/알림 등록된 알림 보여줘
```

확인할 것:

- 목록 응답이 채널 전체에 공개되는지
- 등록자 `<@user_id>`가 표시되지만 user ping은 울리지 않는지
- 삭제 버튼 클릭 시 재확인 메시지는 버튼을 누른 사람에게만 보이는지
- 삭제 완료 메시지는 채널 전체에 공개되는지

메이플 업데이트:

```text
/알림 메이플 패치 올라오면 알려줘
```

확인할 것:

- URL 입력 없이 고정 preset으로 등록 후보가 생성되는지
- `detected_events.schedule_id`에 `source:maplestory_update`가 저장되는지
- 같은 메이플 업데이트 게시글이 여러 reminder에서 중복 표시되지 않는지

반복 알림:

```text
/알림 3분마다 테스트 알려줘
/알림 5분마다 테스트 알려줘
```

확인할 것:

- 5분 미만 N분 반복은 등록 후보를 만들지 않고 안내 메시지를 반환하는지
- 5분 이상은 등록 가능한지

## 운영 시 주의사항

- 사용자 URL 크롤링은 지원하지 않습니다.
- 메이플스토리 업데이트는 코드의 고정 preset만 사용합니다.
- LLM fallback도 사용자 URL을 신뢰하지 않습니다. 메이플 업데이트 감지는 항상 고정 preset URL로 정규화됩니다.
- LLM 결과는 바로 DB에 저장하지 않고 `validateLlmIntent()` 서버 검증을 통과한 뒤 기존 등록 후보와 확인 버튼 흐름으로만 이어집니다.
- OpenAI API Key 기반 구현을 기본값으로 사용하지 않습니다. LLM provider는 Cloudflare Workers AI입니다.
- preset 위치: `src/crawler/presets.ts`
- 초기 대상 URL: `https://m.maplestory.nexon.com/news/update`
- fallback URL: `https://maplestory.nexon.com/news/update`
- `detected_events.schedule_id`에는 개별 reminder id가 아니라 `source:maplestory_update` source key를 저장해 중복 알림을 방지합니다.
- Role mention은 실제 알림용입니다.
- 등록자나 확인자 `<@user_id>` 표시는 정보 표시용이며, interaction 응답과 메시지 수정에서는 user ping을 막습니다.
- `[확인했어요]` 버튼은 확인한 사람만 추적합니다. 전체 확인 대상자 목록은 관리하지 않습니다.
- Discord 원본 메시지 수정 시 `allowed_mentions`는 `parse`, `users`, `roles`를 모두 비워 재알림을 방지합니다.
- 운영 노출 위험을 줄이기 위해 `/db-test`, `/maple-test`, `/cron-test` 같은 개발용 endpoint는 제거되어 있습니다.
- `/health`는 상태 확인용으로 유지합니다.
- 실제 secret, token, guild id, role id는 README나 `.env.example`에 넣지 마세요.
