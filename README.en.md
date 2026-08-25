# MuncheKit

> An explainable Korean prose linter and guarded copyediting toolkit for product copy, docs, and localization files.

[한국어](./README.md) · [Rules](./docs/rules.md) · [Architecture](./docs/architecture.md) · [Minimal-copyedit review](./docs/reviews/claude-minimal-copyedit-2026-08-25.md) · [Contributing](./CONTRIBUTING.md)

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
The machine-readable CLI contract is published as the [MuncheKit JSON report schema](./schema/munche-report.schema.json).

## What this is not

MuncheKit does not determine whether a human or AI wrote a document, and it is not designed to evade AI detectors. It evaluates concrete properties of the text regardless of authorship. It also does not replace Korean spelling/grammar checkers or professional fact, legal, or medical review.

## Optional Claude rewrite

```bash
ANTHROPIC_API_KEY=... \
  npx --yes github:ongsi2/munchekit#v0.2.0 rewrite post.md --model <claude-model-id>
```

No model is hard-coded because model IDs change. The command previews output unless `--write` is explicitly supplied. HTTPS is required, redirects are rejected, and response time and size are bounded. Raising `--max-change` never disables the content-word, literal, negation/modality, tense, particle-role, or sentence-force guards. Even a candidate that passes every guard remains review-only.

The default endpoint is `https://api.anthropic.com`. `--base-url <HTTPS URL>` targets a compatible service; use only an endpoint you trust because it receives the API key and rewrite segments.

The [minimal-copyedit Claude review](./docs/reviews/claude-minimal-copyedit-2026-08-25.md) documents the read-only protocol, reproduced failure, and dispositions. Agreement from another model never promotes a rule to `safe` on its own.

## Status

This is an early rule pack. Precision and protected-content invariants matter more than the number of patterns. Public evaluation methodology is documented in [docs/evaluation.md](./docs/evaluation.md).

MIT © 2026 ongsi2
