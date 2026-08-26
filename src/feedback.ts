import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { SourceFormat, TextRange } from './types.js';

export const FEEDBACK_SCHEMA_VERSION = '1.0' as const;
export const DEFAULT_FEEDBACK_PATH = '.munche/feedback.jsonl';

export type CopyFeedbackDecision = 'accepted' | 'edited' | 'rejected' | 'kept';

export interface CopyFeedbackSource {
  /** Workspace-relative path. Absolute paths and parent traversal are rejected. */
  filePath?: string;
  /** Public HTTP(S) source when the copy did not originate in a local file. */
  url?: string;
  format?: Exclude<SourceFormat, 'auto'>;
  range?: TextRange;
  segmentId?: string;
}

interface CopyFeedbackInputBase {
  /** Project- or brand-specific style identifier, independent of the lint profile. */
  styleId: string;
  before: string;
  reasonTags?: readonly string[];
  ruleIds?: readonly string[];
  lockedClaims?: readonly string[];
  source?: CopyFeedbackSource;
  engineVersion: string;
}

export interface AcceptedCopyDecisionInput extends CopyFeedbackInputBase {
  decision: 'accepted';
  proposal: string;
}

export interface EditedCopyDecisionInput extends CopyFeedbackInputBase {
  decision: 'edited';
  proposal?: string;
  after: string;
}

export interface RejectedCopyDecisionInput extends CopyFeedbackInputBase {
  decision: 'rejected';
  proposal: string;
}

export interface KeptCopyDecisionInput extends CopyFeedbackInputBase {
  decision: 'kept';
  proposal?: string;
}

export type CopyFeedbackInput =
  | AcceptedCopyDecisionInput
  | EditedCopyDecisionInput
  | RejectedCopyDecisionInput
  | KeptCopyDecisionInput;

interface CopyFeedbackRecordBase {
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
  id: string;
  styleId: string;
  before: string;
  after: string;
  reasonTags: string[];
  ruleIds: string[];
  lockedClaims: string[];
  source?: CopyFeedbackSource;
  createdAt: string;
  engineVersion: string;
}

export interface AcceptedCopyDecision extends CopyFeedbackRecordBase {
  decision: 'accepted';
  proposal: string;
}

export interface EditedCopyDecision extends CopyFeedbackRecordBase {
  decision: 'edited';
  proposal?: string;
}

export interface RejectedCopyDecision extends CopyFeedbackRecordBase {
  decision: 'rejected';
  proposal: string;
}

export interface KeptCopyDecision extends CopyFeedbackRecordBase {
  decision: 'kept';
  proposal?: string;
}

export type CopyFeedbackRecord =
  | AcceptedCopyDecision
  | EditedCopyDecision
  | RejectedCopyDecision
  | KeptCopyDecision;

export interface FeedbackPathOptions {
  workspaceRoot?: string;
  /** A workspace-relative JSONL path. Defaults to `.munche/feedback.jsonl`. */
  filePath?: string;
}

export interface ReadFeedbackOptions extends FeedbackPathOptions {
  /** Return only records belonging to this style profile. */
  styleId?: string;
}

export interface CreateFeedbackRecordOptions {
  /** Injectable for deterministic tests. IDs never depend on this timestamp. */
  createdAt?: Date | string;
}

export interface AppendFeedbackOptions extends FeedbackPathOptions, CreateFeedbackRecordOptions {}

const decisions = new Set<CopyFeedbackDecision>(['accepted', 'edited', 'rejected', 'kept']);
const formats = new Set<Exclude<SourceFormat, 'auto'>>(['plain', 'markdown', 'mdx', 'json', 'html', 'tsx']);
const styleIdPattern = /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,62}[\p{L}\p{N}])?$/u;
const recordIdPattern = /^fb_[a-f0-9]{32}$/u;
const maximumCopyLength = 100_000;
const maximumArrayEntries = 200;
const maximumFeedbackBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`Unknown ${label} key(s): ${unknown.join(', ')}`);
}

function requiredString(value: unknown, label: string, maximumLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  if (value.length > maximumLength) throw new Error(`${label} must not exceed ${String(maximumLength)} characters.`);
  if (value.includes('\0')) throw new Error(`${label} must not contain null characters.`);
  return value;
}

function normalizeStringSet(value: unknown, label: string, maximumItemLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings.`);
  if (value.length > maximumArrayEntries) {
    throw new Error(`${label} must not contain more than ${String(maximumArrayEntries)} entries.`);
  }
  const values = value.map((item, index) => {
    const normalized = requiredString(item, `${label}[${String(index)}]`, maximumItemLength).trim();
    if (normalized.length === 0) throw new Error(`${label}[${String(index)}] must not be blank.`);
    return normalized;
  });
  return [...new Set(values)].sort();
}

function validateStyleId(value: unknown): string {
  const styleId = requiredString(value, 'styleId', 64).trim();
  if (!styleIdPattern.test(styleId)) {
    throw new Error('styleId must be 1-64 letters or numbers with internal `.`, `_`, or `-` characters.');
  }
  return styleId;
}

function relativePathSegments(filePath: string): string[] {
  return filePath.replaceAll('\\', '/').split('/');
}

function normalizeSourcePath(value: unknown): string {
  const filePath = requiredString(value, 'source.filePath', 1_000).trim();
  if (path.isAbsolute(filePath) || /^[\\/]/u.test(filePath) || /^[A-Za-z]:/u.test(filePath)) {
    throw new Error('source.filePath must be workspace-relative.');
  }
  const segments = relativePathSegments(filePath);
  if (segments.some((segment) => segment === '..')) throw new Error('source.filePath must not contain parent traversal.');
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (normalized.length === 0) throw new Error('source.filePath must identify a file.');
  return normalized;
}

function normalizeSource(value: unknown): CopyFeedbackSource | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('source must be an object.');
  rejectUnknownKeys(value, ['filePath', 'url', 'format', 'range', 'segmentId'], 'source');
  const source: CopyFeedbackSource = {};
  if (value.filePath !== undefined) source.filePath = normalizeSourcePath(value.filePath);
  if (value.url !== undefined) {
    const rawUrl = requiredString(value.url, 'source.url', 2_000).trim();
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('source.url must be a valid HTTP(S) URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('source.url must be a valid HTTP(S) URL.');
    }
    source.url = parsed.toString();
  }
  if (value.format !== undefined) {
    if (typeof value.format !== 'string' || !formats.has(value.format as Exclude<SourceFormat, 'auto'>)) {
      throw new Error(`Unknown source.format: ${String(value.format)}`);
    }
    source.format = value.format as Exclude<SourceFormat, 'auto'>;
  }
  if (value.range !== undefined) {
    if (!isRecord(value.range)) throw new Error('source.range must be an object.');
    rejectUnknownKeys(value.range, ['start', 'end'], 'source.range');
    const { start, end } = value.range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
      throw new Error('source.range must use non-negative integer UTF-16 offsets with end >= start.');
    }
    source.range = { start: start as number, end: end as number };
  }
  if (value.segmentId !== undefined) {
    const segmentId = requiredString(value.segmentId, 'source.segmentId', 200).trim();
    if (segmentId.length === 0) throw new Error('source.segmentId must not be blank.');
    source.segmentId = segmentId;
  }
  if (Object.keys(source).length === 0) throw new Error('source must contain at least one metadata field.');
  return source;
}

function normalizeCreatedAt(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('createdAt must be a valid date.');
  return date.toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function deterministicRecordId(record: Omit<CopyFeedbackRecord, 'schemaVersion' | 'id' | 'createdAt'>): string {
  const digest = createHash('sha256').update(JSON.stringify(stableValue(record)), 'utf8').digest('hex').slice(0, 32);
  return `fb_${digest}`;
}

function normalizedInput(input: CopyFeedbackInput): Omit<CopyFeedbackRecord, 'schemaVersion' | 'id' | 'createdAt'> {
  if (!isRecord(input)) throw new Error('Feedback input must be an object.');
  rejectUnknownKeys(
    input,
    ['styleId', 'decision', 'before', 'proposal', 'after', 'reasonTags', 'ruleIds', 'lockedClaims', 'source', 'engineVersion'],
    'feedback input',
  );
  if (typeof input.decision !== 'string' || !decisions.has(input.decision as CopyFeedbackDecision)) {
    throw new Error(`Unknown feedback decision: ${String(input.decision)}`);
  }
  const styleId = validateStyleId(input.styleId);
  const before = requiredString(input.before, 'before', maximumCopyLength);
  const engineVersion = requiredString(input.engineVersion, 'engineVersion', 100).trim();
  if (engineVersion.length === 0) throw new Error('engineVersion must not be blank.');
  const reasonTags = normalizeStringSet(input.reasonTags, 'reasonTags', 100);
  const ruleIds = normalizeStringSet(input.ruleIds, 'ruleIds', 100);
  const lockedClaims = normalizeStringSet(input.lockedClaims, 'lockedClaims', 1_000);
  const source = normalizeSource(input.source);
  const base = { styleId, before, reasonTags, ruleIds, lockedClaims, ...(source ? { source } : {}), engineVersion };

  if (input.decision === 'accepted') {
    const proposal = requiredString(input.proposal, 'proposal', maximumCopyLength, true);
    return { ...base, decision: 'accepted', proposal, after: proposal };
  }
  if (input.decision === 'edited') {
    const after = requiredString(input.after, 'after', maximumCopyLength, true);
    const proposal = input.proposal === undefined
      ? undefined
      : requiredString(input.proposal, 'proposal', maximumCopyLength, true);
    return { ...base, decision: 'edited', ...(proposal === undefined ? {} : { proposal }), after };
  }
  if (input.decision === 'rejected') {
    const proposal = requiredString(input.proposal, 'proposal', maximumCopyLength, true);
    return { ...base, decision: 'rejected', proposal, after: before };
  }
  const proposal = input.proposal === undefined
    ? undefined
    : requiredString(input.proposal, 'proposal', maximumCopyLength, true);
  return { ...base, decision: 'kept', ...(proposal === undefined ? {} : { proposal }), after: before };
}

export function createFeedbackRecord(
  input: CopyFeedbackInput,
  options: CreateFeedbackRecordOptions = {},
): CopyFeedbackRecord {
  const normalized = normalizedInput(input);
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: deterministicRecordId(normalized),
    ...normalized,
    createdAt: normalizeCreatedAt(options.createdAt),
  } as CopyFeedbackRecord;
}

export function feedbackAfter(record: CopyFeedbackRecord): string {
  return record.after;
}

export function validateFeedbackRecord(value: unknown): CopyFeedbackRecord {
  if (!isRecord(value)) throw new Error('Feedback record must be a JSON object.');
  rejectUnknownKeys(
    value,
    [
      'schemaVersion',
      'id',
      'styleId',
      'decision',
      'before',
      'proposal',
      'after',
      'reasonTags',
      'ruleIds',
      'lockedClaims',
      'source',
      'createdAt',
      'engineVersion',
    ],
    'feedback record',
  );
  if (value.schemaVersion !== FEEDBACK_SCHEMA_VERSION) {
    throw new Error(`Unsupported feedback schemaVersion: ${String(value.schemaVersion)}`);
  }
  const id = requiredString(value.id, 'id', 35);
  if (!recordIdPattern.test(id)) throw new Error('id must be a deterministic `fb_` identifier.');
  const decision = value.decision;
  if (typeof decision !== 'string' || !decisions.has(decision as CopyFeedbackDecision)) {
    throw new Error(`Unknown feedback decision: ${String(decision)}`);
  }
  for (const key of ['after', 'reasonTags', 'ruleIds', 'lockedClaims', 'createdAt', 'engineVersion'] as const) {
    if (value[key] === undefined) throw new Error(`${key} is required in a stored feedback record.`);
  }
  const common = {
    styleId: validateStyleId(value.styleId),
    decision: decision as CopyFeedbackDecision,
    before: requiredString(value.before, 'before', maximumCopyLength),
    ...(value.proposal === undefined
      ? {}
      : { proposal: requiredString(value.proposal, 'proposal', maximumCopyLength, true) }),
    ...(value.after === undefined ? {} : { after: requiredString(value.after, 'after', maximumCopyLength, true) }),
    reasonTags: normalizeStringSet(value.reasonTags, 'reasonTags', 100),
    ruleIds: normalizeStringSet(value.ruleIds, 'ruleIds', 100),
    lockedClaims: normalizeStringSet(value.lockedClaims, 'lockedClaims', 1_000),
    ...(value.source === undefined ? {} : { source: normalizeSource(value.source) }),
    engineVersion: requiredString(value.engineVersion, 'engineVersion', 100).trim(),
  } as Record<string, unknown>;
  if ((common.engineVersion as string).length === 0) throw new Error('engineVersion must not be blank.');
  const input = common as unknown as CopyFeedbackInput;
  const normalized = normalizedInput(input);
  if (value.after !== normalized.after) {
    const expectation = decision === 'accepted' ? 'proposal' : decision === 'edited' ? 'the edited text' : 'before';
    throw new Error(`after must equal ${expectation} for a ${decision} decision.`);
  }
  const expectedId = deterministicRecordId(normalized);
  if (id !== expectedId) throw new Error(`Feedback id does not match its content; expected ${expectedId}.`);
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id,
    ...normalized,
    createdAt: normalizeCreatedAt(requiredString(value.createdAt, 'createdAt', 100)),
  } as CopyFeedbackRecord;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveFeedbackPath(options: FeedbackPathOptions = {}): string {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const requested = options.filePath ?? DEFAULT_FEEDBACK_PATH;
  if (typeof requested !== 'string' || requested.trim().length === 0 || requested.includes('\0')) {
    throw new Error('Feedback filePath must be a non-empty workspace-relative path.');
  }
  if (path.isAbsolute(requested) || /^[\\/]/u.test(requested) || /^[A-Za-z]:/u.test(requested)) {
    throw new Error('Feedback filePath must be workspace-relative.');
  }
  if (relativePathSegments(requested).some((segment) => segment === '..')) {
    throw new Error('Feedback filePath must not contain parent traversal.');
  }
  const resolved = path.resolve(workspaceRoot, requested);
  if (resolved === workspaceRoot || !isWithin(workspaceRoot, resolved)) {
    throw new Error('Feedback path must stay inside the workspace root.');
  }
  if (path.extname(resolved).toLowerCase() !== '.jsonl') throw new Error('Feedback filePath must end in `.jsonl`.');
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertSafeRealPath(options: FeedbackPathOptions): Promise<string> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const target = resolveFeedbackPath(options);
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch (error) {
    throw new Error(`Workspace root is not accessible: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rootStats = await lstat(rootReal);
  if (!rootStats.isDirectory()) throw new Error('Workspace root must be a directory.');

  let ancestor = target;
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Could not resolve a safe feedback path.');
    ancestor = parent;
  }
  const ancestorReal = await realpath(ancestor);
  const projectedTarget = path.resolve(ancestorReal, path.relative(ancestor, target));
  if (!isWithin(rootReal, projectedTarget)) {
    throw new Error('Feedback path resolves outside the workspace root through a symbolic link.');
  }
  if (await exists(target)) {
    const targetStats = await lstat(target);
    if (targetStats.isDirectory()) throw new Error('Feedback path must identify a file.');
    const targetReal = await realpath(target);
    if (!isWithin(rootReal, targetReal)) {
      throw new Error('Feedback path resolves outside the workspace root through a symbolic link.');
    }
  }
  return target;
}

async function ensureDefaultFeedbackIsPrivate(options: FeedbackPathOptions, target: string): Promise<void> {
  const defaultTarget = resolveFeedbackPath(
    options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot },
  );
  if (path.resolve(target) !== path.resolve(defaultTarget)) return;
  const ignorePath = path.join(path.dirname(target), '.gitignore');
  let handle;
  try {
    handle = await open(ignorePath, 'wx', 0o600);
    await handle.writeFile('*\n!.gitignore\n', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await handle?.close();
  }
}

export async function readFeedback(options: ReadFeedbackOptions = {}): Promise<CopyFeedbackRecord[]> {
  const target = await assertSafeRealPath(options);
  if (options.styleId !== undefined) validateStyleId(options.styleId);
  if (!(await exists(target))) return [];
  const stats = await lstat(target);
  if (!stats.isFile()) throw new Error('Feedback path must identify a regular file.');
  if (stats.size > maximumFeedbackBytes) throw new Error('Feedback store exceeds the 16 MiB limit.');
  const content = await readFile(target, 'utf8');
  const records: CopyFeedbackRecord[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? '';
    if (index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid feedback JSONL at line ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let record: CopyFeedbackRecord;
    try {
      record = validateFeedbackRecord(parsed);
    } catch (error) {
      throw new Error(`Invalid feedback record at line ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.styleId === undefined || record.styleId === options.styleId) records.push(record);
  }
  return records;
}

interface FeedbackWriteLock {
  release(): Promise<void>;
}

interface LockRecord {
  pid: number;
  token: string;
}

function parseLockRecord(value: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Number.isSafeInteger((parsed as Record<string, unknown>).pid)
      && ((parsed as Record<string, unknown>).pid as number) > 0
      && typeof (parsed as Record<string, unknown>).token === 'string'
    ) {
      return {
        pid: (parsed as Record<string, unknown>).pid as number,
        token: (parsed as Record<string, unknown>).token as string,
      };
    }
  } catch {
    // A writer may have created the lock but not finished its small payload yet.
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  let stats;
  let content: string;
  try {
    stats = await lstat(lockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    content = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const record = parseLockRecord(content);
  const abandoned = record ? !processIsAlive(record.pid) : Date.now() - stats.mtimeMs > 30_000;
  if (!abandoned) return false;
  try {
    const current = await lstat(lockPath);
    if (current.dev !== stats.dev || current.ino !== stats.ino || await readFile(lockPath, 'utf8') !== content) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function acquireFeedbackWriteLock(target: string): Promise<FeedbackWriteLock> {
  const lockPath = `${target}.lock`;
  const maximumAttempts = 100;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return {
        async release() {
          let owned;
          try {
            owned = await handle.stat();
          } finally {
            await handle.close();
          }
          try {
            const current = await lstat(lockPath);
            const record = parseLockRecord(await readFile(lockPath, 'utf8'));
            if (current.dev === owned.dev && current.ino === owned.ino && record?.token === token) {
              await unlink(lockPath);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeAbandonedLock(lockPath)) continue;
      await delay(50);
    }
  }
  throw new Error('Feedback store is busy; retry the operation.');
}

export async function appendFeedback(
  input: CopyFeedbackInput,
  options: AppendFeedbackOptions = {},
): Promise<CopyFeedbackRecord> {
  const record = createFeedbackRecord(input, options);
  const target = await assertSafeRealPath(options);
  await mkdir(path.dirname(target), { recursive: true });
  // Re-check after creating missing directories so a pre-existing symlink cannot redirect the write.
  await assertSafeRealPath(options);
  await ensureDefaultFeedbackIsPrivate(options, target);
  const lock = await acquireFeedbackWriteLock(target);
  try {
    const existing = await readFeedback(options);
    const duplicate = existing.find((item) => item.id === record.id);
    if (duplicate) return duplicate;
    await assertSafeRealPath(options);
    const handle = await open(target, 'a+', 0o600);
    try {
      const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      const stats = await handle.stat();
      let prefixBytes = Buffer.alloc(0);
      if (stats.size > 0) {
        const finalByte = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(finalByte, 0, 1, stats.size - 1);
        if (bytesRead !== 1) throw new Error('Could not inspect the final byte of the feedback store.');
        if (finalByte[0] !== 0x0a) prefixBytes = Buffer.from('\n', 'utf8');
      }
      const appendBytes = prefixBytes.length === 0 ? recordBytes : Buffer.concat([prefixBytes, recordBytes]);
      if (stats.size + appendBytes.byteLength > maximumFeedbackBytes) {
        throw new Error('Appending feedback would exceed the 16 MiB limit.');
      }
      const currentStats = await handle.stat();
      if (currentStats.size !== stats.size) {
        throw new Error('Feedback store changed outside the MuncheKit write lock; retry the operation.');
      }
      await handle.writeFile(appendBytes);
    } finally {
      await handle.close();
    }
  } finally {
    await lock.release();
  }
  return record;
}
