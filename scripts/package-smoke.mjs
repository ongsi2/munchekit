#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePackage = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const expectedVersion = sourcePackage.version;
const smokeRoot = mkdtempSync(path.join(tmpdir(), 'munchekit-package-'));
const consumerRoot = path.join(smokeRoot, 'consumer');
const isWindows = process.platform === 'win32';

function executable(name) {
  return isWindows ? `${name}.cmd` : name;
}

function run(command, args, cwd, shell = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], cwd)
    : run(executable('npm'), args, cwd, isWindows);
}

function runInstalledBinary(command, args, cwd) {
  if (!isWindows) return run(command, args, cwd);
  const commandLine = `call "${command}" ${args.map((argument) => `"${argument}"`).join(' ')}`;
  const result = spawnSync(commandLine, {
    cwd,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error([commandLine, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

try {
  const packOutput = runNpm(['pack', '--silent', '--pack-destination', smokeRoot], projectRoot);
  const tarballName = packOutput.split(/\r?\n/u).findLast((line) => line.trim().endsWith('.tgz'))?.trim();
  if (!tarballName) throw new Error(`npm pack did not return a tarball name:\n${packOutput}`);
  const tarballPath = path.join(smokeRoot, tarballName);

  mkdirSync(consumerRoot);
  writeFileSync(path.join(consumerRoot, 'package.json'), '{"private":true}\n', 'utf8');
  runNpm(
    ['install', '--prefix', consumerRoot, '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    smokeRoot,
  );

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { analyze, buildLearnedStyleProfile, createReviewSession, ENGINE_VERSION, validateRewriteReviewArtifact } from 'munchekit'; const result = analyze('가지런한 치아는 서두르지 않고 만듭니다.', { profile: 'web' }); if (ENGINE_VERSION !== ${JSON.stringify(expectedVersion)} || !result.diagnostics.some((item) => item.ruleId === 'KO-ATTACH-001') || typeof buildLearnedStyleProfile !== 'function' || typeof createReviewSession !== 'function' || typeof validateRewriteReviewArtifact !== 'function') process.exit(1)`,
    ],
    consumerRoot,
  );
  run(
    process.execPath,
    [
      '--eval',
      `const { analyze, buildLearnedStyleProfile, createReviewSession, ENGINE_VERSION, validateRewriteReviewArtifact } = require('munchekit'); const result = analyze('가지런한 치아는 서두르지 않고 만듭니다.', { profile: 'web' }); if (ENGINE_VERSION !== ${JSON.stringify(expectedVersion)} || !result.diagnostics.some((item) => item.ruleId === 'KO-ATTACH-001') || typeof buildLearnedStyleProfile !== 'function' || typeof createReviewSession !== 'function' || typeof validateRewriteReviewArtifact !== 'function') process.exit(1)`,
    ],
    consumerRoot,
  );
  run(
    process.execPath,
    [
      '--eval',
      "const fs=require('node:fs'); for (const id of ['munchekit/schema/munche.schema.json','munchekit/schema/munche-report.schema.json','munchekit/schema/munche-feedback.schema.json','munchekit/schema/munche-review-decisions.schema.json','munchekit/schema/munche-rewrite-result.schema.json']) JSON.parse(fs.readFileSync(require.resolve(id),'utf8'))",
    ],
    consumerRoot,
  );

  for (const binary of ['munchekit', 'munche']) {
    const output = runInstalledBinary(
      path.join(consumerRoot, 'node_modules', '.bin', executable(binary)),
      ['--version'],
      consumerRoot,
    );
    if (output !== expectedVersion) throw new Error(`${binary} returned unexpected version: ${output}`);
  }

  for (const relativePath of [
    'README.md',
    'README.en.md',
    'SECURITY.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'docs/learning.md',
    'docs/rules.md',
  ]) {
    const installedPath = path.join(consumerRoot, 'node_modules', 'munchekit', relativePath);
    if (!existsSync(installedPath)) throw new Error(`Packed artifact is missing ${relativePath}`);
  }

  const installedPackage = JSON.parse(
    readFileSync(path.join(consumerRoot, 'node_modules', 'munchekit', 'package.json'), 'utf8'),
  );
  process.stdout.write(`packed ${installedPackage.name}@${installedPackage.version}: ESM, CJS, schemas, docs, and both bins OK\n`);
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
