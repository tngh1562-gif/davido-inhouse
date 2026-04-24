# 다비도의 내전 — 투표/룰렛

치지직 채팅 연동 실시간 투표 + 룰렛

## 기능
- 📊 채팅 투표 — 시청자가 `!투표1`, `!투표2`로 투표
- 🎡 룰렛 — 가중치 설정, 투표 결과 룰렛으로 변환
- 실시간 반영 (SSE)

## 로컬 실행

```bash
npm install
npm run dev
```
→ http://localhost:3000

## Railway 배포 (무료, WebSocket/SSE 지원)

1. **GitHub에 올리기**
   ```bash
   git init
   git add .
   git commit -m "first commit"
   git remote add origin https://github.com/아이디/레포명.git
   git push -u origin main
   ```

2. **Railway 배포**
   - https://railway.app 접속 → GitHub 로그인
   - New Project → Deploy from GitHub repo
   - 레포 선택 → 자동 배포 완료
   - 생성된 URL 공유

## 치지직 채널 ID 찾기

`https://chzzk.naver.com/abc123def456` → `abc123def456` 복사

## 채팅 명령어

| 명령어 | 설명 |
|--------|------|
| `!투표1` | 1번 항목에 투표 |
| `!투표2` | 2번 항목에 투표 |
| ... | 최대 8개 항목 |
