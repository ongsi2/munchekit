# Changelog

All notable changes will be documented here. The project follows Semantic Versioning after the first public release.

## [Unreleased]

### Added

- Exact `before → after` audit output for accepted provider rewrites.
- `KO-ATTACH-001` review candidates across layout-only HTML/JSX `<br>` tags while preserving the original tag spelling and whitespace.
- A documented review of the selectively adopted and rejected ideas from `bam-bam-2/solo-skills` Korean copyediting guidance.
- `review` and `learn` commands for recording accepted, edited, rejected, and kept decisions in project- or brand-specific style profiles.
- Approval-backed natural rewrite memory using bounded, relevant `before → after` examples rather than model fine-tuning.
- Strict JSON schemas for persisted feedback records and non-interactive review decisions.
- A guarded rewrite-result JSON artifact, exclusive UTF-8 `--result-file` output, and `review --rewrite-result` handoff for approving, editing, rejecting, and selectively applying natural proposals.

### Changed

- Separate built-in lint `--profile` presets from user-defined `--style-profile` feedback namespaces.
- Reject `--write` in natural rewrite mode so model output must pass an explicit human approval step.
- Bind non-interactive decisions to a session hash covering the engine, profile, findings, and proposal contents.
- Keep the default feedback store at `.munche/feedback.jsonl` and create a private `.munche/.gitignore` on first write.

### Fixed

- Normalize HTML blocks after trimming fallback prose ranges, preventing duplicate rewrite segments and overlapping no-op edits on indented or `<br>`-split markup.
- Coalesce any strictly overlapping rewrite ranges as a final defensive invariant without joining merely adjacent sentences.

## [0.2.0] - 2026-08-25

### Added

- `KO-ATTACH-001`, a narrow review-only rule for dental-outcome topics that delay the purpose relation, including exact purpose and manner candidates.
- Exact review replacements in pretty CLI output and segment-local deterministic suggestions in provider prompts.
- Regression coverage for the dental-copy failure, hard negatives, protected markup boundaries, and packed ESM/CJS artifacts.

### Changed

- Reframed optional rewriting as minimum copyediting: particles, endings, connectors, and diagnosed redundancy take priority; content-word reordering requires an exact local replacement.
- Split exact protected literals from semantic negation/modality anchors, allowing `않고 → 않습니다` while still rejecting polarity changes.
- Preserve causal/conditional relations, tense, subject/object particle roles, and sentence force unless an exact local replacement authorizes the delta.
- Reject provider candidates that add source-absent content words or remove content outside diagnosed ranges, even when `maxChangedCharsRatio` is `1`.
- Require one strict, closed-shape JSON object from rewrite providers.
- Describe the package as a guarded copyediting toolkit instead of claiming generally safe rewriting.

## [0.1.0] - 2026-08-25

### Added

- Format-aware Korean copy extraction for plain text, Markdown/MDX, JSON/JSONC, HTML, JSX, and TSX.
- Explainable rule engine with stable finding schema and five style profiles.
- Pretty, JSON, and SARIF reporters.
- Conservative safe-fix pipeline with overlap, idempotence, and change-limit guards.
- Optional Anthropic Messages API provider with protected-token and invariant verification.
- CLI commands: `lint`, `check`, `fix`, `rewrite`, `rules`, `explain`, and `init`.
- Rule-level source suppression and public minimal-pair fixtures.

[0.2.0]: https://github.com/ongsi2/munchekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ongsi2/munchekit/releases/tag/v0.1.0
