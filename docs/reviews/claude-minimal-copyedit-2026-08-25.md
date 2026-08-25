# Claude cross-review: minimum copyediting failure — 2026-08-25

This patch received a read-only second-model review through Claude Code using the `sonnet` alias, high effort, plan permission mode, safe mode, `Read`/`Glob`/`Grep` only, and no persisted session. The reviewer inspected the rule engine, rewrite boundary, schemas, evaluation fixtures, tests, and public documentation. The maintainer reproduced each relevant behavior locally before accepting it.

## Reproduced failure

```text
Source: 가지런한 치아는 서두르지 않고 만듭니다.
Expected minimum repair: 가지런한 치아를 만들기 위해 서두르지 않습니다.
```

The released engine returned no diagnostics. The rewrite guard then accepted source-absent claims such as `건강한` or `안전하게`, while rejecting the expected repair. The rejection happened because the source form `않고` was not recognized as a protected negation but the candidate form `않습니다` was.

## Findings and dispositions

| Review finding | Disposition in v0.2.0 |
|---|---|
| Add a narrow review-only rule for a result noun marked with `은/는` before a negated manner clause and active creation verb | Accepted as `KO-ATTACH-001`; the initial allowlist is limited to dental outcomes (`치아`, `치열`, `교합`) with finite forms of `만들다`, and both interpretations are explicit suggestions rather than automatic fixes |
| Make the purpose-clause repair available to the provider | Accepted; overlapping findings now carry every suggestion message, risk, and exact replacement into that segment's prompt |
| Limit the provider to particles, endings, connectors, order, and clear redundancy | Tightened further: non-exact edits preserve shared content-word order; only a deterministic local replacement may authorize reordering. New attributes, benefits, evidence, expertise, actors, and medical promises are forbidden |
| Keep negation and modality editable but compare canonical meaning anchors | Tightened: anchors are bound to the neighboring predicate and relation class. The exact local purpose suggestion authorizes its own `않고 → 않습니다` transition; deleting, moving, or changing the relation otherwise is rejected |
| Reject source-absent content words independently of the character-change ratio | Accepted; candidate lexemes must occur in the source or an overlapping deterministic replacement, and `--max-change 1` cannot bypass this guard |
| Use two leading syllables as a generic lexical anchor | Modified; explicit inflection aliases, particle stripping, and overlapping deterministic replacements reduce collisions and handle `만듭니다 → 만들기` directly |
| Treat purpose/causal bridges as globally allowed | Rejected; `때문에`, `위해`, and `위하여` can introduce a new relation. The exact `KO-ATTACH-001` replacement authorizes its own `위해`; other insertions are rejected |
| Present `서두르지 않기에 보다 가지런한 치아가 완성됩니다.` as an equally safe default | Rejected for automatic/provider output; it adds stronger causality, an unstated comparison (`보다`), and a voice change. It remains a human-authored alternative when those changes are intentional |
| Accept fenced or prose-wrapped JSON from the model | Rejected; provider output is now one strict JSON object with a closed response shape |

## Regression evidence required by the patch

- The exact source emits `KO-ATTACH-001` under local linting and is a `warning` in the `web` profile.
- The first suggestion reconstructs the exact expected sentence, but `fix` leaves the source untouched because the interpretation is review-only.
- A stub provider can return the expected repair under the default 0.35 change budget.
- The exact purpose suggestion authorizes `않고 → 않습니다`; removing negation, moving it to another predicate, or introducing an unapproved causal ending does not pass.
- `건강한`, `안전하게`, `정밀한 진단`, `오래 유지되는`, and the stronger causal/comparative alternative are rejected even with a 1.0 change budget.
- Actor subjects, passives, explicit objects, unrelated verbs, and unknown contrastive topics remain clean.
- The packed ESM/CJS artifact must detect the new rule, not merely contain its metadata.

This review is evidence of an independent design challenge, not proof that provider output preserves meaning. All provider rewrites remain review-only.
