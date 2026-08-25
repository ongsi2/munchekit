# Changelog

All notable changes will be documented here. The project follows Semantic Versioning after the first public release.

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
