# openclaw-oneclick (rebuilt)

요구사항 반영 버전:

1. 현재 등록된 agents 리스트 표시
2. openclaw.json 현재 상태 실시간 로드
3. 추가 버튼으로 여러 agent 행 생성
4. 에이전트 내부에서 길드 +, 길드 내부에서 채널 + UX 제공
5. payload는 `agents[].guilds[].channels[]` 구조 사용
6. 세부 정책 옵션(멘션/봇대화/턴/쿨다운/루프민감도)을 에이전트 단위로 저장
7. `meta.oneclick.agentPolicies`에 정책 저장(내부 정책 레이어)

## 실행

```bash
npm install
npm start
```

브라우저: http://127.0.0.1:8787

## 주의

- 적용 시 `~/.openclaw/openclaw.json.bak.<timestamp>` 자동 백업 생성
- 적용 후 gateway 자동 재시작
