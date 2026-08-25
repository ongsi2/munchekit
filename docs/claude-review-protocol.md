# Claude cross-model review protocol

MuncheKit keeps a reproducible review brief instead of treating a one-off model conversation as authority. Run the prompt below with a current Claude model, save the complete answer with the date and model ID, then convert accepted points into rule proposals and hard-negative tests.

## Review prompt

```text
You are reviewing an open-source Korean prose linter, not writing marketing copy.

Product promise:
- Find concrete Korean style problems in Markdown/MDX/HTML/JSX/TSX/JSON.
- Explain the source span and rationale.
- Apply only context-independent safe edits automatically.
- Keep all semantic or register-changing edits review-only.
- Never optimize for AI-detector evasion.

Review the attached rule catalog, architecture, minimal pairs, and protected-content tests.

For every concern, return:
1. affected rule ID or subsystem;
2. a Korean positive example;
3. at least two hard negatives that must not be flagged;
4. whether the action is safe, review, or diagnostic-only;
5. the semantic invariant that could be broken;
6. a measurable acceptance test.

Pay special attention to:
- direct speech, honorific targets, questions, commands, and suggestions;
- physical versus abstract uses of ‘통해’;
- legitimate technical uses of ‘기반’ and ‘진행’;
- adjective/verb conjugation when changing register;
- numbers, negation, tense, modality, product names, URLs, code, and Markdown;
- product copy, technical blogs, business writing, and casual prose as separate genres;
- false positives in clean human prose.

Do not propose a rule based only on “it sounds AI-written.” Name the observable language feature.
```

## Decision record template

```md
### YYYY-MM-DD · model-id

- Proposal:
- Accepted / rejected / deferred:
- Evidence:
- Hard negatives added:
- Rule or test changed:
- Remaining uncertainty:
```

## Acceptance policy

A model suggestion is not merged merely because another model agrees. It must have an observable feature, a bounded genre, hard negatives, and a regression test. A safe-fix proposal also needs an argument for meaning preservation and idempotence.
