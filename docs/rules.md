# Rule catalog

Language-rule levels are configurable. `KO-PARSE-001` is a fixed engine error and cannot be disabled. `safe` is a rule capability, but JSON values and generic program strings downgrade even safe candidates to `review`. `safe` edits can run under `munche fix`; `review` items never change text without a person or an explicitly invoked guarded provider; `none` is diagnostic-only.

| ID | Category | Default | Fix | What it checks |
|---|---|---:|---:|---|
| KO-ATTACH-001 | clarity | info | review | a result topic that delays the purpose relation |
| KO-CALQUE-001 | translationese | info | review | `~에 대해서/대한` |
| KO-CALQUE-002 | translationese | info | review | abstract `~을 통해서` |
| KO-CALQUE-003 | translationese | info | review | generic `기반` clauses |
| KO-NOM-001 | conciseness | warning | review | selected noun + generic verb pairs |
| KO-RED-001 | redundancy | warning | review | potentially redundant pairs |
| KO-RED-002 | redundancy | warning | review | doubled approximation |
| KO-VOICE-001 | voice | warning | safe | `되어지다` |
| KO-POSS-001 | directness | info | review | feature-list `~할 수 있다` |
| KO-VAGUE-001 | specificity | info | review | unsupported intensifiers |
| KO-VAGUE-002 | specificity | info | review | abstract praise adjectives |
| KO-BOILER-001 | boilerplate | info | review | generic introductions |
| KO-PAIR-001 | boilerplate | info | review | `단순한 A를 넘어 B` |
| KO-AI-001 | boilerplate | info | review | reusable generated-copy clichés |
| KO-LEN-001 | readability | info | none | long multi-clause sentence |
| KO-PARA-001 | readability | info | none | dense paragraph |
| KO-END-001 | rhythm | info | none | four repeated endings |
| KO-REGISTER-001 | register | warning | review | register mismatch/mixing |
| KO-CONNECT-001 | flow | info | review | sentence-initial connective density |
| KO-PRON-001 | flow | info | review | repeated explicit subject |
| KO-POLITE-001 | register | info | review | stacked deferential phrasing |
| KO-META-001 | boilerplate | info | review | generic closing sentence |
| KO-PUNCT-001 | punctuation | warning | safe | consecutive exclamation marks |
| KO-PUNCT-002 | punctuation | info | review | document-level exclamation density |
| KO-PLURAL-001 | conciseness | info | review | plural suffix after plural quantifier |
| KO-SPACE-001 | mechanics | warning | safe | high-confidence `수 있다/없다` spacing |
| KO-PARSE-001 | parser | error | none | structured-source parse failures |

## KO-ATTACH-001

- Flags: `가지런한 치아는 서두르지 않고 만듭니다.`
- First review candidate: `가지런한 치아를 만들기 위해 서두르지 않습니다.`
- Alternative when the original manner relation is intentional: `가지런한 치아를 서두르지 않고 만듭니다.`
- HTML/JSX layout breaks are preserved in review candidates: `치아는<br>서두르지 않고 만듭니다.` → `치아를 만들기 위해<br>서두르지 않습니다.` Arbitrary inline elements and block boundaries are not joined.
- Does not flag: explicit objects, passive constructions, or nouns outside the initial dental-outcome allowlist (`치아`, `치열`, `교합` with `만들다`). A legitimate contrastive topic inside that allowlist can still be reported, which is why the rule stays review-only.
- Why review-only: `은/는` can mark a legitimate contrastive topic. Changing `서두르지 않고` into a purpose clause makes an interpretation explicit, so a person must confirm that intent.
- The rule deliberately starts with a small set of known result–creation pairs. Add a hard negative whenever that set is expanded.

## KO-CALQUE-001

- Flags: `새 기능에 대해서 설명했다.`
- Does not flag: `새 기능을 설명했다.`
- Why review-only: replacing the phrase requires choosing the correct Korean particle and verb argument.

## KO-CALQUE-002

- Flags: `검색 기능을 통해서 문서를 찾았다.`
- Does not flag: `터널을 통해서 반대편으로 갔다.`
- Why review-only: physical paths and channels are legitimate uses.

## KO-CALQUE-003

- Flags: `사용자 데이터에 기반한 추천이다.`
- Does not flag: `사용자 데이터를 분석해 추천했다.`
- Why review-only: `기반` is legitimate in many technical contexts; the rule asks for a more specific relationship.

## KO-NOM-001

- Flags: `설계 검토를 진행했다.`
- Does not flag: `행사를 예정대로 진행했다.`
- Why review-only: a modifier can require the noun (`면밀한 검토를 진행했다`), and replacing only the matched phrase can break grammar or particles.

## KO-RED-001

- Flags: `사전에 미리`, `다시 재검토`, `가장 최적`.
- Does not flag: `사전에 검토하고 나중에 다시 확인했다.`
- Why review-only: `사전에` can mean “in a dictionary,” and apparent repetition can preserve emphasis or a distinct lexical meaning.

## KO-RED-002

- Flags: `약 10개 정도`.
- Does not flag: `10개 정도`, `약 10개`.
- Why review-only: `약` can be the noun “medicine,” and deleting either side may require particle changes.

## KO-VOICE-001

- Flags and fixes: `결과가 저장되어진다.` → `결과가 저장된다.`
- Does not flag: ordinary `되다` or lexical `-어지다`.

## KO-POSS-001

- Flags: product-feature lists such as `문서를 찾을 수 있습니다.`
- Does not mean the sentence is grammatically wrong. Keep it when ability or permission is the actual claim.

## KO-VAGUE-001

- Flags: `매우`, `굉장히`, `대폭` and similar intensifiers.
- Does not auto-delete them because degree can be semantically important.
- Preferred review: add a comparison or measurement, or remove unsupported emphasis.

## KO-VAGUE-002

- Flags: `혁신적인`, `강력한`, `최적의`, `다양한` and similar evaluations.
- Hard negative: `다양한 생물이 사는 숲` can be literal and useful. The default level is therefore informational outside stricter profiles.

## KO-BOILER-001

- Flags: `오늘날 ... 중요성이 커지고 있습니다`, `이번 글에서는 ... 살펴보겠습니다`.
- Does not flag a concrete date, event, question, or problem statement.

## KO-PAIR-001

- Flags: `단순한 도구를 넘어 새로운 경험을 제공합니다.`
- Review choice: remove the weaker A claim, or state the exact relationship between A and B.

## KO-AI-001

- Flags observable clichés such as `새로운 가능성을 열다` and `한 단계 더 나아가`.
- It does not claim that AI authored the sentence.

## KO-LEN-001

- Fires only when both the profile length threshold and a clause-count threshold are exceeded.
- Diagnostic-only: there are many valid long sentences and no context-free split point.

## KO-PARA-001

- Counts sentences inside extracted prose blocks.
- The threshold comes from the active profile.

## KO-END-001

- Flags four or more consecutive sentences with the same recognized ending.
- Diagnostic-only: repeated endings can be deliberate in instructions or legal prose.

## KO-REGISTER-001

- `natural`: flags two repeatedly used register families in one document.
- Other profiles: compares recognized endings with the profile contract.
- Quotes are protected by default.

## KO-CONNECT-001

- Counts sentence-initial `또한`, `따라서`, `하지만`, `그러나`, and related connectives.
- The profile controls the threshold.

## KO-PRON-001

- Flags consecutive sentences that start with the same selected explicit subject.
- Review-only because a repeated subject can resolve ambiguity.

## KO-POLITE-001

- Flags stacked forms such as `안내해 드리도록 하겠습니다`.
- Disabled in the `business` profile because institutional politeness can be intentional.

## KO-META-001

- Flags generic closings such as `도움이 되었기를 바랍니다` in content-oriented profiles.
- Disabled in `business` by default.

## KO-PUNCT-001

- Safely collapses `!!` or more to one `!` only immediately after a Hangul prose ending.
- Does not flag double factorial (`5!!`), shell history expansion (`!!`), or C/JavaScript boolean conversion (`!!x`).

## KO-PUNCT-002

- Reports the third and later exclamation mark at document level.
- Does not auto-replace single marks because calls to action may need them.

## KO-PLURAL-001

- Flags `여러 사용자들`, `모든 항목들`.
- Review-only because removing `들` can require changing the attached particle.

## KO-SPACE-001

- Safely fixes only high-confidence surface forms such as `찾을수있다` → `찾을 수 있다`.
- Ambiguous forms are review-only or skipped. Compounds and names such as `실수없음`, `철수없이`, and `몰수없이` are not split.

## KO-PARSE-001

This engine diagnostic is emitted when structured source cannot be parsed. Fix the source syntax before linting; MuncheKit will not reinterpret the whole file as plain prose.
