# Security policy

## Supported versions

Until 1.0, only the latest published minor version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for API-key exposure, path traversal, unsafe file writes, prompt-injection bypasses, or dependency vulnerabilities with a working exploit. Use GitHub private vulnerability reporting for `ongsi2/munchekit` when the repository is public.

Include the affected version, minimal reproduction, impact, and any suggested mitigation. Do not include a real API key or private document.

## Secrets and network behavior

- `lint`, `check`, and `fix` do not make network requests.
- The CLI `rewrite` command reads `ANTHROPIC_API_KEY` from the environment and sends only parser-approved Korean segments plus excerpt-free finding metadata to the configured Anthropic-compatible endpoint. Source syntax and protected values remain local. Library callers pass credentials directly to their provider adapter.
- Provider URLs require HTTPS by default, embedded credentials and redirects are rejected, and requests/responses have time and size limits.
- The default endpoint is `https://api.anthropic.com`. A custom `--base-url` receives both the API key and rewrite segments, so configure only an endpoint you trust.
- MuncheKit never writes the API key to reports or config files.
- Local pretty, JSON, and SARIF reports can include nearby source text in diagnostic `excerpt` fields. Review or redact reports before sharing them; excerpts are not included in provider requests.
- Use a dedicated, scoped key and review your provider's retention policy before sending sensitive content.

## File safety

- CLI writes reject symbolic links, files outside the working root unless explicitly allowed, files larger than 5 MiB, and batches larger than 2,000 files.
- Existing files are opened without following links and their identity is checked before truncation; `munche init` uses exclusive creation.
- JSON values and generic program strings can be machine-facing, so their local fixes are always marked `review` rather than applied by the default safe-fix command.
- `preservePatterns` rejects common catastrophic-backtracking shapes and is bounded to 200 characters per pattern and 2,000 entries. Treat configuration as trusted input; prefer literal `preserveTerms` for untrusted values.
