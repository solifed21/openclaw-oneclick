# openclaw-oneclick (rebuilt)

요구사항 반영 버전:

1. 현재 등록된 agents 리스트 표시
2. openclaw.json 현재 상태 실시간 로드
3. 추가 버튼으로 여러 agent 행 생성
4. 각 행에서 agent-model(현재 등록 모델만)-discord 바인딩 동시 입력
5. 세부 정책 옵션(멘션/봇대화/턴/쿨다운/루프민감도)

## 실행

```bash
npm install
npm start
```

브라우저: http://127.0.0.1:8787

## 주의

- 적용 시 `~/.openclaw/openclaw.json.bak.<timestamp>` 자동 백업 생성
- 적용 후 gateway 자동 재시작
