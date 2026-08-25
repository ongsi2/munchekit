#!/usr/bin/env node

import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { diffLines } from 'diff';
import fg from 'fast-glob';
import pc from 'picocolors';

import { numberOption } from './cli-options.js';
import { DEFAULT_CONFIG_FILE, exampleConfig, loadConfig } from './config.js';
import { analyze, ENGINE_VERSION } from './engine.js';
import { applyFixes } from './fixes.js';
import { profiles } from './profiles.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { jsonReport, prettyReport, sarifReport } from './reporters.js';
import { rewrite } from './rewrite.js';
import { ruleCatalog } from './rules.js';
import type { AnalysisReport, AnalyzeOptions, MuncheConfig, ProfileName, SourceFormat } from './types.js';

const HELP = `MuncheKit ${ENGINE_VERSION} — 설명 가능한 한국어 문체 린터

사용법
  munche lint [경로/글롭...]       진단 결과를 출력합니다.
  munche check [경로/글롭...]      경고가 있으면 실패하는 CI 모드입니다.
  munche fix [경로/글롭...]        안전한 수정의 diff를 봅니다.
  munche rewrite <파일>            Claude로 윤문한 뒤 보존 조건을 검사합니다.
  munche explain [규칙 ID]         규칙 설명을 봅니다.
  munche rules                     전체 규칙을 나열합니다.
  munche init                      .munche.json 예시를 만듭니다.

주요 옵션
  --profile <이름>                 natural | web | tech-blog | business | thmm-tech
  --output <형식>                  pretty | json | sarif (기본 pretty)
  --source-format <형식>           auto | plain | markdown | mdx | json | html | tsx
  --config <파일>                  설정 파일 경로
  --max-warnings <수>              허용할 warning 수
  --write                          fix/rewrite 결과를 원본에 씁니다.
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
  ANTHROPIC_API_KEY=... npx munchekit rewrite post.md --model <model-id>
`;

const outputFormats = new Set(['pretty', 'json', 'sarif']);
const sourceFormats = new Set<SourceFormat>(['auto', 'plain', 'markdown', 'mdx', 'json', 'html', 'tsx']);

interface CliValues {
  help?: boolean;
  version?: boolean;
  profile?: string;
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
  const commands = new Set(['lint', 'check', 'fix', 'rewrite', 'explain', 'rules', 'init']);
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

async function readExistingFile(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`안전하게 읽을 수 없는 파일입니다: ${filePath}`);
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`읽는 동안 파일이 바뀌었습니다: ${filePath}`);
    if (opened.size > 5 * 1024 * 1024) throw new Error(`파일이 5 MiB 제한을 넘습니다: ${filePath}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function writeExistingFile(filePath: string, text: string): Promise<void> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`안전하게 쓸 수 없는 파일입니다: ${filePath}`);
  const handle = await open(filePath, 'r+');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`쓰는 동안 파일이 바뀌었습니다: ${filePath}`);
    await handle.truncate(0);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
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
      await writeExistingFile(source.filePath, result.text);
      process.stdout.write(`${source.report.filePath}: ${String(result.applied.length)}개 안전 수정 적용\n`);
    } else {
      process.stdout.write(`--- ${source.report.filePath ?? '<stdin>'}\n+++ fixed\n${colorDiff(source.text, result.text, color)}\n`);
    }
  }
  if (changed === 0) process.stdout.write('적용할 안전 수정이 없습니다.\n');
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
  const maxChange = numberOption(
    values['max-change'],
    '--max-change',
    config.rewrite?.maxChangedCharsRatio ?? 0.35,
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
  });
  if (!result.accepted) {
    process.stderr.write(`재작성 결과를 거부했습니다:\n${result.violations.map((item) => `- ${item}`).join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.write && source.filePath && source.filePath !== '<stdin>') {
    await writeExistingFile(source.filePath, result.text);
    process.stdout.write(`${source.report.filePath}: Claude 재작성 결과를 적용했습니다(검토 필요).\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
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
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`munche: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
