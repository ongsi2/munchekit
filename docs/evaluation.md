# Evaluation

Natural Korean does not have one reference answer. MuncheKit therefore evaluates detection, safe edits, and optional rewrites separately.

## Dataset slices

1. **Minimal pairs** — one targeted issue and one hard negative per rule.
2. **Clean prose** — text that should remain unchanged; this is the main false-positive set.
3. **Real edits** — author drafts paired with human-approved revisions, with consent and a redistributable license.
4. **Structure attacks** — code fences, URLs, JSX, JSON keys, quotes, placeholders, numbers, Unicode, and overlapping edits.

The repository starts with synthetic minimal pairs and structure tests. It does not yet claim a representative naturalness score.

## Metrics

Detection:

- per-rule precision, recall, and F0.5
- macro precision
- span overlap
- false positives per 1,000 eojeol on clean prose
- genre-specific false-positive rate

Safe fix:

- accepted edit precision
- protected-range mutations
- idempotence
- overlapping-edit conflict handling
- numeric, URL, code, and link-destination preservation

Provider rewrite, blind-rated by Korean editors:

- naturalness (1–5)
- meaning preservation (pass/fail)
- profile match (1–5)
- pairwise preference
- whether an edit was needed at all

Automatic semantic similarity is only supporting evidence. It cannot replace exact checks for a changed number, negation, or modal expression.

## Proposed stable-release gates

These are targets, not current measured claims.

- safe-fix precision ≥ 99.5%
- protected content mutations = 0
- idempotence = 100%
- unnecessary safe fixes on clean documents ≤ 1%
- human preference for provider rewrites ≥ 65%
- provider rewrite meaning-preservation failures < 1%

## Reproduce the current checks

```bash
npm ci
npm run verify
```

`eval/minimal-pairs.jsonl` is exercised by the test suite. Future corpora must record source, license, author grouping, genre, and protected terms per sample. Train/dev/test splits must be separated by author or source—not random sentence shuffling.

## Data licensing

Do not copy arbitrary Korean corpora into this repository. Only include original examples, contributor-approved text, or material whose license permits redistribution. Record the license at row level for external samples.
