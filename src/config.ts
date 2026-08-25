import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { profiles } from './profiles.js';
import { compileUserPattern } from './patterns.js';
import { ruleCatalog } from './rules.js';
import type { MuncheConfig, ProfileName, RuleLevel } from './types.js';

export const DEFAULT_CONFIG_FILE = '.munche.json';

export const defaultConfig: Required<Pick<MuncheConfig, 'files' | 'ignore' | 'preserveTerms' | 'preservePatterns' | 'rules'>> &
  MuncheConfig = {
  profile: 'natural',
  files: ['**/*.{md,mdx,txt,json,jsonc,html,htm,js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.git/**', '**/fixtures/**'],
  preserveTerms: [],
  preservePatterns: [],
  ignoreQuotes: true,
  rules: {},
  rewrite: {
    maxChangedCharsRatio: 0.35,
  },
};

const levels = new Set<RuleLevel>(['off', 'info', 'warning', 'error']);
const ruleIds = new Set(ruleCatalog.filter((rule) => rule.category !== 'parser').map((rule) => rule.id));

function stringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  if (value.length > 2_000) throw new Error(`${key} must not contain more than 2000 entries.`);
  return value;
}

export function validateConfig(value: unknown): MuncheConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Munche config must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set([
    '$schema',
    'profile',
    'files',
    'ignore',
    'preserveTerms',
    'preservePatterns',
    'ignoreQuotes',
    'rules',
    'rewrite',
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`Unknown config key(s): ${unknownKeys.join(', ')}`);
  const output: MuncheConfig = {};
  if (input.$schema !== undefined && typeof input.$schema !== 'string') {
    throw new Error('$schema must be a string.');
  }
  if (input.profile !== undefined) {
    if (typeof input.profile !== 'string' || !(input.profile in profiles)) {
      throw new Error(`Unknown profile: ${String(input.profile)}`);
    }
    output.profile = input.profile as ProfileName;
  }
  const files = stringArray(input.files, 'files');
  const ignore = stringArray(input.ignore, 'ignore');
  const preserveTerms = stringArray(input.preserveTerms, 'preserveTerms');
  const preservePatterns = stringArray(input.preservePatterns, 'preservePatterns');
  if (files) output.files = files;
  if (ignore) output.ignore = ignore;
  if (preserveTerms) {
    if (preserveTerms.some((term) => term.length === 0)) throw new Error('preserveTerms entries must not be empty.');
    output.preserveTerms = preserveTerms;
  }
  if (preservePatterns) {
    for (const pattern of preservePatterns) {
      try {
        compileUserPattern(pattern);
      } catch (error) {
        throw new Error(`Invalid preservePatterns entry ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    output.preservePatterns = preservePatterns;
  }
  if (input.ignoreQuotes !== undefined) {
    if (typeof input.ignoreQuotes !== 'boolean') throw new Error('ignoreQuotes must be a boolean.');
    output.ignoreQuotes = input.ignoreQuotes;
  }
  if (input.rules !== undefined) {
    if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) {
      throw new Error('rules must be an object.');
    }
    const rules: Record<string, RuleLevel> = {};
    for (const [id, level] of Object.entries(input.rules as Record<string, unknown>)) {
      if (!ruleIds.has(id)) throw new Error(`Unknown rule: ${id}`);
      if (typeof level !== 'string' || !levels.has(level as RuleLevel)) {
        throw new Error(`Invalid level for ${id}: ${String(level)}`);
      }
      rules[id] = level as RuleLevel;
    }
    output.rules = rules;
  }
  if (input.rewrite !== undefined) {
    if (!input.rewrite || typeof input.rewrite !== 'object' || Array.isArray(input.rewrite)) {
      throw new Error('rewrite must be an object.');
    }
    const rewrite = input.rewrite as Record<string, unknown>;
    const unknownRewriteKeys = Object.keys(rewrite).filter((key) => key !== 'maxChangedCharsRatio');
    if (unknownRewriteKeys.length) throw new Error(`Unknown rewrite key(s): ${unknownRewriteKeys.join(', ')}`);
    if (rewrite.maxChangedCharsRatio !== undefined) {
      if (
        typeof rewrite.maxChangedCharsRatio !== 'number' ||
        !Number.isFinite(rewrite.maxChangedCharsRatio) ||
        rewrite.maxChangedCharsRatio < 0 ||
        rewrite.maxChangedCharsRatio > 1
      ) {
        throw new Error('rewrite.maxChangedCharsRatio must be between 0 and 1.');
      }
      output.rewrite = { maxChangedCharsRatio: rewrite.maxChangedCharsRatio };
    }
  }
  return output;
}

export function mergeConfig(config: MuncheConfig): MuncheConfig {
  return {
    ...defaultConfig,
    ...config,
    files: config.files ?? defaultConfig.files,
    ignore: [...defaultConfig.ignore, ...(config.ignore ?? [])],
    preserveTerms: config.preserveTerms ?? defaultConfig.preserveTerms,
    preservePatterns: config.preservePatterns ?? defaultConfig.preservePatterns,
    rules: { ...defaultConfig.rules, ...(config.rules ?? {}) },
    rewrite: { ...defaultConfig.rewrite, ...(config.rewrite ?? {}) },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(cwd = process.cwd(), explicitPath?: string): Promise<{ config: MuncheConfig; path?: string }> {
  const candidate = explicitPath ? path.resolve(cwd, explicitPath) : path.join(cwd, DEFAULT_CONFIG_FILE);
  if (!(await exists(candidate))) {
    if (explicitPath) throw new Error(`Config file not found: ${candidate}`);
    return { config: mergeConfig({}) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { config: mergeConfig(validateConfig(parsed)), path: candidate };
}

export const exampleConfig = {
  $schema: 'https://raw.githubusercontent.com/ongsi2/munchekit/v0.2.0/schema/munche.schema.json',
  profile: 'web',
  files: ['content/**/*.{md,mdx}', 'messages/ko.json', 'src/**/*.{jsx,tsx}'],
  ignore: ['**/*.test.*', '**/__snapshots__/**'],
  preserveTerms: ['MuncheKit', 'Next.js', 'displayName'],
  preservePatterns: ['\\bTICKET-[0-9]+\\b'],
  ignoreQuotes: true,
  rules: {
    'KO-REGISTER-001': 'warning',
    'KO-END-001': 'info',
  },
  rewrite: {
    maxChangedCharsRatio: 0.25,
  },
} as const;
