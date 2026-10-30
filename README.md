# DIF – Discord Bump Network

DIF는 여러 Discord 서버가 범프 네트워크를 통해 서로를 홍보할 수 있도록 만드는 프로젝트입니다.

## 현재 포함된 기능 (1차 기반)

- `/범프`: 서버별 120분 쿨다운을 PostgreSQL에 저장
- `/감지설정`: 외부 감지 대상으로 디코보드 또는 DISBOARD 선택
- `/공지채널`: 범프 안내 메시지를 보낼 채널 설정
- `/디프상태`: 서버별 감지 설정과 남은 쿨다운 확인
- Render Background Worker용 `render.yaml`

## 아직 구현되지 않은 기능

아래 기능은 다음 개발 단계에서 연결해야 합니다.

- 디코보드 / DISBOARD 메시지의 실제 외부 범프 감지 및 🧡 반응
- 디코보드 우선 감지 및 DISBOARD 대체 감지 자동 판별
- 디코보드 Pro 상태의 안전한 검증과 Pro 예외 처리
- 서버 간 범프 네트워크 배포 및 홍보 메시지
- 운영자 대시보드

현재 `/감지설정`은 감지 대상을 DB에 저장하는 설정 기능이며, 외부 메시지를 실제 감지하지는 않습니다.

## 필요한 환경 변수

`.env.example`을 참고해 Render 환경 변수에 다음 값을 등록하세요.

- `DISCORD_TOKEN`: Discord 봇 토큰
- `CLIENT_ID`: Discord 애플리케이션 ID
- `DATABASE_URL`: PostgreSQL 연결 문자열 (Neon 사용 가능)

## Discord Developer Portal 설정

1. 봇을 생성하고 토큰을 발급합니다.
2. **Message Content Intent**를 활성화합니다.
3. 봇 초대 링크에 `bot` 및 `applications.commands` 스코프를 포함합니다.
4. 서버에서 메시지 읽기, 메시지 기록 보기, 메시지 보내기 권한을 필요한 채널에 부여합니다.

## 실행

```bash
npm install
npm start
```

## Render 배포

이 저장소를 GitHub에 올린 뒤 Render에서 **New > Blueprint**로 저장소를 선택하면 `render.yaml`을 읽어 Background Worker를 구성할 수 있습니다.

Render 환경 변수에 `DISCORD_TOKEN`, `CLIENT_ID`, `DATABASE_URL`을 입력해야 합니다.
