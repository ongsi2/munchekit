# 승인 기반 문체 기억

MuncheKit의 문체 기억은 모델을 파인튜닝하거나 스스로 학습시키는 기능이 아니다. 사람이 승인하거나 직접 고친 `before → after` 문장쌍을 로컬 JSONL에 저장하고, `rewrite --mode natural`을 실행할 때 현재 문장과 가까운 승인 예시를 제한된 문맥으로 다시 제공하는 방식이다.

이 문서의 기능은 현재 `main` 브랜치의 **Unreleased** 변경에 포함되어 있으며 `v0.2.0` 태그에는 없다. 다음 릴리스 전에 시험하려면 `npm install --save-dev github:ongsi2/munchekit#main`으로 설치하고 아래의 `munche` 명령을 `npx munche`로 실행한다.

기본 흐름은 다음과 같다.

```text
review로 승인·수정·거절 기록
  → .munche/feedback.jsonl
  → learn으로 기록 요약 확인
  → rewrite --mode natural에서 관련 승인 예시 검색
  → 보호 가드를 통과한 제안 출력
  → 사람이 다시 승인·수정·거절
```

`natural` 결과가 다음 실행에 반영되려면 마지막 사람 검토를 다시 `review` 기록으로 남겨야 한다. 실행 횟수만 늘린다고 자동으로 학습되지는 않는다.

## `--profile`과 `--style-profile`

이름이 비슷하지만 역할이 다르다.

| 옵션 | 역할 | 예 |
|---|---|---|
| `--profile` | 어떤 규칙을 어떤 강도로 진단할지 정하는 내장 린트 프리셋 | `web`, `tech-blog`, `business` |
| `--style-profile` | 승인 기록을 프로젝트·브랜드별로 분리하는 사용자 지정 문체 ID | `gounseon`, `brand-a` |

`--profile web --style-profile gounseon`은 “웹 카피 규칙으로 진단하되, 결정은 `gounseon` 문체 기억에 저장한다”는 뜻이다. 내장 프리셋인 `--profile natural`과 재작성 모드인 `--mode natural`도 서로 다른 설정이다.

## 1. 기존 문장쌍으로 시작하기

이미 최종 문구가 정해져 있다면 파일 없이 바로 기록할 수 있다.

```bash
munche review \
  --style-profile gounseon \
  --before "가지런한 치아는 서두르지 않고 만듭니다." \
  --after "가지런한 치아를 만들기 위해 서두르지 않습니다." \
  --reason "목적 관계를 먼저 밝힘" \
  --lock "가지런한 치아"
```

`--after`를 직접 준 기록은 `edited` 결정으로 저장된다. `--reason`과 `--lock`은 여러 번 쓸 수 있다. 직접 기록 모드는 소스 파일을 수정하지 않는다.

도구나 모델이 낸 제안을 그대로 승인할 때는 `--proposal`을 쓴다.

```bash
munche review --style-profile gounseon \
  --before "기존 문장" \
  --proposal "승인한 제안"
```

제안을 다시 고쳤다면 원 제안과 최종 문장을 함께 남길 수 있다.

```bash
munche review --style-profile gounseon \
  --before "기존 문장" \
  --proposal "모델 제안" \
  --after "사람이 고친 최종 문장" \
  --reason "과장된 인과를 줄임"
```

거절 기록은 긍정 예문으로 재사용되지 않는다. 거절 이유 태그만 이후 제안의 경고 문맥에 반영될 수 있다.

```bash
munche review --style-profile gounseon \
  --before "기존 문장" \
  --proposal "거절한 제안" \
  --decision rejected \
  --reason "원문에 없던 효능 추가"
```

## 2. 파일을 대화형으로 검토하기

TTY에서 파일을 넘기면 진단마다 제안 승인, 직접 수정, 제안 거절, 원문 유지를 선택할 수 있다.

```bash
munche review page.html --profile web --style-profile gounseon
```

각 결정 뒤에는 이유 태그와 보존할 주장·표현을 선택적으로 입력한다. 기본 실행은 승인된 변경의 diff만 보여 주지만, 결정 자체는 문체 기억에 저장한다. 파일에도 적용하려면 검토 명령에 `--write`를 명시한다.

```bash
munche review page.html --profile web --style-profile gounseon --write
```

검토 도중 원본 파일이 바뀌면 쓰기를 중단한다.

## 3. CI나 스크립트에서 검토하기

비대화형 환경에서는 먼저 현재 원문에 대한 검토 세션을 JSON으로 받는다.

```bash
munche review page.html \
  --profile web \
  --style-profile gounseon \
  --output json > review-session.json
```

세션의 `sourceHash`, `sessionHash`와 각 항목의 `id`를 복사해 결정 파일을 만든다. 모든 검토 항목에 결정을 하나씩 써야 하며 `proposalIndex`는 0부터 시작한다.

```json
{
  "schemaVersion": "1.0",
  "sourceHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sessionHash": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "resolutions": [
    {
      "itemId": "review_0123456789abcdef01234567",
      "decision": "accepted",
      "proposalIndex": 0,
      "reasonTags": ["목적 관계를 먼저 밝힘"],
      "lockedClaims": ["가지런한 치아"]
    }
  ]
}
```

그 결정 파일을 같은 원문에 적용한다.

```bash
munche review page.html \
  --profile web \
  --style-profile gounseon \
  --decisions review-decisions.json
```

파일까지 바꾸려면 마지막 명령에 `--write`를 추가한다. 세션을 만든 뒤 원문이 달라져 `sourceHash`가 맞지 않거나, 도구 업데이트 등으로 규칙·제안 내용이 달라져 `sessionHash`가 맞지 않으면 결정 적용을 거부한다. 결정 문서의 전체 계약은 [review decision schema](../schema/munche-review-decisions.schema.json)에 있다.

decisions 적용 단계에도 `--output json`을 쓰면 diff와 상태 문구 대신 적용 여부, edits, 저장된 feedback과 최종 text를 하나의 JSON 객체로 출력한다.

## 4. 쌓인 기억 확인하기

```bash
munche learn --style-profile gounseon
munche learn --style-profile gounseon --output json
```

`learn`은 승인·직접 수정 기록 수, 고유 문장쌍, 평균 길이 변화와 예문을 보여 준다. 확인용 명령이므로 natural 재작성 전에 반드시 실행할 필요는 없다. 별도 모델을 훈련하거나 새 가중치 파일을 만들지도 않는다. 같은 원문에 서로 다른 최종 문장이 저장된 충돌 사례는 자연 재작성 예문에서 보류된다.

## 5. 승인 예시로 자연 재작성하기

`natural` 모드는 해당 `--style-profile`에 승인 또는 직접 수정된 문장쌍이 하나 이상 있어야 한다.

```bash
ANTHROPIC_API_KEY=... munche rewrite page.html \
  --profile web \
  --mode natural \
  --style-profile gounseon \
  --model <claude-model-id> \
  --result-file rewrite-result.json
```

현재 입력과 가까운 승인 예시는 문체 참고 자료가 된다. 현재 문장이 승인 기록의 `before`와 정확히 같을 때만 그 `after`가 해당 변경을 명시적으로 허용한다. 비슷한 예문만으로 원문에 없던 주장이나 효능을 복사할 수는 없으며, 리터럴·수치·문서 구조·변경량 보호도 그대로 적용된다.

`--mode natural`에는 `--write`를 사용할 수 없다. 대신 가드를 통과한 JSON 결과를 같은 원문 파일의 review로 가져온다.

```bash
munche review page.html \
  --style-profile gounseon \
  --rewrite-result rewrite-result.json \
  --write
```

각 `before → after` 제안을 승인·직접 수정·거절·유지할 수 있다. 승인한 범위만 `--write`로 원문에 반영되고 모든 결정이 문체 기억에 저장된다. 결과 파일의 `sourceHash`, 문체 프로필, 변경 범위와 재구성된 candidate가 현재 입력과 맞지 않으면 review가 거부한다. 비대화형 환경에서는 이 명령에 `--output json`을 붙여 review 세션을 만든 뒤 3절과 같은 decisions 파일을 사용한다. 직접 기록이 필요하면 `review --before ... --proposal ...` 또는 `--after ...` 흐름도 그대로 쓸 수 있다. JSON 계약은 [rewrite result schema](../schema/munche-rewrite-result.schema.json)에 있다.

더 보수적인 기본 재작성은 `--mode minimal`이며 문체 기억을 사용하지 않는다. `--style-profile`을 함께 넘겨도 minimal 프롬프트는 승인 예시의 영향을 받지 않는다.

## 저장 위치와 개인정보

기본 저장소는 작업 루트의 `.munche/feedback.jsonl`이다. 여기에는 원문, 제안, 최종 문장, 거절한 제안, 이유 태그, 보존 표현과 소스 경로·범위가 들어갈 수 있으므로 원문과 같은 수준의 민감 데이터로 다뤄야 한다. `--result-file` 또는 `--output json`으로 저장한 rewrite 결과에도 원문 조각과 전체 candidate가 포함되므로 같은 기준으로 보호한다. `--result-file`은 기존 파일을 덮어쓰지 않고 UTF-8로 새로 만든다.

기본 경로에 처음 기록할 때 MuncheKit은 `.munche/.gitignore`를 만들어 `.munche` 안의 파일이 실수로 Git에 추가되지 않도록 한다. 기존 `.munche/.gitignore`가 있으면 내용을 보존하므로 `feedback.jsonl`이 실제로 제외되는지 확인해야 한다. 이미 추적 중인 파일을 제거해 주지는 않으며, `--feedback-file`로 다른 경로를 지정하면 그 경로의 ignore 정책은 사용자가 직접 설정해야 한다.

`review`와 `learn`은 네트워크를 사용하지 않는다. 다만 `rewrite --mode natural`은 선택된 승인 예문과 현재 재작성 segment를 설정한 Anthropic 호환 endpoint로 보낸다. 민감 문구가 있다면 실행 전에 기록과 endpoint의 보관 정책을 확인한다.
