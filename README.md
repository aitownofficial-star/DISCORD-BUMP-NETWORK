# DIF – Discord Bump Network

Render Web Service 방식의 DIF 봇입니다.

## Render 설정
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`
- Environment Variables: `DISCORD_TOKEN`, `CLIENT_ID`, `DATABASE_URL`

## Ping / Health endpoint
배포 후 다음 주소로 상태를 확인할 수 있습니다.

`https://discord-bump-network.onrender.com/health`

정상 응답 예시:
```json
{"ok":true,"service":"DIF","bot":"online"}
```

`bot` 값이 `starting`이면 Discord Gateway 연결을 기다리는 중입니다.

## 주의
Render 무료 Web Service는 일정 시간 요청이 없으면 sleep 상태가 됩니다.
`/health`는 상태 확인용 엔드포인트이며, 주기적인 요청이 무료 플랜의 24시간 가동을 보장하지는 않습니다.
