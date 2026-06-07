# 다비도 내전사이트 — Claude 작업 컨텍스트

## 프로젝트 실행
```
node server.js   # http://localhost:3000
```

## 파일 구조
| 파일 | 역할 |
|---|---|
| `server.js` | Express + WebSocket 서버 (API, 치지직 봇, 룰렛 로직) |
| `public/index.html` | **실제 내전사이트** (상단 탭 레이아웃) — 항상 이 파일 수정 |
| `public/roulette-overlay.html` | OBS 브라우저 소스용 룰렛 오버레이 |
| `public/inhouse.html` | 구버전 (사이드바 방식) — 사용 안 함 |

> `inhouse.html`은 구버전. 실제 사이트는 반드시 `index.html` 수정.

---

## 룰렛 시스템 현황 (2026-06-07 완료)

### OBS 오버레이 (`public/roulette-overlay.html`)
- **스핀 시간**: 2000ms 고정 (ease-out quartic)
- **슬롯**: 140px 높이, 상하 페이드, 가운데 1칸만 선명
- **스핀 중**: 크로마틱 어베레이션 효과 (`.drum-list.spinning` 클래스)
- **당첨 시**: 화면 플래시 + 스테이지 흔들기 (Web Animations API) + 파티클 버스트 160개
- **결과**: scale 바운스 팝인 → 1초 후 오버레이 자동 소멸
- **테스트**: `localhost:3000/roulette-overlay.html?test`

**⚠️ 흔들기 버그 주의**: shake에 CSS 클래스 쓰면 `stageIn` 애니메이션이 재실행돼 깜빡임 발생.
반드시 `stage.animate()` (Web Animations API, `composite:'add'`) 사용.

### 치지직 도네이션 자동 연동 (`server.js`)
- **cmd 93102** = 치즈 도네이션 이벤트 (`CHZZK_CMD.DONATION = 93102`)
- `handleDonation()` 함수: `chat.extras` JSON에서 `payAmount`, `payType` 파싱
- **조건**: `payType === 'CHEESE'` + `payAmount % 1500 === 0`인 경우만 실행
- **다연차**: 3000치즈=2회, 4500치즈=3회 (2000ms 간격으로 순차 broadcast)
- **로그 확인**:
  - `[DONATION] 닉네임 CHEESE 1500 치즈` → 정상 수신
  - `[DONATION] 스킵: 500치즈는 1500의 배수 아님` → 조건 미충족 스킵
  - 아무것도 안 찍히면 → chzzk가 93102 대신 다른 cmd 코드 사용 중 (디버깅 필요)

### 관리자 미리보기 (`public/index.html` 내부)
- 관리자 탭 → 룰렛 서브탭에 오버레이와 동일한 네온 드럼 내장
- `testAdminRoulette()` — 다연차 지원 (`data.entries` 배열 순서대로 재생)
- 스핀 시간: 2000ms (`arDrumSpin` duration = 2000)

### WebSocket 메시지 구조
```js
// 서버 → 클라이언트 (룰렛 실행)
{ type: 'roulette_admin_result', result: entry, config: saved }

// entry 구조
{
  id, nickname, amount, result, storageReward,
  source,           // 'chzzk_donation' | 'manual_test'
  createdAt,
  spinIndex,        // 다연차일 때만 (1부터 시작)
  spinTotal,        // 다연차일 때만
}
```

### 룰렛 당첨 → 보관함 자동 지급 + 실시간 갱신 (2026-06-07)
- `server.js`의 `grantStorageReward()`: 당첨 항목에 `storageReward`가 있으면 보관함봇 `/api/bot-command`에
  `{ command:'추가', options:{ 닉네임, 보상이름, 개수:1 } }` 자동 호출 → 성공 시 `{ type:'storage_update' }` broadcast
- `runRouletteSpin()` / `handleDonation()` 양쪽 스핀 루프에서 항목 생성 직후 호출 (fire-and-forget)
- `index.html`의 WS 핸들러에 `storage_update` 케이스 추가 → `refreshStorageLive()`가 보관함 탭 열려있으면
  `/api/bot-config` 재조회 후 선택된 유저 화면까지 다시 렌더링

### 보관함봇(`roulette_bot/bot.py`, 별도 레포·배포) — 신규 유저 자동 등록
- **위치**: `C:\Users\홍수호\OneDrive\Desktop\roulette_bot` (origin: github.com/tngh1562-gif/roulette_bot)
- 기존엔 `/유저추가`로 `스레드id`를 수동 입력해야만 보관함 유저가 생성됐음 → 처음 룰렛 당첨된 사람은
  `config.users`에 없어서 `'추가'` 호출이 실패하고 디스코드 포스트도 안 만들어지는 문제가 있었음
- **해결**: `create_user_post()` 추가 — `FORUM_CHANNEL_ID` 포럼 채널에 새 스레드+임베드를 자동 생성하고
  `config.users`에 등록. `handle_bot_command_api`의 `"추가"` 분기에서 유저가 없으면 이 함수로 먼저
  자동 등록한 뒤 보상을 지급하도록 수정 (`bot.py:533` 부근)
- ⚠️ **이 변경은 `davido-inhouse`와 별도 레포/배포**이므로, 적용하려면 `roulette_bot`도 커밋·푸시 후
  봇을 재시작(재배포)해야 실제로 동작함

---

## 미완료 / 다음에 할 것
- [ ] 실제 치즈 도네이션으로 cmd 93102 수신 여부 검증
      → 콘솔에 `[DONATION]` 로그 확인, 없으면 cmd 코드 디버깅
- [ ] `roulette_bot` 변경사항 커밋·푸시 후 봇 재배포 (그래야 신규 유저 자동 등록이 실제로 작동함)
- [ ] 포럼 채널(`FORUM_CHANNEL_ID`)에 새 스레드를 만들 디스코드 권한이 봇에게 있는지 확인
