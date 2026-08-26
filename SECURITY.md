# Security policy

## Supported versions

Until 1.0, only the latest published minor version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for API-key exposure, path traversal, unsafe file writes, prompt-injection bypasses, or dependency vulnerabilities with a working exploit. Use GitHub private vulnerability reporting for `ongsi2/munchekit` when the repository is public.

Include the affected version, minimal reproduction, impact, and any suggested mitigation. Do not include a real API key or private document.

## Secrets and network behavior

- `lint`, `check`, `fix`, `review`, and `learn` do not make network requests.
- The CLI `rewrite` command reads `ANTHROPIC_API_KEY` from the environment and sends parser-approved Korean segments plus excerpt-free finding metadata to the configured Anthropic-compatible endpoint. In `--mode natural`, it also sends a bounded selection of approved `before → after` examples and their style metadata. Source syntax and protected values remain local. Library callers pass credentials directly to their provider adapter.
- The library API treats entries supplied through `RewriteStyleMemory.approvedExamples` as already human-approved. Exact `before` matches may authorize their corresponding `after`, so callers must not populate this trust boundary from unreviewed provider output.
- Provider URLs require HTTPS by default, embedded credentials and redirects are rejected, and requests/responses have time and size limits.
- The default endpoint is `https://api.anthropic.com`. A custom `--base-url` receives both the API key and rewrite segments, so configure only an endpoint you trust.
- MuncheKit never writes the API key to reports or config files.
- Local pretty, JSON, and SARIF reports can include nearby source text in diagnostic `excerpt` fields. Review or redact reports before sharing them; excerpts are not included in provider requests.
- The default approval-memory store, `.munche/feedback.jsonl`, can contain source snippets, provider proposals, final copy, rejected proposals, reason tags, locked claims, and source paths/ranges. Treat it as private source data.
- A rewrite-result file created with `--result-file` or redirected `rewrite --output json` contains source excerpts and the full provider candidate. Protect and delete it according to the same policy as the source file. `--result-file` uses exclusive UTF-8 creation and does not overwrite an existing path.
- On the first write to the default store, MuncheKit creates `.munche/.gitignore` with the directory contents ignored. An existing ignore file is preserved, so verify that it covers `feedback.jsonl`; this does not untrack already committed files. A custom `--feedback-file` path is not ignored automatically.
- Use a dedicated, scoped key and review your provider's retention policy before sending sensitive content.

## File safety

- CLI source writes reject symbolic links, files outside the working root unless explicitly allowed, source files larger than 5 MiB, and batches larger than 2,000 files. Read-only rewrite-result imports allow up to 32 MiB because the JSON carries bounded source excerpts, changes, and a duplicated candidate payload.
- Existing files are opened without following links, their expected contents and identity are rechecked, and replacement is staged in a synced same-directory temporary file; `munche init` uses exclusive creation.
- Feedback paths must remain inside the workspace and symbolic-link traversal is rejected. The feedback store is append-only, uses an adjacent single-writer lock, de-duplicates deterministic record IDs, and refuses an append before it would cross 16 MiB.
- JSON values and generic program strings can be machine-facing, so their local fixes are always marked `review` rather than applied by the default safe-fix command.
- `preservePatterns` rejects common catastrophic-backtracking shapes and is bounded to 200 characters per pattern and 2,000 entries. Treat configuration as trusted input; prefer literal `preserveTerms` for untrusted values.
