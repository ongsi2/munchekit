# Release checklist

MuncheKit releases are created from an annotated `vX.Y.Z` tag after the same version is reflected in the package, engine, schemas, and changelog. The release workflow never publishes from an ordinary branch push.

## 1. Create and prepare GitHub

- [ ] Create the public repository `ongsi2/munchekit` without an extra README, license, or `.gitignore`.
- [ ] Initialize this directory, commit the current files, rename the default branch to `main`, and push it.

  ```bash
  git init
  git add .
  git commit -m "Initial public release"
  git branch -M main
  git remote add origin https://github.com/ongsi2/munchekit.git
  git push -u origin main
  ```

  With an authenticated GitHub CLI and the local `origin` already configured, the equivalent publication and repository settings are:

  ```bash
  gh auth status
  gh repo create ongsi2/munchekit --public \
    --description "Explainable Korean prose linter and guarded copyediting toolkit — 어색한 한국어를 진단하고 최소 교정 후보를 제시하는 CLI/TypeScript library." \
    --disable-wiki
  git push -u origin main
  gh repo edit ongsi2/munchekit \
    --default-branch main \
    --delete-branch-on-merge \
    --enable-issues \
    --enable-wiki=false \
    --enable-squash-merge \
    --enable-merge-commit=false \
    --enable-rebase-merge \
    --add-topic korean \
    --add-topic korean-nlp \
    --add-topic korean-writing \
    --add-topic prose-linter \
    --add-topic copyediting \
    --add-topic localization \
    --add-topic i18n \
    --add-topic typescript \
    --add-topic korean-language \
    --add-topic natural-language-processing \
    --add-topic writing-tools \
    --add-topic linter \
    --add-topic cli
  gh api --method PUT repos/ongsi2/munchekit/private-vulnerability-reporting
  gh api --method PUT repos/ongsi2/munchekit/vulnerability-alerts
  gh api --method PUT repos/ongsi2/munchekit/automated-security-fixes
  ```

  If the repository was created separately, skip only `gh repo create`; keep the push and settings commands. The API calls enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately), Dependabot alerts, and automated security fixes.

- [ ] Confirm that the README badges, rule documentation links, schema URLs, issue tracker, and `SECURITY.md` links all resolve from the public repository.
- [ ] Set the repository description to `Explainable Korean prose linter and guarded copyediting toolkit — 어색한 한국어를 진단하고 최소 교정 후보를 제시하는 CLI/TypeScript library.`
- [ ] Add GitHub topics: `korean`, `korean-nlp`, `korean-writing`, `prose-linter`, `copyediting`, `localization`, `i18n`, `typescript`, `korean-language`, `natural-language-processing`, `writing-tools`, `linter`, and `cli`.
- [ ] Upload `assets/social-preview.png` in the repository Social preview settings; committing the image alone does not set the GitHub card.
- [ ] Enable private vulnerability reporting under the repository security settings.

## 2. Configure npm publication

- [ ] Confirm the package name immediately before release: `npm view munchekit name version` should return `E404` for the first release.
- [ ] Create the `npm` GitHub environment and add a read/write [granular access token](https://docs.npmjs.com/about-access-tokens/) as the `NPM_TOKEN` Actions secret. Scope it as narrowly as the initial publish permits, choose a short expiry, and enable Bypass 2FA only if non-interactive publishing requires it and the account policy allows it.
- [ ] Keep `id-token: write` enabled in `.github/workflows/release.yml` so npm can attach provenance.
- [ ] Protect the `npm` environment with a reviewer if publication should require manual approval.

The workflow runs only for a pushed `v*` tag. Without `NPM_TOKEN`, it performs verification and explicitly skips `npm publish`.

## 3. Verify the release candidate

- [ ] Align the version in `package.json`, `src/engine.ts`, the version-pinned schema URLs, and `CHANGELOG.md`.
- [ ] Run the full local verification.

  ```bash
  npm ci
  npm run verify
  npm run test:package
  npm pack --dry-run
  ```

- [ ] Inspect the packed file list. It must include `dist`, both schemas, both READMEs, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, and `LICENSE`.
- [ ] Confirm that no `.env`, API key, private fixture, coverage output, or unpublished corpus is included.
- [ ] Confirm the v0.2.0 config and report schemas resolve at their tag-pinned URLs after the tag is pushed.

## 4. Tag and publish

- [ ] Commit the final release metadata and push `main`.
- [ ] Create and push the annotated tag.

  ```bash
  git tag -a v0.2.0 -m "MuncheKit v0.2.0"
  git push origin main
  git push origin v0.2.0
  ```

- [ ] Watch the `Release` workflow. Version verification, tests, and build must pass; npm publication must pass when `NPM_TOKEN` is configured, otherwise confirm the explicit skip message.
- [ ] Create a GitHub Release from `v0.2.0` and use the matching changelog section as the release notes.

## 5. Verify the public artifacts

- [ ] Check the registry metadata and provenance.

  ```bash
  npm view munchekit@0.2.0 name version engines repository dist
  npx --yes munchekit@0.2.0 --version
  ```

- [ ] Install `munchekit@0.2.0` in an empty ESM project and an empty CommonJS project.
- [ ] Run both `munchekit --version` and `munche --version` from the installed package.
- [ ] Open every README link from both GitHub and npm, including the config schema and JSON report schema.
- [ ] Verify the GitHub social card and npm search terms after indexing completes.
