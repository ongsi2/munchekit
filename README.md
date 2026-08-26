# MuncheKit · 문체킷

> 웹·앱·문서의 어색한 한국어를 찾아 이유와 최소 교정 후보를 보여줍니다.

[English](./README.en.md) · [규칙 목록](./docs/rules.md) · [승인 기반 문체 기억](./docs/learning.md) · [설계 원칙](./docs/architecture.md) · [최소 교정 교차 검토](./docs/reviews/claude-minimal-copyedit-2026-08-25.md) · [기여하기](./CONTRIBUTING.md)

[![CI](https://github.com/ongsi2/munchekit/actions/workflows/ci.yml/badge.svg)](https://github.com/ongsi2/munchekit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f5e.svg)](./LICENSE)
[![Node.js 20.19+](https://img.shields.io/badge/node-%3E%3D20.19-3c873a.svg)](./package.json)

MuncheKit은 **한국어 문체 린터·윤문 툴킷**이다. 맞춤법만 찾거나 “AI가 쓴 글인지” 판정하지 않는다. Markdown, MDX, HTML, JSX, TSX, `ko.json` 안의 한국어 카피를 골라 다음을 알려준다.

- 어느 표현이 걸렸는지: 파일·줄·열·UTF-16 범위
- 왜 어색할 수 있는지: 규칙별 근거와 신뢰도
- 무엇을 바꿀 수 있는지: 검토용 제안 또는 안전 자동수정
- 무엇을 건드리지 않았는지: 코드·URL·수치·보존 용어·문서 구조

핵심 비유는 **ESLint for Korean product copy**다. “사람처럼 보이게 만드는 프롬프트”보다 코드베이스에서 반복 실행하고 PR에서 검증할 수 있는 도구에 가깝다.

![MuncheKit social preview](https://raw.githubusercontent.com/ongsi2/munchekit/main/assets/social-preview.png)

## 10초 예시

원문:

```text
가지런한 치아는 서두르지 않고 만듭니다.
```

```console
$ npx --yes github:ongsi2/munchekit#v0.2.0 lint copy.txt --profile web
copy.txt:1:6  warning  결과물을 ‘은/는’으로 세운 뒤 만드는 방식을 이어 써, 목적과 행위의 관계가 늦게 드러납니다.  KO-ATTACH-001
  ↳ 제안 1: 목적 관계라면 이 범위를 “치아를 만들기 위해 서두르지 않습니다”로 바꿔 관계를 밝히세요.
  ↳ 범위 교체 1: 치아를 만들기 위해 서두르지 않습니다
  ↳ 제안 2: 단순한 방식 관계라면 이 범위를 “치아를 서두르지 않고 만듭니다”로 바꿔 목적어 조사만 밝히세요.
  ↳ 범위 교체 2: 치아를 서두르지 않고 만듭니다
```

첫 후보를 finding 범위에 적용하면 다음 문장이 된다.

```diff
- 가지런한 치아는 서두르지 않고 만듭니다.
+ 가지런한 치아를 만들기 위해 서두르지 않습니다.
```

단순히 만드는 방식을 말하려는 문맥이라면 둘째 후보인 `가지런한 치아를 서두르지 않고 만듭니다.`가 더 정확할 수 있다. 목적 관계를 택할지는 해석이 필요하므로 둘 다 자동수정하지 않는다.

`서두르지 않기에 보다 가지런한 치아가 완성됩니다.`도 카피로는 가능하지만, 원문보다 강한 인과·비교·피동을 추가한다. 기본 윤문이 스스로 골라 내보내는 후보가 아니라 사람이 그 의도를 확인한 뒤 쓰는 대안이다. 마찬가지로 `건강한`, `안전한`, `정밀한 진단`, `오래 유지되는`처럼 원문에 없던 주장은 기본 재작성에서 거부한다.

번역투·겹말·리듬 같은 기존 규칙도 같은 형식으로 진단한다. 예를 들어 다음 문장에는 `KO-CALQUE-001/002`, `KO-VAGUE-001/002`, `KO-POSS-001`이 각각 적용될 수 있다.

```text
새 검색 기능을 통해서 사용자는 원하는 문서에 대해서 매우 빠르게 찾을 수 있습니다.
```

`lint`는 원문을 바꾸지 않는다. `fix`도 의미와 말투가 달라질 수 있는 항목은 손대지 않는다.

## 설치와 실행

Node.js 20.19.0 이상이 필요하다.

현재 npm 패키지는 아직 게시 전이다. 대신 공개 GitHub v0.2.0 소스 릴리스를 바로 실행하거나 프로젝트에 고정할 수 있다.

```bash
# 공개 GitHub 소스를 설치 없이 한 번 실행
npx --yes github:ongsi2/munchekit#v0.2.0 check messages/ko.json --profile web

# 프로젝트에 고정
npm install --save-dev github:ongsi2/munchekit#v0.2.0
npx munche init
```

npm에 `munchekit` v0.2.0이 게시된 뒤에는 위 두 패키지 지정 부분을 각각 `munchekit`으로 줄일 수 있다.

주요 명령:

```bash
munche lint "content/**/*.md"               # 진단
munche check messages/ko.json --profile web  # warning이 있으면 exit 1
munche fix post.md                            # 안전 수정 diff
munche fix post.md --write                    # 안전 수정 적용
munche lint src --output json                 # 구조화된 결과
munche lint src --output sarif                # GitHub 코드 스캐닝 형식
munche explain KO-NOM-001                     # 규칙 설명
```

`munche`와 `munchekit` 두 실행 이름을 모두 제공한다.

## 무엇을 검사하나

| 범주 | 찾는 예 | 기본 처리 |
|---|---|---|
| 역할·절 관계 | `치아는 서두르지 않고 만듭니다`처럼 늦게 드러나는 목적 관계 | 정확한 두 후보, 사람 검토 |
| 번역투 | `~에 대해서`, 추상적인 `~을 통해서`, 반복되는 `기반` | 검토 제안 |
| 명사화·겹말 | `검토를 진행했다`, `사전에 미리`, `약 10개 정도` | 문맥을 확인하는 review |
| 피동·가능 표현 | `되어지다`, 기능 나열형 `~할 수 있다` | safe 또는 검토 |
| 모호한 평가 | `매우`, `혁신적인`, `강력한`, `다양한` | 근거 요청 |
| 생성형 상투어 | `단순한 A를 넘어 B`, `새로운 가능성을 열다` | 검토 제안 |
| 흐름·리듬 | 접속어, 주어, 종결 반복, 긴 문장과 빽빽한 문단 | 진단만 |
| 격식 | `~다`, `~습니다`, `~해요` 혼용 | 프리셋별 제안 |
| 문장부호·띄어쓰기 | `!!`, 고신뢰 `~할수있다` | safe fix |

초기 규칙팩의 전체 메타데이터와 반례는 [docs/rules.md](./docs/rules.md)에 있다. 규칙은 단어 금지 목록이 아니다. 예를 들어 `터널을 통해서 들어왔다`는 자연스러운 물리 경로이므로 `KO-CALQUE-002`가 잡지 않는다.

## 코드 구조를 먼저 본다

| 형식 | 분석하는 곳 | 기본 보호 |
|---|---|---|
| Plain text | 전체 본문 | URL, 이메일, 코드, 직접 인용 |
| Markdown / MDX | 텍스트 AST 노드 | frontmatter·코드·MDX 표현·링크 목적지 |
| JSON / JSONC | 문자열 값 | 키와 구문 토큰 |
| HTML | 보이는 텍스트, `alt`, `aria-label`, `placeholder`, `title`, 텍스트 메타데이터 | 태그·`script`·`style`·`code`·`pre`·`template`·URL 메타데이터 |
| JS / JSX / TS / TSX | JSX 텍스트와 사용자 노출 속성, 한국어 문자열 값 | import·route·computed key·타입·코드/`pre` 구문 |

파싱이 실패하면 plain text로 몰래 폴백하지 않고 `KO-PARSE-001` 오류를 반환한다. 코드가 한국어로 오인되는 것보다 검사를 멈추는 편이 안전하기 때문이다.

JSON 값과 일반 JavaScript/TypeScript 문자열은 화면 문구일 수도 있지만 조회 키, 정규식, API payload일 수도 있다. 그래서 진단은 하되 모든 수정안을 `review`로 강등한다. `fix`가 안전 자동수정할 수 있는 코드 영역은 JSX 텍스트와 명시적으로 허용한 사용자 노출 속성뿐이다.

## 설정

`munche init`으로 `.munche.json`을 만든다.

```json
{
  "$schema": "https://raw.githubusercontent.com/ongsi2/munchekit/v0.2.0/schema/munche.schema.json",
  "profile": "web",
  "files": ["content/**/*.{md,mdx}", "messages/ko.json", "src/**/*.{jsx,tsx}"],
  "ignore": ["**/*.test.*", "**/__snapshots__/**"],
  "preserveTerms": ["MuncheKit", "Next.js", "displayName"],
  "preservePatterns": ["\\bTICKET-[0-9]+\\b"],
  "rules": {
    "KO-REGISTER-001": "warning",
    "KO-END-001": "info"
  }
}
```

프리셋:

- `natural`: 원래 말투를 유지하는 보수적 기본값
- `web`: 짧고 직접적인 존댓말 제품 카피
- `tech-blog`: 구체적인 사실과 평서체 중심 기술 글
- `business`: 격식을 유지하는 업무 문서
- `thmm-tech`: 실제 개인 스타일 가이드에서 분리한 선택 프리셋

의도한 표현은 소스에서 억제할 수 있다.

```md
<!-- munche-disable KO-VAGUE-002 -->
이 구간의 ‘강력한’은 제품 등급의 공식 명칭이다.
<!-- munche-enable -->

이 줄만 무시한다. <!-- munche-ignore KO-END-001 -->
<!-- munche-disable-next-line KO-CALQUE-001 -->
다음 줄의 표현은 원문 인용이다.
```

## 승인 기반 문체 기억

`review → learn → rewrite --mode natural` 흐름으로 사람이 승인한 문장쌍을 프로젝트·브랜드별 문체 기억으로 재사용할 수 있다. 이는 모델 파인튜닝이나 자동 자가학습이 아니다. 승인·직접 수정한 `before → after`를 로컬에 저장하고, 자연 재작성 때 현재 문장과 가까운 예시를 제한된 문맥으로 다시 넣는 방식이다.

이 기능은 현재 `main` 브랜치의 **Unreleased** 변경에 포함되어 있으며 `v0.2.0` 태그에는 없다. 다음 릴리스 전에 시험하려면 `npm install --save-dev github:ongsi2/munchekit#main`으로 설치한 뒤 아래 명령을 `npx munche ...` 형식으로 실행한다.

`--profile`은 `web`, `business`처럼 진단 규칙을 고르는 내장 린트 프리셋이다. `--style-profile`은 `gounseon`처럼 승인 기록을 분리하는 사용자 지정 ID다. 둘은 함께 쓸 수 있다.

```bash
# 이미 확정한 문장쌍을 직접 저장
munche review --style-profile gounseon \
  --before "가지런한 치아는 서두르지 않고 만듭니다." \
  --after "가지런한 치아를 만들기 위해 서두르지 않습니다."

# 파일의 진단과 제안을 대화형으로 승인·수정·거절
munche review page.html --profile web --style-profile gounseon

# 승인 기억과 충돌 사례 확인
munche learn --style-profile gounseon

# 관련 승인 예시를 참고하는 자연 재작성 제안
ANTHROPIC_API_KEY=... munche rewrite page.html \
  --profile web --mode natural --style-profile gounseon --model <Claude-모델-ID> \
  --result-file rewrite-result.json

# 가드를 통과한 제안을 사람이 검토하고 선택 적용
munche review page.html --style-profile gounseon \
  --rewrite-result rewrite-result.json --write
```

`--mode natural`은 바로 `--write`할 수 없다. JSON 결과를 `review --rewrite-result`로 가져와 사람이 승인·수정·거절한 범위만 적용해야 하며, 그 결정이 다음 실행에 반영된다. 기본 `--mode minimal`은 더 보수적이며 문체 기억을 사용하지 않는다.

비대화형 decisions JSON, 승인·수정·거절 기록법, 개인정보 주의사항까지 포함한 전체 절차는 [승인 기반 문체 기억 문서](./docs/learning.md)에 있다.

## 라이브러리 API

```ts
import { analyze, applyFixes } from 'munchekit';

const source = '결과가 저장되어진다!!';
const report = analyze(source, {
  profile: 'web',
  filePath: 'post.md',
  preserveTerms: ['displayName'],
});

const fixed = applyFixes(source, report);
console.log(fixed.text);
// 결과가 저장된다!
```

`Diagnostic`에는 `ruleId`, `severity`, `confidence`, `range`, `location`, `rationale`, `suggestions`, `fixability`가 들어간다. 오프셋은 JavaScript와 LSP가 쓰는 UTF-16 code unit 기준이다.

`lint`와 `check`의 `--output json` 계약은 [MuncheKit JSON report schema](./schema/munche-report.schema.json), `rewrite --output json` 계약은 [rewrite result schema](./schema/munche-rewrite-result.schema.json)에서 확인할 수 있다.

## 선택형 Claude 윤문

로컬 규칙만으로 조사·절 관계가 얽힌 문장을 모두 교정하기는 어렵다. 기본 `rewrite --mode minimal`은 원문 내용어와 그 상대 순서를 유지하는 최소 교정 단계만 Claude Messages API에 위임한다. 어순 변경은 `KO-ATTACH-001`처럼 정확한 로컬 범위 교체 후보가 있을 때만 허용한다. `rewrite --mode natural`은 별도로 저장한 승인 문장쌍을 참고하지만, 원문에 없던 주장을 추가할 수 없고 결과를 바로 파일에 쓰지도 않는다.

```bash
ANTHROPIC_API_KEY=... \
  npx --yes github:ongsi2/munchekit#v0.2.0 rewrite post.md --model <사용할-Claude-모델-ID>
```

모델 ID는 빠르게 바뀌므로 기본값을 코드에 박지 않는다. 가드를 통과한 결과는 stderr에 `원문 → 수정문`, 이유, 관련 규칙을 보여 주고 stdout에는 최종 문장만 출력해 파이프 사용을 보존한다. minimal 모드는 `--write`를 줬을 때만 파일에 쓴다. natural 모드는 직접 `--write`를 거부하고 JSON 결과를 `review --rewrite-result`로 넘기게 한다.

기본 endpoint는 `https://api.anthropic.com`이다. Anthropic 호환 서비스가 필요하면 `--base-url <HTTPS URL>`을 쓸 수 있지만 API key와 segment가 그 주소로 전송되므로 직접 신뢰하는 endpoint만 지정해야 한다.

재작성은 모델이 문서 전체를 돌려주는 방식이 아니다. 파서가 다듬어도 되는 한국어 span과 그 범위에 걸린 진단·수정 후보만 보낸다. 코드·태그·URL·수치·인용문·보존 용어가 있던 자리는 로컬 원본에 그대로 둔다. 부정·양태 표현은 활용을 고칠 수 있도록 segment에 남기되 로컬에서 의미 어간을 비교한다. 응답의 segment만 원래 범위에 다시 끼운 뒤 다음 조건을 검사한다.

- segment의 개수·ID·순서가 같은가
- 응답이 설명·코드 펜스·미지 필드가 없는 엄격한 JSON인가
- 수치, URL, 코드, 보존 용어의 정확한 multiset이 같은가
- 부정·양태의 의미 어간과 이웃 서술어가 같은가, 접속 관계 변화가 정확한 로컬 후보로 허용됐는가
- 시제와 주어·목적어 등의 조사 역할이 보존됐는가
- 마침표·물음표·느낌표가 나타내는 진술·질문·강조의 성격이 보존됐는가
- 원문이나 해당 진단의 후보에 없던 내용어를 추가하지 않았나
- 진단 범위 밖의 내용어를 삭제하지 않았나
- 정확한 로컬 후보가 없는 수정에서 내용어의 상대 순서를 바꾸지 않았나
- 후보가 원래 JSON/HTML/TSX/Markdown 구조로 다시 파싱되고 구조 signature가 같은가
- 문서 전체와 각 segment의 변경 비율이 설정 한도를 넘지 않았나

`--max-change 1`을 줘도 가드가 임의로 꺼지지는 않는다. 다만 natural 모드에서 원문 전체가 사람이 승인한 `before`와 정확히 같으면 그 특정 `after`에 한해 문장 수준의 내용어·어순·시제 변경을 이미 승인한 것으로 본다. 리터럴·수치·소스 구조·변경량 가드는 이때도 유지된다. 통과해도 의미 보존을 증명한 것은 아니므로 Claude 결과는 언제나 **review**다. API 요청 형식은 [Anthropic Messages API 문서](https://docs.anthropic.com/en/api/messages)를 따른다.

이 실패 사례에 사용한 읽기 전용 Claude Code 점검 방법, 재현한 지적, 수용·수정 근거는 [최소 교정 교차 검토 기록](./docs/reviews/claude-minimal-copyedit-2026-08-25.md)에 남겼다. `solo-skills`의 한국어 글 다듬기 지침에서 선별한 원칙과 제외한 위험 처방은 [외부 문체 규칙 검토 기록](./docs/reviews/solo-skills-humanize-korean-2026-08-25.md)에 정리했다. 다른 모델이나 규칙집의 동의만으로 규칙을 `safe`로 올리지는 않는다.

## 맞춤법 검사기나 humanizer와 무엇이 다른가

| 도구 | 주된 질문 | 코드 인식 | 설명 가능한 위치 진단 | 자동수정 정책 |
|---|---|---:|---:|---|
| 맞춤법 검사기 | 규범상 틀렸나 | 보통 없음 | 일부 | 문법 교정 |
| 일반 LLM 윤문 | 더 잘 쓸 수 있나 | 프롬프트에 따라 다름 | 보통 없음 | 문장 전체 재작성 |
| AI 탐지/우회 도구 | AI처럼 보이나 | 도구마다 다름 | 신호 점수 중심 | 탐지 점수 감소 |
| MuncheKit | 이 코드의 한국어가 왜 어색할 수 있나 | 예 | 파일·줄·span | safe와 review 분리 |

MuncheKit은 저자가 사람인지 AI인지 판별하지 않으며 탐지기 우회를 목표로 하지 않는다. “AI 티 제거”, “GPT 문체 제거”, “한국어 humanizer”를 찾다가 온 사용자에게도 같은 원칙을 적용한다. 출처가 아니라 문장 안의 구체적인 문제만 다룬다.

## 개인정보와 한계

- `lint`, `check`, `fix`는 네트워크를 쓰지 않는다.
- `review`와 `learn`도 네트워크를 쓰지 않는다. 승인 기록은 기본적으로 `.munche/feedback.jsonl`에 저장되며 원문·제안·최종 문장·거절한 제안·이유 태그·소스 위치가 들어갈 수 있다.
- 기본 피드백 경로에 처음 기록할 때 `.munche/.gitignore`를 만들어 실수로 Git에 추가되는 것을 막는다. 이미 추적 중인 파일이나 `--feedback-file`로 지정한 별도 경로는 사용자가 직접 보호해야 한다.
- `rewrite`만 사용자가 지정한 Anthropic endpoint로 보호 처리된 문서를 보낸다. natural 모드에서는 현재 segment와 함께 선택된 승인 문장쌍도 전송된다.
- 로컬 pretty/JSON/SARIF 보고서의 `excerpt`에는 진단 주변 원문이 들어갈 수 있으므로, 보고서를 외부에 공유하기 전에 민감 정보를 확인해야 한다. 이 excerpt 필드는 provider 요청에는 넣지 않는다.
- provider는 기본적으로 HTTPS만 허용하고 redirect를 거부하며, 응답 시간·크기를 제한한다.
- CLI는 기본적으로 작업 루트 밖 파일과 심볼릭 링크를 거부한다. 루트 밖의 명시 경로를 읽어야 할 때만 `--allow-outside-root`를 사용한다.
- 현재 코어는 형태소 분석기 없이 고정밀 패턴과 문서 구조를 쓴다. 모든 문체 문제를 찾지 못한다.
- JSON·JavaScript·TypeScript 문자열에 escape가 들어가 원문 오프셋과 디코딩 값이 달라지면 보수적으로 건너뛴다.
- 제안은 사실 검증이나 법률·의료 교열을 대신하지 않는다.
- “자연스러움”은 하나의 정답이 아니다. 프리셋과 억제 기능이 있는 이유다.

## 평가와 로드맵

현재 저장소에는 규칙별 최소 대조쌍과 코드 구조 공격 테스트가 있다. 릴리스 수치는 [평가 문서](./docs/evaluation.md)에 측정 명령과 함께 공개한다. 목표는 recall보다 precision이다.

- [x] Plain/Markdown/MDX/JSON/HTML/JSX/TSX 추출
- [x] pretty/JSON/SARIF, CLI와 TypeScript API
- [x] safe fix, 억제 지시문, 겹침·수정량 방어
- [x] 선택형 Claude provider와 리터럴·부정·내용어·변경량 guard
- [ ] 저자·장르를 분리한 500개 이상 clean benchmark
- [ ] YAML과 ICU MessageFormat 전용 추출기
- [ ] optional Kiwi 형태 분석 adapter
- [ ] GitHub Action 패키지와 PR annotation
- [ ] 같은 코어를 쓰는 웹 playground

## 기여

새 규칙에는 반드시 실제 전후 예문, 잡지 말아야 할 반례, 수정 위험 등급, 테스트가 필요하다. 자세한 절차는 [CONTRIBUTING.md](./CONTRIBUTING.md)에 있다. 오탐 한 건도 좋은 기여다.

MIT © 2026 ongsi2
