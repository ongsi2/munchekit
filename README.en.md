# MuncheKit

> An explainable Korean prose linter and guarded copyediting toolkit for product copy, docs, and localization files.

[한국어](./README.md) · [Rules](./docs/rules.md) · [Approval-backed style memory](./docs/learning.md) · [Architecture](./docs/architecture.md) · [Minimal-copyedit review](./docs/reviews/claude-minimal-copyedit-2026-08-25.md) · [Contributing](./CONTRIBUTING.md)

MuncheKit finds Korean copy inside Markdown, MDX, HTML, JSX, TSX, and JSON, then reports the exact span, rationale, confidence, and remediation risk. It is closer to **ESLint for Korean product copy** than to an opaque “AI humanizer.”

For example, the `web` profile flags `가지런한 치아는 서두르지 않고 만듭니다.` and offers the review candidate `가지런한 치아를 만들기 위해 서두르지 않습니다.` It does not auto-apply that interpretation. The default rewriter rejects source-absent claims such as `건강한`, `안전한`, `정밀한 진단`, or `오래 유지되는`, even if the character-change budget is raised to 100%.

Node.js 20.19.0 or newer is required.

The npm package is not published yet. The public GitHub v0.2.0 source release can still be run directly or pinned in a project:

```bash
npx --yes github:ongsi2/munchekit#v0.2.0 check messages/ko.json --profile web
npm install --save-dev github:ongsi2/munchekit#v0.2.0
npx munche lint "content/**/*.md" --output sarif
npx munche fix post.md             # preview safe edits
npx munche fix post.md --write     # apply safe edits
```

After `munchekit` v0.2.0 is published to npm, the GitHub package spec can be shortened to `munchekit`.

```ts
import { analyze, applyFixes } from 'munchekit';

const source = '결과가 저장되어진다!!';
const report = analyze(source, { profile: 'web' });
const fixed = applyFixes(source, report);

console.log(fixed.text); // 결과가 저장된다!
```

## Design promises

- Deterministic local linting by default; no network calls from `lint`, `check`, or `fix`.
- Local pretty, JSON, and SARIF reports may contain nearby source text in `excerpt`; inspect reports before sharing them. That field is not sent to the rewrite provider.
- Parsers isolate prose from code, URLs, imports, markup, and link destinations.
- Safe edits and review-only suggestions are separate.
- JSON values and generic JavaScript/TypeScript strings are always review-only because they may be lookup keys, regexes, or protocol payloads. Within JavaScript/TypeScript sources, only explicit user-facing JSX surfaces retain safe fixes.
- Findings have stable rule IDs, UTF-16 ranges, source locations, rationales, and confidence values.
- Parse failures stop analysis instead of silently treating source code as prose.
- The optional Claude rewriter is a minimum-copyedit path, not a copy-creation mode. Shared content-word order is preserved unless an exact local suggestion authorizes a reordering. Source syntax and exact protected values stay local; editable negation/modal anchors are compared by normalized stem, neighboring predicate, and relation class unless an exact local suggestion authorizes the transition.
- Reconstruction rejects changed segment IDs, strict-JSON violations, new content words, undiagnosed content deletion, changed invariants or parse structure, and excessive edits.

Supported profiles are `natural`, `web`, `tech-blog`, `business`, and `thmm-tech`. See the [Korean README](./README.md) for configuration, suppression directives, privacy details, and the roadmap.

`munche init` pins the v0.2.0 configuration schema at
`https://raw.githubusercontent.com/ongsi2/munchekit/v0.2.0/schema/munche.schema.json`.
The machine-readable lint/check contract is published as the [MuncheKit JSON report schema](./schema/munche-report.schema.json); guarded rewrite artifacts use the [rewrite result schema](./schema/munche-rewrite-result.schema.json).

## What this is not

MuncheKit does not determine whether a human or AI wrote a document, and it is not designed to evade AI detectors. It evaluates concrete properties of the text regardless of authorship. It also does not replace Korean spelling/grammar checkers or professional fact, legal, or medical review.

## Approval-backed style memory

MuncheKit can reuse human-approved copy through a `review → learn → rewrite --mode natural` loop. This is not model fine-tuning or autonomous self-training. It stores approved or human-edited `before → after` pairs locally and retrieves a bounded set of relevant examples when natural rewrite runs.

This feature is currently part of the **Unreleased** changes on `main`; it is not present in the `v0.2.0` tag. To try it before the next release, install `github:ongsi2/munchekit#main` and run the commands below through `npx munche ...`.

`--profile` selects a built-in lint-rule preset such as `web`; `--style-profile` names a project- or brand-specific feedback namespace such as `gounseon`.

```bash
munche review --style-profile gounseon \
  --before "가지런한 치아는 서두르지 않고 만듭니다." \
  --after "가지런한 치아를 만들기 위해 서두르지 않습니다."

munche review page.html --profile web --style-profile gounseon
munche learn --style-profile gounseon

ANTHROPIC_API_KEY=... munche rewrite page.html \
  --profile web --mode natural --style-profile gounseon --model <claude-model-id> \
  --result-file rewrite-result.json
munche review page.html --style-profile gounseon \
  --rewrite-result rewrite-result.json --write
```

Natural rewrite rejects direct `--write`. Its guarded JSON result must pass through `review --rewrite-result`; only human-accepted or edited ranges are applied and learned. Non-interactive review uses a JSON session followed by a decision document; see the [complete Korean workflow](./docs/learning.md).

The default store is `.munche/feedback.jsonl`. It may contain source snippets, proposals, final copy, rejection examples, tags, and source locations. MuncheKit creates `.munche/.gitignore` for the default store, but custom `--feedback-file` paths need their own ignore policy. `review` and `learn` stay local; natural rewrite sends selected approved examples along with rewrite segments to the configured provider.

## Optional Claude rewrite

```bash
ANTHROPIC_API_KEY=... \
  npx --yes github:ongsi2/munchekit#v0.2.0 rewrite post.md --model <claude-model-id>
```

No model is hard-coded because model IDs change. A guard-accepted result writes its exact `before → after` audit to stderr and keeps the final text as the only stdout payload. Minimal mode changes a file only with explicit `--write`; natural mode rejects direct writes and hands a JSON artifact to `review --rewrite-result` for human approval. HTTPS is required, redirects are rejected, and response time and size are bounded. Raising `--max-change` never disables guards by itself. An exact approved `before` may authorize only its corresponding `after` at sentence level; literal, numeric, source-structure, and change-budget guards still apply. Every accepted candidate remains review-only.

The default endpoint is `https://api.anthropic.com`. `--base-url <HTTPS URL>` targets a compatible service; use only an endpoint you trust because it receives the API key and rewrite segments.

The [minimal-copyedit Claude review](./docs/reviews/claude-minimal-copyedit-2026-08-25.md) documents the read-only protocol, reproduced failure, and dispositions. The [external Korean-style rule review](./docs/reviews/solo-skills-humanize-korean-2026-08-25.md) records which ideas from `solo-skills` were adopted, constrained, deferred, or rejected. Agreement from another model or rule pack never promotes a rule to `safe` on its own.

## Status

This is an early rule pack. Precision and protected-content invariants matter more than the number of patterns. Public evaluation methodology is documented in [docs/evaluation.md](./docs/evaluation.md).

MIT © 2026 ongsi2
