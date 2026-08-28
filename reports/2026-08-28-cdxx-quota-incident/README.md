# 2026-08-28 cdxx quota 표시·자동 전환 누락 사고 분석

## 1. 문서 목적

이 문서는 2026-08-28 15:35 KST 전후 `~/claudecodeui`에서 Codex 요청이 quota limit으로 실패했지만 `codex x use`의 quota 표시는 실제 상태와 맞지 않았고 자동 계정 전환도 일어나지 않은 사건을, 사전 배경지식이 없는 세션도 다시 조사할 수 있도록 정리한다.

결론부터 말하면 서로 다른 세 문제가 겹쳤다.

1. `codex x use` 화면은 서버의 현재 quota를 조회하지 않고 저장된 로컬 상태만 표시한다.
2. JSONL quota의 `primary`/`secondary` 위치를 각각 `5h`/`weekly`로 고정 해석하여, 실제 `window_minutes=10080`인 주간 window를 `5h`로 잘못 저장했다.
3. ClaudeCodeUI는 cdxx transport가 아니라 `@openai/codex-sdk`의 bundled Codex를 직접 실행한다. 따라서 자동 전환은 전역 JSONL watcher 하나에 의존했는데, 사건의 5개 quota 이벤트는 watcher에서 cdxx failover 경로로 전달되지 않았다. watcher는 파일시스템 알림이 한 번 누락되면 이를 주기적으로 재대조하는 장치가 없으며, 당시 내부 offset/heartbeat도 기록하지 않아 알림 누락의 더 낮은 수준 원인은 사후 확정할 수 없다.

즉, 사용자가 본 잘못된 표시는 단순 UI 렌더링 문제가 아니다. **실시간 조회를 하지 않는 상태 모델**, **quota window 의미의 오분류**, **best-effort watcher의 무복구 이벤트 누락**이 합쳐진 결과다.

## 2. 시간과 환경

- 사용자 관찰 시간대: KST (UTC+9)
- 호스트 로그 시간대: UTC
- 사건 날짜: 2026-08-28
- 조사 저장소: `/home/ubuntu/agentx`
- 조사 당시 `HEAD`: `5c83f34` (`feat: proxy Codex TUI through persistent app server`)
- branch: `main`, `origin/main`과 동일한 commit에서 시작
- 실제 global link:
  - `cdxx` -> `/home/ubuntu/agentx/packages/cli/cdxx/src/cli.js`
  - `@dong-/agentx-supervisor` -> `/home/ubuntu/agentx/packages/supervisor`
- Codex CLI:
  - global `@openai/codex@0.149.1`
  - ClaudeCodeUI dependency `@openai/codex-sdk@0.146.0`, bundled `@openai/codex@0.146.0`

중요: 조사 당시 agentx worktree에는 quota/core/supervisor 관련 대규모 미커밋 변경이 있었다. 특히 다음 파일은 live process가 읽을 수 있었지만 `HEAD`에는 없거나 내용이 달랐다.

- untracked: `packages/supervisor/src/codex_global_watcher.js`
- modified: `packages/supervisor/src/daemon.js`
- modified: `packages/cli/cdxx/src/{cli.js,quota.js,selection.js,ui.js,failover_policy.js,...}`
- modified: `packages/core/src/index.ts`

따라서 이 사건은 clean `5c83f34`만의 동작으로 해석하면 안 된다. **symlink된 dirty checkout의 live 동작**을 분석한 것이다. 이 리포트 커밋에는 기존 사용자 변경을 섞지 않았다.

## 3. 확인된 타임라인

| KST | UTC | 확인된 사실 |
|---|---|---|
| 15:35:44 | 06:35:44 | ClaudeCodeUI가 만든 첫 요청이 `usage_limit_exceeded`로 종료 |
| 15:35:58 | 06:35:58 | 두 번째 요청도 동일 실패 |
| 15:36:11 | 06:36:11 | 세 번째 요청도 동일 실패 |
| 15:36:25 | 06:36:25 | 네 번째 요청도 동일 실패 |
| 15:36:35 | 06:36:35 | 다섯 번째 요청도 동일 실패 |
| 15:37:31 | 06:37:31 | `codex x use`로 `dtjp_86` -> `zqop.38` 수동 전환 완료 |
| 15:41:11 이후 | 06:41:11 이후 | `zqop.38`에서 정상 요청 및 정상 quota window 수신 |

### 3.1 소진 계정의 실제 실패

아래 5개 rollout은 모두 `task_complete.error.codex_error_info = "usage_limit_exceeded"`를 포함한다.

```text
~/.codex/sessions/2026/08/28/
  rollout-2026-08-28T06-35-37-01a04714-c144-78a3-b128-d848f8b6b98d.jsonl
  rollout-2026-08-28T06-35-52-01a04714-f97d-7e01-8bd7-4d4de97a02fa.jsonl
  rollout-2026-08-28T06-36-05-01a04715-2c72-70f2-a7bb-39657d615cc1.jsonl
  rollout-2026-08-28T06-36-17-01a04715-5c7b-75a2-bc27-f3a389bcad07.jsonl
  rollout-2026-08-28T06-36-29-01a04715-8c06-7231-bb59-55dceedd2a63.jsonl
```

각 실패 직전 `token_count.rate_limits`의 핵심 값도 동일하다.

```json
{
  "limit_id": "premium",
  "primary": null,
  "secondary": null,
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "balance": "0"
  }
}
```

서버 오류 메시지에는 `try again at 8:45 AM`이 있었지만 날짜와 timezone이 없으므로 이 문서에서는 정확한 reset instant로 변환하지 않는다.

사건 전 active profile은 `dtjp_86`이었다. cdxx event log의 수동 전환 레코드가 이를 직접 증명한다.

```json
{"timestamp":"2026-08-28T06:37:31.110Z","event":"profile.selected","trigger":"manual-use","fromProfile":"dtjp_86","toProfile":"zqop.38","force":true}
{"timestamp":"2026-08-28T06:37:31.132Z","event":"switch.completed","trigger":"manual-use","fromProfile":"dtjp_86","toProfile":"zqop.38","force":true,"actionKind":"sessions_restarted"}
```

여기서 `force:true`는 반드시 사용자가 CLI에 `--force`를 썼다는 뜻은 아니다. 현재 구현은 unavailable confirmation에서 `y`를 선택해도 내부 `allowUnavailable=true`를 같은 필드로 기록한다. 사용자 설명의 `y/N`에서 `y`를 누른 동작과 일치한다.

### 3.2 전환 대상 계정은 실제로 정상

전환 후 현재 세션 rollout:

```text
~/.codex/sessions/2026/08/28/
  rollout-2026-08-28T06-40-52-01a04719-8f2a-7193-a769-0c045cff32d0.jsonl
```

이 파일에서 06:41:11~06:43:50 UTC에 수신된 quota는 다음과 같이 정상이다.

- `limit_id=codex`, `plan_type=plus`
- 5시간 window: `window_minutes=300`, `used_percent=0`에서 이후 4까지 증가
- 주간 window: `window_minutes=10080`, `used_percent=1`에서 이후 2까지 증가
- 매 turn이 정상 완료되어 이 조사 세션이 계속 진행됨

따라서 당시 로컬 state의 `zqop.38 = quota:5h, reset Aug 31` 표시는 현재 서버 상태와 명백히 모순된다.

## 4. `codex x use`가 보여 준 상태의 출처

사건 직후 `/home/ubuntu/.config/cdxx/state.json`의 핵심 상태는 다음과 같았다.

| profile | 화면상 의미 | 근거가 된 시각 | 문제 |
|---|---|---|---|
| `dtjp_86` | `ready` | scope `checkedAt=2026-08-22T01:19:52Z`; 마지막 status scan 2026-08-25 | 2026-08-28의 실제 exhaustion 5건이 반영되지 않음 |
| `zqop.38` | `quota:5h`, reset 2026-08-31 05:09 UTC | `checkedAt=2026-08-25T00:33:38Z` | 실제로는 전환 직후 5h 0%, weekly 1%로 정상; scope label도 틀림 |

`codex x use`의 display 경로는 다음과 같다.

1. `packages/cli/cdxx/src/cli.js::browseProfiles()`
2. `loadStateForDisplay()`
3. `loadState()` 후 `clearExpiredQuota(profile)`만 실행
4. `packages/cli/cdxx/src/ui.js::profilePresentationRows()`로 출력

여기에는 remote `/status` 또는 JSONL current-state scan이 없다. core에도 이 동작이 명시돼 있다.

```ts
// packages/core/src/index.ts
list: { mode: "state-only", foregroundAllowed: true },
use:  { mode: "state-only", foregroundAllowed: true },
```

`clearExpiredQuota`도 정확성 검증이 아니다. 저장된 `resetAt`이 미래이면 exhausted 상태를 유지하고, reset 없는 상태만 기본 24시간 TTL로 해제한다. 따라서 잘못 저장된 미래 reset은 `use` 화면에서 계속 권위 있는 값처럼 보인다.

이것이 `y/N` confirmation의 직접 원인이다. `profileSelectableReason()`이 저장된 `quotaScopes`의 exhausted 항목을 차단 사유로 반환하고, core `decideExplicitProfileUse()`가 unavailable profile에 대해 기본값 `N`인 confirmation을 만든다. 확인 자체는 저장 상태에 충실했지만 그 입력 상태가 오래되고 잘못 분류돼 있었다.

## 5. quota window 오분류

`packages/cli/cdxx/src/quota.js`는 현재 다음 고정 매핑을 사용한다.

```js
primary   -> "5h"
secondary -> "weekly"
```

하지만 실제 JSONL은 slot 이름이 아니라 `window_minutes`가 window 의미를 결정하는 사례가 있다. `zqop.38`을 exhausted로 기록하게 만든 2026-08-25 이벤트는 다음과 같았다.

```json
{
  "timestamp": "2026-08-25T00:33:38.307Z",
  "rate_limits": {
    "limit_id": "codex",
    "primary": {
      "used_percent": 100,
      "window_minutes": 10080,
      "resets_at": 1788152944
    },
    "secondary": null,
    "plan_type": "plus"
  }
}
```

`10080`분은 7일이다. 그런데 `updateSummary()`는 `primary` 값을 그대로 `summary.current.primary`에 넣고, `quotaScopesFromSummary()`는 이를 `5h` scope에 저장했다. 그래서 다음 잘못된 state가 만들어졌다.

```text
실제: weekly 100%, reset 2026-08-31T05:09:04Z
저장: 5h     100%, reset 2026-08-31T05:09:04Z
```

“5시간 quota가 6일 뒤 reset”이라는 비정상 조합은 이 오분류의 눈에 보이는 징후다.

현재 계정의 2026-08-28 payload는 `primary.window_minutes=300`, `secondary.window_minutes=10080`이므로 고정 매핑이 우연히 맞는다. 즉 payload shape가 계정/시점별로 달라질 수 있는데 adapter가 slot 위치를 계약처럼 가정한 것이 문제다.

영향은 표시 오류에 그치지 않는다.

- profile picker의 status 및 reset label이 틀림
- 어떤 scope가 exhausted인지에 기반한 후보 선택이 틀릴 수 있음
- 저장된 잘못된 future reset 때문에 오류가 오래 유지됨
- 후속 status가 성공해 state를 덮어쓰기 전까지 수동 use confirmation이 계속 발생

## 6. 자동 전환이 일어나지 않은 경로

### 6.1 ClaudeCodeUI는 cdxx session transport를 통과하지 않는다

ClaudeCodeUI의 Codex runtime은 다음 파일에서 `@openai/codex-sdk`를 직접 사용한다.

```text
/home/ubuntu/claudecodeui/server/modules/providers/list/codex/codex-runtime.provider.js
```

핵심은 `import { Codex } from '@openai/codex-sdk'` 및 `new Codex()`다. SDK는 ClaudeCodeUI의 dependency tree에 포함된 Codex executable을 실행한다. shell의 `codex()` function이나 `cdxx dispatch/session` transport를 거치지 않는다.

따라서 이 요청들에는 registered managed-session observer가 없고, agentx의 `CodexGlobalSessionWatcher`가 `~/.codex/sessions/**/*.jsonl` append를 발견하는 것이 유일한 자동 failover 경로였다.

### 6.2 parser는 사건 형식을 이해한다

사건의 첫 rollout을 새 임시 sessions directory에 복사하고 live watcher로 재생했다. watcher는 다음과 같이 올바르게 귀속했다.

```json
{
  "profile": "dtjp_86",
  "sessionId": "01a04714-c144-78a3-b128-d848f8b6b98d"
}
```

또한 현재 supervisor quota parser는 두 신호를 모두 exhaustion으로 판정한다.

- `limit_id=premium`, windows 없음, purchased credits 없음
- `task_complete.error.codex_error_info=usage_limit_exceeded`

관련 단위 테스트도 통과했다.

```text
node --test \
  packages/supervisor/test/codex_global_watcher.test.js \
  packages/supervisor/test/quota.test.js

tests 2, pass 2, fail 0
```

그러므로 이번 누락은 parser 미지원이 아니다.

### 6.3 전달 누락의 직접 증거

정상 전달됐다면 `/home/ubuntu/.config/cdxx/events.jsonl`에 최소 다음 흐름이 남아야 한다.

```text
supervisor.global_quota.detected
quota.detected
profile.selected (autoswitch) 또는 switch.stopped
supervisor.failover
```

하지만 06:35~06:36 UTC의 5개 실패에 해당하는 event는 하나도 없다. cdxx state도 06:37:31 수동 전환 전까지 이번 exhaustion으로 갱신되지 않았다. 다음 cdxx event는 바로 수동 `profile.selected`다.

따라서 실패 지점은 다음 구간으로 좁혀진다.

```text
ClaudeCodeUI SDK
  -> ~/.codex/sessions JSONL 기록                 [성공, 파일로 확인]
  -> CodexGlobalSessionWatcher dirty/scan/deliver [실패 또는 미실행]
  -> cdxx _supervisor-failover                   [도달 안 함, event 부재]
```

### 6.4 구조적 원인과 사후 확인 한계

`CodexGlobalSessionWatcher`는 `fs.watch` callback에서 파일을 `dirty` set에 넣고, supervisor의 200ms tick이 dirty 파일만 읽는다. 전체 tree reconciliation은 시작, watcher error recovery, 새 directory discovery 때만 수행된다. 평상시에는 tracked file들의 size를 주기적으로 stat해 누락 이벤트를 복구하지 않는다.

따라서 OS/filesystem watch notification 하나가 누락되거나 watcher가 잘못된 root/상태로 살아 있으면, 이미 디스크에 완성된 quota record가 있어도 영구히 처리되지 않는다. 이번 관측과 정확히 일치한다.

다만 다음 중 어떤 하위 원인이 실제로 발생했는지는 현 로그만으로 단정할 수 없다.

- 해당 JSONL create/append의 `fs.watch` notification 누락
- 새 date directory watcher 설치/발견 누락
- daemon 내부 watcher가 사건 시점에 비활성 또는 다른 `CODEX_HOME` root를 감시
- watcher callback 이후 dirty drain 이전의 내부 상태 이상

이유는 watcher가 다음을 영속 로그에 남기지 않기 때문이다.

- 실제 감시 root
- 감시 중인 directory 목록
- 마지막 성공 drain 시각
- 파일별 offset/size
- 발견한 `task_started`와 profile binding
- missed-event reconciliation 결과

`supervisor.global_scan.failed`도 사건 구간에 없지만, 이는 “정상 감시”의 증거가 아니다. 알림 자체가 오지 않는 경우 error callback도 실행되지 않기 때문이다.

따라서 확정 가능한 root cause 수준은 **복구 없는 best-effort filesystem notification에 unmanaged-session quota 감지를 맡긴 설계**다. notification이 왜 빠졌는지까지는 기존 telemetry 부족으로 복원 불가능하다.

## 7. 왜 두 계정 표가 동시에 이상했는가

사건 직전 화면을 상태 관점에서 재구성하면 다음과 같다.

1. active `dtjp_86`의 화면 값은 며칠 전 scan에서 `available`로 남아 있었다.
2. 15:35~15:36의 실제 exhaustion은 watcher 전달 누락 때문에 state에 기록되지 않았다.
3. target `zqop.38`은 3일 전 weekly exhaustion을 `5h`로 오분류한 future-reset state가 남아 있었다.
4. `codex x use`는 state-only이므로 두 값을 갱신하지 않고 그대로 보여줬다.
5. target이 exhausted로 분류되어 기본 `N` confirmation을 띄웠다.
6. 사용자가 `y`로 강제 활성화했다.
7. target은 실제 서버 상태상 사용 가능했으므로 새 ClaudeCodeUI 요청이 정상 동작했다.

이 흐름은 사용자가 보고한 모든 증상과 로그를 함께 설명한다.

## 8. 권고 수정 순서

프로젝트의 core-first policy에 따라 아래 순서가 필요하다. 이 리포트 작업에서는 기존 dirty worktree와 충돌하지 않도록 구현 수정은 하지 않았다.

### P0: live exhaustion 전달을 복구 가능하게 만들기

1. core에 unmanaged observation의 delivery/reconciliation 요구사항을 계약으로 추가한다.
2. global watcher가 일정 주기로 tracked tree의 file size를 재대조하도록 한다. 매 tick 전체 파일 내용을 읽을 필요는 없고, directory/file metadata reconciliation 후 증가분만 읽으면 된다.
3. watcher start 시 감시 root, heartbeat, 마지막 reconcile, dirty/drained count를 event log 또는 supervisor status에 노출한다.
4. “watch notification 없이 파일 size만 증가한 경우”와 “새 date directory notification이 유실된 경우” contract/regression test를 추가한다.
5. ClaudeCodeUI/SDK 같은 unmanaged caller에 대해 실제 end-to-end test를 추가한다.

### P0: window를 duration으로 정규화하기

1. core에 duration-based quota scope normalization 계약을 먼저 추가한다.
2. `window_minutes=300 -> 5h`, `10080 -> weekly`로 정규화하고 slot 이름은 fallback으로만 쓴다.
3. `primary=10080, secondary=null` fixture를 core/contract 및 cdxx regression test에 추가한다.
4. 알 수 없는 duration은 `unknown` 또는 duration-derived scope로 보존하고 임의로 `5h`라 부르지 않는다.
5. 기존 잘못 저장된 scope migration/refresh 정책을 정의한다.

### P1: picker의 신선도와 신뢰도를 표시하기

1. `list/use`를 계속 state-only로 둘지 core policy에서 재결정한다.
2. state-only를 유지한다면 `checkedAt` age와 `stale` 표시를 필수로 하고, 저장 quota를 현재 서버 사실처럼 보이지 않게 한다.
3. explicit refresh 동작을 picker에서 제공하거나, profile 선택 직전 bounded refresh를 허용하는 core contract를 만든다.
4. confirmation 문구에 “locally marked”와 관측 시각을 포함한다.

### P1: 기록 의미 정리

confirmation에서 `y`를 누른 것과 `--force` flag를 모두 `force:true`로 기록하면 조사 시 구분이 안 된다. `overrideSource: "confirmation" | "flag"`처럼 원인을 분리한다.

## 9. 수정 후 필수 회귀 시나리오

1. `primary.window_minutes=10080`, `secondary=null`, `used_percent=100`이면 `weekly` exhausted로 저장되고 `5h`로 저장되지 않는다.
2. `primary.window_minutes=300`, `secondary.window_minutes=10080`이면 각각 `5h`, `weekly`로 저장된다.
3. watcher notification을 의도적으로 호출하지 않고 JSONL을 append해도 periodic reconciliation이 quota를 한 번만 전달한다.
4. 새 날짜 directory 전체를 notification 없이 만든 뒤 quota 파일을 놓아도 탐지한다.
5. 동일 failure의 `token_count`와 `task_complete`가 연속돼도 failover는 한 번만 수행한다.
6. unmanaged SDK session의 `task_started` 시점 profile로 quota가 귀속된다.
7. `codex x use`에서 stale state가 현재 상태처럼 표시되지 않는다.
8. 잘못 저장된 future reset 때문에 실제 available profile이 영구 차단되지 않는다.

## 10. 재조사 명령

민감한 prompt 본문이나 auth token을 출력하지 않는 범위의 명령이다.

```bash
# 사건 구간 cdxx control-plane event
jq -c 'select(.timestamp >= "2026-08-28T06:25:00Z" and .timestamp <= "2026-08-28T06:40:00Z")' \
  ~/.config/cdxx/events.jsonl

# 사건 rollout에서 quota/error 필드만 확인
for f in ~/.codex/sessions/2026/08/28/rollout-2026-08-28T06-3{5,6}-*.jsonl; do
  jq -c 'select(.type == "event_msg" and (.payload.type == "token_count" or .payload.type == "task_complete")) |
    {timestamp, type: .payload.type, rate_limits: .payload.rate_limits,
     error_info: .payload.error.codex_error_info, error_message: .payload.error.message}' "$f"
done

# token/auth 원문을 제외한 저장 상태
jq '{activeProfile, profiles: [.profiles[] |
  {name, quotaStatus, quotaResetAt, lastQuotaReason, lastQuotaErrorAt,
   lastScanAt, updatedAt, quotaScopes, lastUsage}]}' \
  ~/.config/cdxx/state.json

# 관련 테스트
node --test \
  packages/supervisor/test/codex_global_watcher.test.js \
  packages/supervisor/test/quota.test.js
```

## 11. 최종 판정

- **실제 quota exhaustion:** 확정. 5회 `usage_limit_exceeded` 원문 존재.
- **사건 당시 active profile:** `dtjp_86`로 확정. 수동 전환 event의 `fromProfile`로 확인.
- **수동 전환:** `zqop.38`로 06:37:31 UTC 완료, confirmation override로 확인.
- **전환 대상의 실제 사용 가능성:** 확정. 전환 후 정상 turn과 5h 0~4%, weekly 1~2% payload 존재.
- **picker가 실시간 조회를 하지 않음:** 코드로 확정.
- **weekly window를 5h로 오분류:** `window_minutes=10080` 원문과 저장 state/코드로 확정.
- **자동 전환 누락 지점:** JSONL 기록 이후, global watcher delivery 이전으로 확정.
- **parser 결함 여부:** 이번 형식에 대해서는 아님. 사건 파일 replay 성공.
- **watcher 하위 수준의 단일 원인:** 기존 telemetry 부족으로 확정 불가. 다만 notification 누락을 복구하지 않는 설계가 사건을 영구 누락으로 만든 구조적 root cause임.
