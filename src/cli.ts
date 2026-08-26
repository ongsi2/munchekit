#!/usr/bin/env node

import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { diffLines } from 'diff';
import fg from 'fast-glob';
import pc from 'picocolors';

import { numberOption } from './cli-options.js';
import { DEFAULT_CONFIG_FILE, exampleConfig, loadConfig } from './config.js';
import { analyze, ENGINE_VERSION } from './engine.js';
import { applyFixes } from './fixes.js';
import { appendFeedback, readFeedback } from './feedback.js';
import { buildLearnedStyleProfile, buildLearningPromptContext } from './learning.js';
import { profiles } from './profiles.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { formatRewriteChanges, jsonReport, prettyReport, sarifReport } from './reporters.js';
import { rewrite } from './rewrite.js';
import {
  createReviewSession,
  createRewriteReviewSession,
  hashReviewSource,
  resolveReviewSession,
  validateReviewDecisionDocument,
  validateRewriteReviewArtifact,
} from './review.js';
import { ruleCatalog } from './rules.js';
import type { CopyFeedbackInput } from './feedback.js';
import type { ReviewResolution, ReviewSession } from './review.js';
import type {
  AnalysisReport,
  AnalyzeOptions,
  MuncheConfig,
  ProfileName,
  RewriteMode,
  SourceFormat,
} from './types.js';

const HELP = `MuncheKit ${ENGINE_VERSION} — 설명 가능한 한국어 문체 린터

사용법
  munche lint [경로/글롭...]       진단 결과를 출력합니다.
  munche check [경로/글롭...]      경고가 있으면 실패하는 CI 모드입니다.
  munche fix [경로/글롭...]        안전한 수정의 diff를 봅니다.
  munche rewrite <파일>            Claude로 윤문한 뒤 보존 조건을 검사합니다.
  munche review <파일>             제안을 승인·수정·거절하고 문체 기억에 저장합니다.
  munche learn                     승인 기록으로 학습된 문체 요약을 봅니다.
  munche explain [규칙 ID]         규칙 설명을 봅니다.
  munche rules                     전체 규칙을 나열합니다.
  munche init                      .munche.json 예시를 만듭니다.

주요 옵션
  --profile <이름>                 natural | web | tech-blog | business | thmm-tech
  --style-profile <ID>             승인 기록을 분리할 프로젝트·브랜드 문체 ID
  --mode <모드>                    rewrite의 minimal | natural (기본 minimal)
  --feedback-file <경로>           작업 루트 안의 피드백 JSONL 경로
  --decisions <파일>               비대화형 review 결정 JSON 파일
  --rewrite-result <파일>          natural rewrite JSON 결과를 review로 가져옵니다.
  --result-file <파일>             rewrite JSON 결과를 UTF-8 파일로 안전하게 저장합니다.
  --output <형식>                  pretty | json | sarif (기본 pretty)
  --source-format <형식>           auto | plain | markdown | mdx | json | html | tsx
  --config <파일>                  설정 파일 경로
  --max-warnings <수>              허용할 warning 수
  --write                          fix/review 및 minimal rewrite 결과를 원본에 씁니다.
  --model <모델 ID>                rewrite에서 사용할 Claude 모델(필수)
  --base-url <HTTPS URL>           Anthropic 호환 endpoint(기본 api.anthropic.com)
  --max-change <0..1>              최대 변경 비율
  --allow-outside-root             작업 루트 밖의 명시 경로를 허용합니다.
  --no-color                       색을 끕니다.
  -h, --help                       도움말
  -v, --version                    버전

예시
  npx munchekit check messages/ko.json --profile web
  npx munchekit lint "content/**/*.md" --output sarif
  npx munchekit fix post.md --write
  npx munchekit review page.html --profile web --style-profile gounseon
  npx munchekit review --style-profile gounseon --before "기존" --after "최종"
  npx munchekit learn --style-profile gounseon
  ANTHROPIC_API_KEY=... npx munchekit rewrite post.md --model <model-id>
  ANTHROPIC_API_KEY=... npx munchekit rewrite post.md --mode natural --style-profile gounseon --model <model-id> --result-file rewrite-result.json
  npx munchekit review post.md --style-profile gounseon --rewrite-result rewrite-result.json --write
`;

const outputFormats = new Set(['pretty', 'json', 'sarif']);
const sourceFormats = new Set<SourceFormat>(['auto', 'plain', 'markdown', 'mdx', 'json', 'html', 'tsx']);

interface CliValues {
  help?: boolean;
  version?: boolean;
  profile?: string;
  'style-profile'?: string;
  mode?: string;
  'feedback-file'?: string;
  decisions?: string;
  'rewrite-result'?: string;
  'result-file'?: string;
  before?: string;
  proposal?: string;
  after?: string;
  decision?: string;
  reason?: string[];
  lock?: string[];
  rule?: string[];
  output?: string;
  'source-format'?: string;
  config?: string;
  'max-warnings'?: string;
  write?: boolean;
  model?: string;
  'base-url'?: string;
  'max-change'?: string;
  'allow-outside-root'?: boolean;
  'no-color'?: boolean;
}

function parseCli(args: string[]): { command: string; paths: string[]; values: CliValues } {
  const first = args[0];
  const commands = new Set(['lint', 'check', 'fix', 'rewrite', 'review', 'learn', 'explain', 'rules', 'init']);
  const hasCommand = Boolean(first && commands.has(first));
  const command = hasCommand && first ? first : 'lint';
  const commandArgs = hasCommand ? args.slice(1) : args;
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      profile: { type: 'string' },
      'style-profile': { type: 'string' },
      mode: { type: 'string' },
      'feedback-file': { type: 'string' },
      decisions: { type: 'string' },
      'rewrite-result': { type: 'string' },
      'result-file': { type: 'string' },
      before: { type: 'string' },
      proposal: { type: 'string' },
      after: { type: 'string' },
      decision: { type: 'string' },
      reason: { type: 'string', multiple: true },
      lock: { type: 'string', multiple: true },
      rule: { type: 'string', multiple: true },
      output: { type: 'string' },
      'source-format': { type: 'string' },
      config: { type: 'string' },
      'max-warnings': { type: 'string' },
      write: { type: 'boolean' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'max-change': { type: 'string' },
      'allow-outside-root': { type: 'boolean' },
      'no-color': { type: 'boolean' },
    },
  });
  return { command, paths: parsed.positionals, values: parsed.values as CliValues };
}

function rewriteMode(value: string | undefined): RewriteMode {
  const mode = value ?? 'minimal';
  if (mode !== 'minimal' && mode !== 'natural') throw new Error(`Unknown rewrite mode: ${mode}`);
  return mode;
}

function requiredStyleProfile(values: CliValues): string {
  const styleId = values['style-profile']?.trim();
  if (!styleId) throw new Error('--style-profile <ID>가 필요합니다. 예: --style-profile gounseon');
  return styleId;
}

function feedbackPathOptions(values: CliValues, cwd: string): { workspaceRoot: string; filePath?: string } {
  return {
    workspaceRoot: cwd,
    ...(values['feedback-file'] ? { filePath: values['feedback-file'] } : {}),
  };
}

async function pathKind(candidate: string): Promise<'file' | 'directory' | 'symlink' | 'missing'> {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'missing';
  } catch {
    return 'missing';
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalFile(filePath: string, root: string, allowOutsideRoot: boolean): Promise<string> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error(`심볼릭 링크는 검사하지 않습니다: ${filePath}`);
  if (!info.isFile()) throw new Error(`일반 파일이 아닙니다: ${filePath}`);
  const canonical = await realpath(filePath);
  if (!allowOutsideRoot && !isInside(root, canonical)) {
    throw new Error(`작업 루트 밖의 파일입니다: ${filePath} (--allow-outside-root로 명시 허용)`);
  }
  return canonical;
}

async function canonicalNewJsonFile(filePath: string, cwd: string, allowOutsideRoot: boolean): Promise<string> {
  if (!filePath.trim() || filePath.includes('\0')) throw new Error('--result-file에는 비어 있지 않은 경로가 필요합니다.');
  const root = await realpath(cwd);
  const requested = path.resolve(cwd, filePath);
  const parent = await realpath(path.dirname(requested));
  const candidate = path.join(parent, path.basename(requested));
  if (!allowOutsideRoot && !isInside(root, candidate)) {
    throw new Error(`작업 루트 밖의 결과 파일입니다: ${filePath} (--allow-outside-root로 명시 허용)`);
  }
  if (path.extname(candidate).toLowerCase() !== '.json') throw new Error('--result-file 경로는 .json으로 끝나야 합니다.');
  try {
    await lstat(candidate);
    throw new Error(`결과 파일이 이미 존재합니다: ${candidate}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return candidate;
}

async function writeNewPrivateFile(filePath: string, text: string): Promise<void> {
  let handle;
  let created = false;
  try {
    handle = await open(filePath, 'wx', 0o600);
    created = true;
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close();
    handle = undefined;
    if (created) await unlink(filePath).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readExistingFile(filePath: string, maximumBytes = 5 * 1024 * 1024): Promise<string> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`안전하게 읽을 수 없는 파일입니다: ${filePath}`);
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`읽는 동안 파일이 바뀌었습니다: ${filePath}`);
    if (opened.size > maximumBytes) {
      throw new Error(`파일이 ${String(Math.floor(maximumBytes / (1024 * 1024)))} MiB 제한을 넘습니다: ${filePath}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonDocument(text: string): unknown {
  return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text) as unknown;
}

async function writeExistingFile(filePath: string, text: string, expectedText?: string): Promise<void> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`안전하게 쓸 수 없는 파일입니다: ${filePath}`);
  if (before.nlink > 1) throw new Error(`하드 링크된 파일은 원자적 교체로 쓰지 않습니다: ${filePath}`);
  const readHandle = await open(filePath, 'r');
  try {
    const opened = await readHandle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`쓰는 동안 파일이 바뀌었습니다: ${filePath}`);
    if (expectedText !== undefined && await readHandle.readFile('utf8') !== expectedText) {
      throw new Error(`읽은 뒤 파일 내용이 바뀌었습니다: ${filePath}`);
    }
  } finally {
    await readHandle.close();
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.munche-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const temporary = await open(temporaryPath, 'wx', before.mode & 0o777);
    temporaryCreated = true;
    try {
      await temporary.writeFile(text, 'utf8');
      if (process.platform !== 'win32') await temporary.chmod(before.mode & 0o777);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    const current = await lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error(`교체하기 전에 파일이 바뀌었습니다: ${filePath}`);
    }
    if (expectedText !== undefined && await readExistingFile(filePath) !== expectedText) {
      throw new Error(`교체하기 전에 파일 내용이 바뀌었습니다: ${filePath}`);
    }
    await rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

async function collectFiles(
  inputs: string[],
  config: MuncheConfig,
  cwd: string,
  allowOutsideRoot: boolean,
): Promise<string[]> {
  const root = await realpath(cwd);
  const requested = inputs.length ? inputs : (config.files ?? []);
  const direct: string[] = [];
  const patterns: string[] = [];
  for (const input of requested) {
    const absolute = path.resolve(cwd, input);
    const kind = await pathKind(absolute);
    if (kind === 'file') direct.push(absolute);
    else if (kind === 'directory') patterns.push(`${slash(path.relative(cwd, absolute))}/**/*.{md,mdx,txt,json,jsonc,html,htm,js,jsx,mjs,cjs,ts,tsx,mts,cts}`);
    else if (kind === 'symlink') throw new Error(`심볼릭 링크는 검사하지 않습니다: ${absolute}`);
    else patterns.push(slash(input));
  }
  const matched = patterns.length
    ? await fg(patterns, {
        cwd,
        absolute: true,
        onlyFiles: true,
        unique: true,
        dot: false,
        followSymbolicLinks: false,
        ignore: config.ignore ?? [],
      })
    : [];
  const candidates = [...new Set([...direct, ...matched].map((file) => path.resolve(file)))].sort();
  if (candidates.length > 2_000) throw new Error(`파일 수가 2,000개 제한을 넘습니다: ${String(candidates.length)}개`);
  return Promise.all(candidates.map((file) => canonicalFile(file, root, allowOutsideRoot)));
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function analyzeOptions(filePath: string | undefined, config: MuncheConfig, values: CliValues): AnalyzeOptions {
  const profile = values.profile ?? config.profile ?? 'natural';
  if (!(profile in profiles)) throw new Error(`Unknown profile: ${profile}`);
  const sourceFormat = values['source-format'] ?? 'auto';
  if (!sourceFormats.has(sourceFormat as SourceFormat)) throw new Error(`Unknown source format: ${sourceFormat}`);
  return {
    ...(filePath ? { filePath } : {}),
    profile: profile as ProfileName,
    format: sourceFormat as SourceFormat,
    ...(config.rules ? { rules: config.rules } : {}),
    ...(config.preserveTerms ? { preserveTerms: config.preserveTerms } : {}),
    ...(config.preservePatterns ? { preservePatterns: config.preservePatterns } : {}),
    ...(config.ignoreQuotes !== undefined ? { ignoreQuotes: config.ignoreQuotes } : {}),
  };
}

function renderReports(reports: AnalysisReport[], output: string, color: boolean): string {
  if (!outputFormats.has(output)) throw new Error(`Unknown output format: ${output}`);
  if (output === 'json') return jsonReport(reports);
  if (output === 'sarif') return sarifReport(reports);
  return reports.map((report) => prettyReport(report, { color })).join('\n\n');
}

function colorDiff(before: string, after: string, color: boolean): string {
  return diffLines(before, after)
    .map((part) => {
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      const value = part.value
        .split(/(?<=\n)/u)
        .map((line) => (line ? `${prefix}${line}` : ''))
        .join('');
      if (!color) return value;
      if (part.added) return pc.green(value);
      if (part.removed) return pc.red(value);
      return pc.dim(value);
    })
    .join('');
}

async function sourceReports(
  paths: string[],
  config: MuncheConfig,
  values: CliValues,
  cwd: string,
  expectedCount?: number,
): Promise<Array<{ filePath?: string; text: string; report: AnalysisReport }>> {
  if (!paths.length && !process.stdin.isTTY) {
    const text = await readStdin();
    if (text.length > 0) {
      const filePath = '<stdin>';
      return [{ filePath, text, report: analyze(text, analyzeOptions(values['source-format'] ? filePath : undefined, config, values)) }];
    }
  }
  const files = await collectFiles(paths, config, cwd, values['allow-outside-root'] ?? false);
  if (!files.length) throw new Error('검사할 파일을 찾지 못했습니다. 경로나 files 설정을 확인하세요.');
  if (expectedCount !== undefined && files.length !== expectedCount) {
    throw new Error(`입력은 정확히 ${String(expectedCount)}개여야 하지만 ${String(files.length)}개 파일이 선택됐습니다.`);
  }
  return Promise.all(
    files.map(async (filePath) => {
      const text = await readExistingFile(filePath);
      const relative = slash(path.relative(cwd, filePath));
      return { filePath, text, report: analyze(text, analyzeOptions(relative, config, values)) };
    }),
  );
}

async function runLint(command: 'lint' | 'check', paths: string[], config: MuncheConfig, values: CliValues, cwd: string): Promise<void> {
  const sources = await sourceReports(paths, config, values, cwd);
  const output = values.output ?? 'pretty';
  const color = !values['no-color'] && output === 'pretty';
  process.stdout.write(`${renderReports(sources.map((source) => source.report), output, color)}\n`);
  const errors = sources.reduce((sum, source) => sum + source.report.summary.error, 0);
  const warnings = sources.reduce((sum, source) => sum + source.report.summary.warning, 0);
  const maxWarnings = numberOption(
    values['max-warnings'],
    '--max-warnings',
    command === 'check' ? 0 : Number.POSITIVE_INFINITY,
    { min: 0, integer: true },
  );
  if (errors > 0 || warnings > maxWarnings) process.exitCode = 1;
}

async function runFix(paths: string[], config: MuncheConfig, values: CliValues, cwd: string): Promise<void> {
  if (!process.stdin.isTTY && !paths.length && values.write) throw new Error('stdin 결과에는 --write를 사용할 수 없습니다.');
  const sources = await sourceReports(paths, config, values, cwd);
  const color = !values['no-color'];
  const maxChange = values['max-change'] === undefined
    ? undefined
    : numberOption(values['max-change'], '--max-change', 0.15, { min: 0, max: 1 });
  let changed = 0;
  for (const source of sources) {
    const result = applyFixes(
      source.text,
      source.report,
      maxChange === undefined ? {} : { maxChangedCharsRatio: maxChange },
    );
    if (result.limitExceeded) {
      process.stderr.write(`${source.report.filePath ?? '<stdin>'}: 수정 비율 제한을 넘어 원문을 유지했습니다.\n`);
      process.exitCode = 2;
      continue;
    }
    if (result.text === source.text) continue;
    changed += 1;
    if (values.write && source.filePath && source.filePath !== '<stdin>') {
      await writeExistingFile(source.filePath, result.text, source.text);
      process.stdout.write(`${source.report.filePath}: ${String(result.applied.length)}개 안전 수정 적용\n`);
    } else {
      process.stdout.write(`--- ${source.report.filePath ?? '<stdin>'}\n+++ fixed\n${colorDiff(source.text, result.text, color)}\n`);
    }
  }
  if (changed === 0) process.stdout.write('적용할 안전 수정이 없습니다.\n');
}

function commaValues(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function promptForReview(session: ReviewSession): Promise<ReviewResolution[]> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const resolutions: ReviewResolution[] = [];
  try {
    for (const [index, item] of session.items.entries()) {
      process.stdout.write(`\n[${String(index + 1)}/${String(session.items.length)}] ${item.ruleId} — ${item.message}\n`);
      process.stdout.write(`원문: ${JSON.stringify(item.before)}\n`);
      item.proposals.forEach((proposal, proposalIndex) => {
        process.stdout.write(`  ${String(proposalIndex + 1)}. ${JSON.stringify(proposal.text)} (${proposal.risk})\n`);
      });
      const choices = item.proposals.length
        ? '번호/a=승인, e=직접 수정, r=제안 거절, k=원문 유지'
        : 'e=직접 수정, k=원문 유지';
      let resolution: ReviewResolution | undefined;
      while (!resolution) {
        const answer = (await terminal.question(`선택 (${choices}): `)).trim().toLowerCase();
        const proposalNumber = Number(answer);
        if (answer === 'a' && item.proposals.length === 1) {
          resolution = { itemId: item.id, decision: 'accepted', proposalIndex: 0 };
        } else if (
          Number.isSafeInteger(proposalNumber) &&
          proposalNumber >= 1 &&
          proposalNumber <= item.proposals.length
        ) {
          resolution = { itemId: item.id, decision: 'accepted', proposalIndex: proposalNumber - 1 };
        } else if (answer === 'e') {
          const after = await terminal.question('최종 수정문: ');
          resolution = { itemId: item.id, decision: 'edited', after };
        } else if (answer === 'r' && item.proposals.length > 0) {
          resolution = { itemId: item.id, decision: 'rejected' };
        } else if (answer === 'k') {
          resolution = { itemId: item.id, decision: 'kept' };
        } else {
          process.stdout.write('올바른 선택을 입력해 주세요.\n');
        }
      }
      const reasons = commaValues(await terminal.question('이유 태그(쉼표 구분, 생략 가능): '));
      const locks = commaValues(await terminal.question('보존할 주장·표현(쉼표 구분, 생략 가능): '));
      resolutions.push({
        ...resolution,
        ...(reasons.length ? { reasonTags: reasons } : {}),
        ...(locks.length ? { lockedClaims: locks } : {}),
      });
    }
  } finally {
    terminal.close();
  }
  return resolutions;
}

function manualFeedbackInput(values: CliValues, styleId: string): CopyFeedbackInput | undefined {
  if (values.before === undefined) return undefined;
  const reasonTags = values.reason ?? [];
  const lockedClaims = values.lock ?? [];
  const ruleIds = values.rule ?? [];
  const inferred = values.decision ?? (values.after !== undefined ? 'edited' : values.proposal !== undefined ? 'accepted' : 'kept');
  const base = {
    styleId,
    before: values.before,
    reasonTags,
    ruleIds,
    lockedClaims,
    engineVersion: ENGINE_VERSION,
  } as const;
  if (inferred === 'accepted') {
    if (values.proposal === undefined) throw new Error('accepted 기록에는 --proposal이 필요합니다.');
    return { ...base, decision: 'accepted', proposal: values.proposal };
  }
  if (inferred === 'edited') {
    if (values.after === undefined) throw new Error('edited 기록에는 --after가 필요합니다.');
    return {
      ...base,
      decision: 'edited',
      ...(values.proposal === undefined ? {} : { proposal: values.proposal }),
      after: values.after,
    };
  }
  if (inferred === 'rejected') {
    if (values.proposal === undefined) throw new Error('rejected 기록에는 --proposal이 필요합니다.');
    return { ...base, decision: 'rejected', proposal: values.proposal };
  }
  if (inferred === 'kept') {
    return {
      ...base,
      decision: 'kept',
      ...(values.proposal === undefined ? {} : { proposal: values.proposal }),
    };
  }
  throw new Error(`Unknown review decision: ${inferred}`);
}

async function runReview(paths: string[], config: MuncheConfig, values: CliValues, cwd: string): Promise<void> {
  if (values.output && values.output !== 'pretty' && values.output !== 'json') {
    throw new Error('review의 --output은 pretty 또는 json이어야 합니다.');
  }
  if (values.output === 'json' && values.write && !values.decisions) {
    throw new Error('review 세션 JSON을 만들 때는 --write를 함께 사용할 수 없습니다. decisions 적용 단계에서 지정하세요.');
  }
  const styleId = requiredStyleProfile(values);
  const storage = feedbackPathOptions(values, cwd);
  const manual = manualFeedbackInput(values, styleId);
  if (manual) {
    if (paths.length) throw new Error('--before로 직접 기록할 때는 파일 경로를 함께 사용할 수 없습니다.');
    if (values.write || values.decisions || values['rewrite-result']) {
      throw new Error('직접 기록 모드에는 --write, --decisions, --rewrite-result를 사용할 수 없습니다.');
    }
    const record = await appendFeedback(manual, storage);
    if (values.output === 'json') process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    else process.stdout.write(`문체 기억에 저장했습니다: ${record.id} (${record.decision})\n`);
    return;
  }
  if (values.after !== undefined || values.proposal !== undefined || values.decision !== undefined) {
    throw new Error('--proposal, --after, --decision은 --before와 함께 사용해야 합니다.');
  }
  if (paths.length !== 1) throw new Error('review는 한 번에 파일 하나를 받습니다.');
  const sources = await sourceReports(paths, config, values, cwd, 1);
  const source = sources[0];
  if (!source || !source.filePath || source.filePath === '<stdin>') throw new Error('review에는 로컬 파일 하나가 필요합니다.');
  let session: ReviewSession;
  if (values['rewrite-result']) {
    const artifactPath = await canonicalFile(
      path.resolve(cwd, values['rewrite-result']),
      await realpath(cwd),
      values['allow-outside-root'] ?? false,
    );
    let parsed: unknown;
    try {
      parsed = parseJsonDocument(await readExistingFile(artifactPath, 32 * 1024 * 1024));
    } catch (error) {
      throw new Error(`rewrite 결과 파일을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    const artifact = validateRewriteReviewArtifact(parsed);
    if (artifact.styleProfile !== styleId) {
      throw new Error(`rewrite 결과의 styleProfile(${artifact.styleProfile})과 --style-profile(${styleId})이 다릅니다.`);
    }
    if (artifact.filePath && artifact.filePath !== source.report.filePath) {
      throw new Error(`rewrite 결과의 filePath(${artifact.filePath})과 현재 파일(${source.report.filePath ?? ''})이 다릅니다.`);
    }
    session = createRewriteReviewSession(source.text, artifact);
  } else {
    session = createReviewSession(source.text, source.report, styleId);
  }
  if (!session.items.length) {
    process.stdout.write('검토할 진단이 없습니다. 임의 문장쌍은 --before와 --after로 기록할 수 있습니다.\n');
    return;
  }
  if (values.output === 'json' && !values.decisions) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    return;
  }
  let resolutions: ReviewResolution[];
  if (values.decisions) {
    const decisionPath = await canonicalFile(
      path.resolve(cwd, values.decisions),
      await realpath(cwd),
      values['allow-outside-root'] ?? false,
    );
    let parsed: unknown;
    try {
      parsed = parseJsonDocument(await readExistingFile(decisionPath));
    } catch (error) {
      throw new Error(`검토 결정 파일을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    const document = validateReviewDecisionDocument(parsed);
    if (document.sourceHash !== session.sourceHash) throw new Error('검토 결정 파일의 sourceHash가 현재 원문과 다릅니다.');
    if (document.sessionHash !== session.sessionHash) {
      throw new Error('검토 결정 파일의 sessionHash가 현재 규칙·제안과 다릅니다. 검토 세션을 다시 생성하세요.');
    }
    resolutions = document.resolutions;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('비대화형 review에는 --output json으로 세션을 받은 뒤 --decisions <파일>을 사용하세요.');
    }
    resolutions = await promptForReview(session);
  }
  const reportFilePath = source.report.filePath;
  const safeFeedbackSource = reportFilePath
    && !path.isAbsolute(reportFilePath)
    && !reportFilePath.replaceAll('\\', '/').split('/').includes('..')
    ? { filePath: reportFilePath }
    : undefined;
  const resolved = resolveReviewSession(source.text, session, resolutions, {
    styleId,
    engineVersion: ENGINE_VERSION,
    ...(safeFeedbackSource ? { source: safeFeedbackSource } : {}),
  });
  const records = [];
  for (const input of resolved.feedback) records.push(await appendFeedback(input, storage));
  let applied = false;
  if (values.write && resolved.text !== source.text) {
    const current = await readExistingFile(source.filePath);
    if (current !== source.text) throw new Error('검토 중 원본 파일이 바뀌어 --write를 중단했습니다.');
    await writeExistingFile(source.filePath, resolved.text, source.text);
    applied = true;
  }
  if (values.output === 'json') {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: '1.0',
      kind: 'munche-review-result',
      sourceHash: session.sourceHash,
      sessionHash: session.sessionHash,
      ...(source.report.filePath ? { filePath: source.report.filePath } : {}),
      styleProfile: styleId,
      applied,
      edits: resolved.edits,
      feedback: records,
      text: resolved.text,
    }, null, 2)}\n`);
    return;
  }
  if (applied) {
    process.stdout.write(`${source.report.filePath}: 승인된 ${String(resolved.edits.length)}개 수정을 적용했습니다.\n`);
  } else if (resolved.text !== source.text) {
    process.stdout.write(`--- ${source.report.filePath}\n+++ reviewed\n${colorDiff(source.text, resolved.text, !values['no-color'])}\n`);
  }
  process.stdout.write(`문체 기억 ${String(records.length)}건 저장: ${styleId}\n`);
}

async function runLearn(paths: string[], values: CliValues, cwd: string): Promise<void> {
  if (paths.length) throw new Error('learn은 파일 경로를 받지 않습니다. --style-profile을 사용하세요.');
  const styleId = requiredStyleProfile(values);
  const records = await readFeedback({ ...feedbackPathOptions(values, cwd), styleId });
  const learned = buildLearnedStyleProfile(records, styleId);
  if (values.output === 'json') {
    process.stdout.write(`${JSON.stringify(learned, null, 2)}\n`);
    return;
  }
  if (values.output && values.output !== 'pretty') throw new Error('learn의 --output은 pretty 또는 json이어야 합니다.');
  process.stdout.write([
    `학습 문체: ${learned.styleId}`,
    `승인·직접 수정 기록: ${String(learned.summary.learnedRecordCount)}건`,
    `고유 문장쌍: ${String(learned.summary.exampleCount)}개`,
    `충돌로 보류한 원문: ${String(learned.summary.conflictingBeforeCount)}개`,
    `평균 길이 변화: ${learned.summary.averageLengthDelta >= 0 ? '+' : ''}${String(learned.summary.averageLengthDelta)}자`,
    ...learned.examples.map((example, index) => (
      `${String(index + 1)}. ${JSON.stringify(example.before)} → ${JSON.stringify(example.after)} (승인 ${String(example.approvalCount)}회)`
    )),
  ].join('\n') + '\n');
}

async function runRewrite(paths: string[], config: MuncheConfig, values: CliValues, cwd: string): Promise<void> {
  if (paths.length > 1) throw new Error('rewrite는 한 번에 파일 하나만 받습니다.');
  if (!paths.length && process.stdin.isTTY) throw new Error('rewrite에는 파일 하나 또는 stdin 입력이 필요합니다.');
  const sources = await sourceReports(paths, config, values, cwd, 1);
  if (sources.length !== 1) {
    throw new Error(`rewrite 입력은 정확히 하나여야 하지만 ${String(sources.length)}개 파일이 선택됐습니다.`);
  }
  const source = sources[0];
  if (!source) throw new Error('재작성할 텍스트가 없습니다.');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경 변수가 필요합니다.');
  if (!values.model) throw new Error('--model <Claude model ID>가 필요합니다. 모델 ID를 고정 기본값으로 두지 않습니다.');
  const mode = rewriteMode(values.mode);
  if (values.output && values.output !== 'pretty' && values.output !== 'json') {
    throw new Error('rewrite의 --output은 pretty 또는 json이어야 합니다.');
  }
  if (mode === 'natural' && values.write) {
    throw new Error('natural 재작성은 바로 --write할 수 없습니다. 결과를 review에서 승인한 뒤 적용하세요.');
  }
  const resultFilePath = values['result-file']
    ? await canonicalNewJsonFile(values['result-file'], cwd, values['allow-outside-root'] ?? false)
    : undefined;
  let styleMemory;
  let activeStyleId: string | undefined;
  if (mode === 'natural') {
    const styleId = requiredStyleProfile(values);
    activeStyleId = styleId;
    const records = await readFeedback({ ...feedbackPathOptions(values, cwd), styleId });
    const learned = buildLearnedStyleProfile(records, styleId);
    if (!learned.examples.length) {
      throw new Error(`${styleId}에 재사용할 승인 문장쌍이 없습니다. 먼저 review로 승인 사례를 저장하세요.`);
    }
    // Use relevant examples as bounded prompt guidance, while retaining every
    // conflict-free approved pair locally so an exact segment match cannot be
    // lost merely because a long page changed the top-N retrieval ranking.
    const context = buildLearningPromptContext(records, styleId, source.text, {
      limit: 8,
      minSimilarity: 0,
    });
    styleMemory = {
      styleId,
      promptContext: context.text,
      approvedExamples: learned.examples.map((example) => ({
        before: example.before,
        after: example.after,
        reasonTags: example.reasonTags,
        lockedClaims: example.lockedClaims,
      })),
    };
  }
  const maxChange = numberOption(
    values['max-change'],
    '--max-change',
    mode === 'natural'
      ? (config.rewrite?.naturalMaxChangedCharsRatio ?? 0.65)
      : (config.rewrite?.maxChangedCharsRatio ?? 0.35),
    { min: 0, max: 1 },
  );
  const provider = new AnthropicProvider({
    apiKey,
    model: values.model,
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  });
  const result = await rewrite(source.text, {
    ...analyzeOptions(source.report.filePath, config, values),
    provider,
    maxChangedCharsRatio: maxChange,
    mode,
    ...(styleMemory ? { styleMemory } : {}),
  });
  const outputDocument = (applied: boolean) => ({
    schemaVersion: '1.0',
    kind: 'munche-rewrite-result',
    engineVersion: ENGINE_VERSION,
    sourceHash: hashReviewSource(source.text),
    ...(source.report.filePath && source.report.filePath !== '<stdin>' ? { filePath: source.report.filePath } : {}),
    format: source.report.format,
    profile: source.report.profile,
    mode,
    ...(activeStyleId ? { styleProfile: activeStyleId } : {}),
    accepted: result.accepted,
    applied,
    provider: result.provider,
    changedCharsRatio: result.changedCharsRatio,
    violations: result.violations,
    changes: result.changes,
    ...(result.candidate === undefined ? {} : { candidate: result.candidate }),
    text: result.text,
  });
  if (!result.accepted) {
    const document = outputDocument(false);
    if (resultFilePath) await writeNewPrivateFile(resultFilePath, `${JSON.stringify(document, null, 2)}\n`);
    if (values.output === 'json') process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    else {
      process.stderr.write(`재작성 결과를 거부했습니다:\n${result.violations.map((item) => `- ${item}`).join('\n')}\n`);
      if (resultFilePath) process.stderr.write(`rewrite 결과 저장: ${resultFilePath}\n`);
    }
    process.exitCode = 2;
    return;
  }
  let applied = false;
  if (values.write && source.filePath && source.filePath !== '<stdin>') {
    await writeExistingFile(source.filePath, result.text, source.text);
    applied = true;
  }
  const document = outputDocument(applied);
  if (resultFilePath) await writeNewPrivateFile(resultFilePath, `${JSON.stringify(document, null, 2)}\n`);
  if (values.output === 'json') {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  } else if (applied) {
    process.stderr.write(`${formatRewriteChanges(result.changes)}\n\n`);
    process.stdout.write(`${source.report.filePath}: Claude 재작성 결과를 적용했습니다(검토 필요).\n`);
  } else {
    // Keep stdout pipe-safe: the final text remains the only stdout payload,
    // while terminals still show the exact before → after audit on stderr.
    process.stderr.write(`${formatRewriteChanges(result.changes)}\n\n`);
    process.stdout.write(`${result.text}\n`);
  }
  if (resultFilePath && values.output !== 'json') process.stderr.write(`rewrite 결과 저장: ${resultFilePath}\n`);
}

function explain(ruleId?: string): void {
  if (!ruleId) {
    process.stdout.write(`${ruleCatalog.map((rule) => `${rule.id.padEnd(17)} ${rule.name}`).join('\n')}\n`);
    return;
  }
  const rule = ruleCatalog.find((item) => item.id.toLowerCase() === ruleId.toLowerCase());
  if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
  process.stdout.write(
    `${rule.id} — ${rule.name}\n\n${rule.description}\n\ncategory: ${rule.category}\nlevel: ${rule.defaultLevel}\nfix: ${rule.fixability}\nstability: ${rule.stability}\ndocs: ${rule.docsUrl}\n`,
  );
}

async function init(cwd: string): Promise<void> {
  const filePath = path.join(cwd, DEFAULT_CONFIG_FILE);
  let handle;
  try {
    handle = await open(filePath, 'wx');
    await handle.writeFile(`${JSON.stringify(exampleConfig, null, 2)}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${DEFAULT_CONFIG_FILE} already exists.`);
    throw error;
  } finally {
    await handle?.close();
  }
  process.stdout.write(`${filePath} 생성 완료\n`);
}

async function main(): Promise<void> {
  const { command, paths, values } = parseCli(process.argv.slice(2));
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return;
  }
  const cwd = process.cwd();
  if (command === 'init') {
    await init(cwd);
    return;
  }
  if (command === 'rules') {
    explain();
    return;
  }
  if (command === 'explain') {
    explain(paths[0]);
    return;
  }
  const { config } = await loadConfig(cwd, values.config);
  if (command === 'lint' || command === 'check') await runLint(command, paths, config, values, cwd);
  else if (command === 'fix') await runFix(paths, config, values, cwd);
  else if (command === 'rewrite') await runRewrite(paths, config, values, cwd);
  else if (command === 'review') await runReview(paths, config, values, cwd);
  else if (command === 'learn') await runLearn(paths, values, cwd);
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`munche: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
