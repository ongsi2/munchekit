import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendFeedback,
  createFeedbackRecord,
  DEFAULT_FEEDBACK_PATH,
  feedbackAfter,
  readFeedback,
  resolveFeedbackPath,
  validateFeedbackRecord,
} from '../src/feedback.js';
import type { CopyFeedbackInput } from '../src/feedback.js';

const fixedTime = '2026-08-25T06:00:00.000Z';
const temporaryRoots: string[] = [];
const maximumFeedbackBytes = 16 * 1024 * 1024;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'munche-feedback-'));
  temporaryRoots.push(root);
  return root;
}

function input(overrides: Partial<CopyFeedbackInput> = {}): CopyFeedbackInput {
  return {
    styleId: 'gounseon',
    decision: 'accepted',
    before: '기존 문구',
    proposal: '다듬은 문구',
    reasonTags: ['direct', 'natural'],
    ruleIds: ['KO-ATTACH-001'],
    lockedClaims: ['치료 기간'],
    engineVersion: '0.3.0-test',
    ...overrides,
  } as CopyFeedbackInput;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('copy feedback records', () => {
  it('normalizes all decision variants and assigns content-derived IDs', () => {
    const accepted = createFeedbackRecord(input({
      reasonTags: ['natural', 'direct', 'natural'],
      source: { filePath: './pages\\home.html', format: 'html', range: { start: 3, end: 8 } },
    }), { createdAt: fixedTime });
    const repeated = createFeedbackRecord(input(), { createdAt: '2026-08-26T06:00:00.000Z' });
    const acceptedWithoutSource = createFeedbackRecord(input(), { createdAt: fixedTime });
    const edited = createFeedbackRecord(input({ decision: 'edited', proposal: '첫 제안', after: '직접 고친 문구' }), {
      createdAt: fixedTime,
    });
    const rejected = createFeedbackRecord(input({ decision: 'rejected', proposal: '마음에 들지 않는 제안' }), {
      createdAt: fixedTime,
    });
    const kept = createFeedbackRecord({
      styleId: 'gounseon',
      decision: 'kept',
      before: '기존 문구',
      reasonTags: ['direct'],
      ruleIds: [],
      lockedClaims: [],
      engineVersion: '0.3.0-test',
    }, { createdAt: fixedTime });

    expect(accepted.id).toMatch(/^fb_[a-f0-9]{32}$/u);
    expect(repeated.id).toBe(acceptedWithoutSource.id);
    expect(repeated.createdAt).not.toBe(acceptedWithoutSource.createdAt);
    expect(accepted.reasonTags).toEqual(['direct', 'natural']);
    expect(accepted.source?.filePath).toBe('pages/home.html');
    expect(feedbackAfter(accepted)).toBe('다듬은 문구');
    expect(feedbackAfter(edited)).toBe('직접 고친 문구');
    expect(feedbackAfter(rejected)).toBe('기존 문구');
    expect(feedbackAfter(kept)).toBe('기존 문구');
    expect(new Set([accepted.id, edited.id, rejected.id, kept.id]).size).toBe(4);
  });

  it('validates stored invariants and rejects tampering or unsafe metadata', () => {
    const record = createFeedbackRecord(input(), { createdAt: fixedTime });
    expect(validateFeedbackRecord(JSON.parse(JSON.stringify(record)) as unknown)).toEqual(record);

    expect(() => validateFeedbackRecord({ ...record, id: `fb_${'0'.repeat(32)}` })).toThrow(/does not match/u);
    expect(() => validateFeedbackRecord({ ...record, after: '몰래 바꾼 문구' })).toThrow(/after must equal proposal/u);
    expect(() => validateFeedbackRecord({ ...record, reasonTags: undefined })).toThrow(/reasonTags is required/u);
    expect(() => validateFeedbackRecord({ ...record, createdAt: 'not-a-date' })).toThrow(/valid date/u);
    expect(() => createFeedbackRecord(input({ styleId: '../outside' }), { createdAt: fixedTime })).toThrow(/styleId/u);
    expect(() => createFeedbackRecord(input({ source: { filePath: '../secret.txt' } }), { createdAt: fixedTime })).toThrow(
      /parent traversal/u,
    );
    expect(() => createFeedbackRecord(input({ source: { url: 'file:///secret.txt' } }), { createdAt: fixedTime })).toThrow(
      /HTTP\(S\)/u,
    );
  });
});

describe('feedback JSONL storage', () => {
  it('appends, reads, de-duplicates, and filters records by style profile', async () => {
    const root = await temporaryRoot();
    const first = await appendFeedback(input(), { workspaceRoot: root, createdAt: fixedTime });
    const duplicate = await appendFeedback(input(), {
      workspaceRoot: root,
      createdAt: '2026-08-26T06:00:00.000Z',
    });
    const second = await appendFeedback(input({
      styleId: 'another-style',
      decision: 'edited',
      proposal: '초안',
      after: '최종안',
    }), { workspaceRoot: root, createdAt: fixedTime });

    expect(duplicate).toEqual(first);
    expect(await readFeedback({ workspaceRoot: root })).toEqual([first, second]);
    expect(await readFeedback({ workspaceRoot: root, styleId: 'gounseon' })).toEqual([first]);
    expect(await readFeedback({ workspaceRoot: root, styleId: 'missing' })).toEqual([]);
    const lines = (await readFile(resolveFeedbackPath({ workspaceRoot: root }), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(await readFile(path.join(root, '.munche', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
  });

  it('preserves valid JSONL when the existing final line has no newline', async () => {
    const root = await temporaryRoot();
    const store = resolveFeedbackPath({ workspaceRoot: root });
    await mkdir(path.dirname(store), { recursive: true });
    const first = createFeedbackRecord(input(), { createdAt: fixedTime });
    await writeFile(store, JSON.stringify(first), 'utf8');

    await appendFeedback(input({ styleId: 'second-style' }), { workspaceRoot: root, createdAt: fixedTime });

    expect(await readFeedback({ workspaceRoot: root })).toHaveLength(2);
    expect(await readFile(store, 'utf8')).toContain('}\n{');
  });

  it('reports malformed JSON and invalid records with their JSONL line number', async () => {
    const root = await temporaryRoot();
    const store = resolveFeedbackPath({ workspaceRoot: root });
    await mkdir(path.dirname(store), { recursive: true });
    await writeFile(store, '{}\nnot-json\n', 'utf8');
    await expect(readFeedback({ workspaceRoot: root })).rejects.toThrow(/record at line 1/u);

    await writeFile(store, `${JSON.stringify(createFeedbackRecord(input(), { createdAt: fixedTime }))}\nnot-json\n`, 'utf8');
    await expect(readFeedback({ workspaceRoot: root })).rejects.toThrow(/JSONL at line 2/u);
  });

  it('rejects an oversized feedback store before parsing it', async () => {
    const root = await temporaryRoot();
    const store = resolveFeedbackPath({ workspaceRoot: root });
    await mkdir(path.dirname(store), { recursive: true });
    await writeFile(store, Buffer.alloc(16 * 1024 * 1024 + 1));

    await expect(readFeedback({ workspaceRoot: root })).rejects.toThrow(/16 MiB/u);
  });

  it('allows an append whose UTF-8 bytes end exactly at the storage limit', async () => {
    const root = await temporaryRoot();
    const store = resolveFeedbackPath({ workspaceRoot: root });
    await mkdir(path.dirname(store), { recursive: true });
    const record = createFeedbackRecord(input(), { createdAt: fixedTime });
    const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const padding = Buffer.alloc(maximumFeedbackBytes - recordBytes.byteLength, 0x20);
    padding[padding.length - 1] = 0x0a;
    await writeFile(store, padding);

    const appended = await appendFeedback(input(), { workspaceRoot: root, createdAt: fixedTime });

    expect(appended).toEqual(record);
    expect((await stat(store)).size).toBe(maximumFeedbackBytes);
    expect(await readFeedback({ workspaceRoot: root })).toEqual([record]);
  });

  it('counts a missing-line-break prefix and leaves the store unchanged when an append would overflow', async () => {
    const root = await temporaryRoot();
    const store = resolveFeedbackPath({ workspaceRoot: root });
    await mkdir(path.dirname(store), { recursive: true });
    const record = createFeedbackRecord(input(), { createdAt: fixedTime });
    const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const original = Buffer.alloc(maximumFeedbackBytes - recordBytes.byteLength, 0x20);
    await writeFile(store, original);

    await expect(appendFeedback(input(), { workspaceRoot: root, createdAt: fixedTime })).rejects.toThrow(/16 MiB/u);

    const unchanged = await readFile(store);
    expect(unchanged.equals(original)).toBe(true);
    expect((await stat(store)).size).toBe(original.byteLength);
  });

  it('serializes concurrent writers and keeps identical feedback idempotent', async () => {
    const root = await temporaryRoot();
    const results = await Promise.all(Array.from({ length: 12 }, () => (
      appendFeedback(input(), { workspaceRoot: root, createdAt: fixedTime })
    )));

    expect(new Set(results.map((record) => record.id)).size).toBe(1);
    expect(await readFeedback({ workspaceRoot: root })).toHaveLength(1);
    await expect(stat(`${resolveFeedbackPath({ workspaceRoot: root })}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps custom storage paths inside the workspace', async () => {
    const root = await temporaryRoot();
    expect(resolveFeedbackPath({ workspaceRoot: root })).toBe(path.join(root, ...DEFAULT_FEEDBACK_PATH.split('/')));
    expect(resolveFeedbackPath({ workspaceRoot: root, filePath: 'data/copy.jsonl' })).toBe(
      path.join(root, 'data', 'copy.jsonl'),
    );
    expect(() => resolveFeedbackPath({ workspaceRoot: root, filePath: '../outside.jsonl' })).toThrow(/parent traversal/u);
    expect(() => resolveFeedbackPath({ workspaceRoot: root, filePath: path.join(root, 'absolute.jsonl') })).toThrow(
      /workspace-relative/u,
    );
    expect(() => resolveFeedbackPath({ workspaceRoot: root, filePath: 'feedback.json' })).toThrow(/\.jsonl/u);
  });

  it('rejects a storage directory symlinked outside the workspace', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, '.munche'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readFeedback({ workspaceRoot: root })).rejects.toThrow(/outside the workspace/u);
    await expect(appendFeedback(input(), { workspaceRoot: root, createdAt: fixedTime })).rejects.toThrow(
      /outside the workspace/u,
    );
  });
});
