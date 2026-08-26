import { createHash } from 'node:crypto';

import { applyTextEdits, changedCharsRatioForEdits } from './fixes.js';
import type { CopyFeedbackInput, CopyFeedbackSource } from './feedback.js';
import type { AnalysisReport, RewriteChange, SourceFormat, TextEdit, TextRange } from './types.js';

export const REVIEW_SESSION_SCHEMA_VERSION = '1.0' as const;

export interface ReviewProposal {
  text: string;
  message: string;
  risk: 'low' | 'medium' | 'high';
}

export interface ReviewItem {
  id: string;
  ruleId: string;
  ruleIds: string[];
  segmentId?: string;
  category: string;
  message: string;
  rationale: string;
  range: TextRange;
  before: string;
  proposals: ReviewProposal[];
}

export interface ReviewSession {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION;
  sourceHash: string;
  /** Hash of the engine version, profile, findings, and proposal contents. */
  sessionHash: string;
  engineVersion: string;
  filePath?: string;
  styleId?: string;
  format: AnalysisReport['format'];
  profile: string;
  items: ReviewItem[];
}

export interface ReviewResolution {
  itemId: string;
  decision: 'accepted' | 'edited' | 'rejected' | 'kept';
  proposalIndex?: number;
  after?: string;
  reasonTags?: string[];
  lockedClaims?: string[];
}

export interface ReviewDecisionDocument {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION;
  sourceHash: string;
  sessionHash: string;
  resolutions: ReviewResolution[];
}

export interface ResolveReviewOptions {
  styleId: string;
  engineVersion: string;
  source?: Omit<CopyFeedbackSource, 'format' | 'range'>;
}

export interface ResolvedReview {
  text: string;
  feedback: CopyFeedbackInput[];
  edits: TextEdit[];
}

export interface RewriteReviewArtifact {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION;
  kind: 'munche-rewrite-result';
  engineVersion: string;
  sourceHash: string;
  filePath?: string;
  format: Exclude<SourceFormat, 'auto'>;
  profile: string;
  mode: 'natural';
  styleProfile: string;
  accepted: true;
  applied: false;
  provider: string;
  changedCharsRatio: number;
  violations: [];
  changes: Array<RewriteChange & { segmentId: string; range: TextRange }>;
  candidate: string;
  text: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function itemId(sourceHash: string, ruleId: string, range: TextRange, before: string): string {
  return `review_${hash(`${sourceHash}:${ruleId}:${String(range.start)}:${String(range.end)}:${before}`).slice(0, 24)}`;
}

export function hashReviewSource(text: string): string {
  return `sha256:${hash(text)}`;
}

export function hashReviewSession(session: Omit<ReviewSession, 'sessionHash'>): string {
  return `sha256:${hash(JSON.stringify(stableValue(session)))}`;
}

function finalizeReviewSession(
  sourceHash: string,
  engineVersion: string,
  format: AnalysisReport['format'],
  profile: string,
  items: ReviewItem[],
  filePath?: string,
  styleId?: string,
): ReviewSession {
  const core: Omit<ReviewSession, 'sessionHash'> = {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    sourceHash,
    engineVersion,
    ...(filePath ? { filePath } : {}),
    ...(styleId ? { styleId } : {}),
    format,
    profile,
    items,
  };
  return { ...core, sessionHash: hashReviewSession(core) };
}

export function createReviewSession(text: string, report: AnalysisReport, styleId?: string): ReviewSession {
  const sourceHash = hashReviewSource(text);
  const items = report.diagnostics.map((diagnostic): ReviewItem => {
    if (
      diagnostic.range.start < 0 ||
      diagnostic.range.end <= diagnostic.range.start ||
      diagnostic.range.end > text.length
    ) {
      throw new Error(`Invalid diagnostic range for ${diagnostic.ruleId}.`);
    }
    const proposals: ReviewProposal[] = [];
    const seen = new Set<string>();
    for (const suggestion of diagnostic.suggestions) {
      if (suggestion.replacement === undefined || seen.has(suggestion.replacement)) continue;
      seen.add(suggestion.replacement);
      proposals.push({ text: suggestion.replacement, message: suggestion.message, risk: suggestion.risk });
    }
    const before = text.slice(diagnostic.range.start, diagnostic.range.end);
    return {
      id: itemId(sourceHash, diagnostic.ruleId, diagnostic.range, before),
      ruleId: diagnostic.ruleId,
      ruleIds: [diagnostic.ruleId],
      category: diagnostic.category,
      message: diagnostic.message,
      rationale: diagnostic.rationale,
      range: { ...diagnostic.range },
      before,
      proposals,
    };
  });
  return finalizeReviewSession(sourceHash, report.engineVersion, report.format, report.profile, items, report.filePath, styleId);
}

function selectedProposal(item: ReviewItem, resolution: ReviewResolution): ReviewProposal {
  const index = resolution.proposalIndex ?? (item.proposals.length === 1 ? 0 : -1);
  if (!Number.isSafeInteger(index) || index < 0 || index >= item.proposals.length) {
    throw new Error(`${item.id}에는 유효한 proposalIndex가 필요합니다.`);
  }
  const proposal = item.proposals[index];
  if (!proposal) throw new Error(`${item.id}의 제안을 찾지 못했습니다.`);
  return proposal;
}

function normalizedList(values: string[] | undefined, label: string, maximumItemLength: number): string[] {
  if ((values?.length ?? 0) > 200) throw new Error(`${label}는 200개를 넘을 수 없습니다.`);
  const normalized = (values ?? []).map((value, index) => {
    if (typeof value !== 'string') throw new Error(`${label}[${String(index)}]는 문자열이어야 합니다.`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label}[${String(index)}]는 비어 있을 수 없습니다.`);
    if (trimmed.length > maximumItemLength) {
      throw new Error(`${label}[${String(index)}]는 ${String(maximumItemLength)}자를 넘을 수 없습니다.`);
    }
    if (/[\u0000-\u001F\u007F]/u.test(trimmed)) {
      throw new Error(`${label}[${String(index)}]에 제어 문자를 사용할 수 없습니다.`);
    }
    return trimmed;
  });
  return [...new Set(normalized)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalStringArray(value: unknown, label: string, maximumItemLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label}는 문자열 배열이어야 합니다.`);
  }
  if (value.length > 200) throw new Error(`${label}는 200개를 넘을 수 없습니다.`);
  const normalized = (value as string[]).map((item, index) => {
    const trimmed = item.trim();
    if (!trimmed) throw new Error(`${label}[${String(index)}]는 비어 있을 수 없습니다.`);
    if (trimmed.length > maximumItemLength) {
      throw new Error(`${label}[${String(index)}]는 ${String(maximumItemLength)}자를 넘을 수 없습니다.`);
    }
    if (/[\u0000-\u001F\u007F]/u.test(trimmed)) {
      throw new Error(`${label}[${String(index)}]에 제어 문자를 사용할 수 없습니다.`);
    }
    return trimmed;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}에 중복 값을 사용할 수 없습니다.`);
  return normalized;
}

function artifactString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
  allowLayoutControls = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label}는 ${allowEmpty ? '문자열' : '비어 있지 않은 문자열'}이어야 합니다.`);
  }
  if (value.length > maximumLength) throw new Error(`${label}는 ${String(maximumLength)}자를 넘을 수 없습니다.`);
  const controls = allowLayoutControls ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u : /[\u0000-\u001F\u007F]/u;
  if (controls.test(value)) throw new Error(`${label}에 허용되지 않은 제어 문자가 있습니다.`);
  return value;
}

function artifactRange(value: unknown, label: string): TextRange {
  if (!isRecord(value)) throw new Error(`${label}는 객체여야 합니다.`);
  const unknown = Object.keys(value).filter((key) => key !== 'start' && key !== 'end');
  if (unknown.length) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown.join(', ')}`);
  if (
    !Number.isSafeInteger(value.start)
    || !Number.isSafeInteger(value.end)
    || (value.start as number) < 0
    || (value.end as number) <= (value.start as number)
  ) {
    throw new Error(`${label}는 end가 start보다 큰 UTF-16 정수 범위여야 합니다.`);
  }
  return { start: value.start as number, end: value.end as number };
}

export function validateRewriteReviewArtifact(value: unknown): RewriteReviewArtifact {
  if (!isRecord(value)) throw new Error('rewrite 결과 파일은 JSON 객체여야 합니다.');
  const allowed = new Set([
    'schemaVersion', 'kind', 'engineVersion', 'sourceHash', 'filePath', 'format', 'profile', 'mode',
    'styleProfile', 'accepted', 'applied', 'provider', 'changedCharsRatio', 'violations', 'changes',
    'candidate', 'text',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`rewrite 결과 파일에 알 수 없는 필드가 있습니다: ${unknown.join(', ')}`);
  if (value.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION || value.kind !== 'munche-rewrite-result') {
    throw new Error('지원하지 않는 rewrite 결과 형식입니다.');
  }
  if (value.mode !== 'natural' || value.accepted !== true || value.applied !== false) {
    throw new Error('review에는 아직 적용하지 않은, 가드를 통과한 natural rewrite 결과가 필요합니다.');
  }
  if (typeof value.sourceHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceHash)) {
    throw new Error('rewrite 결과 파일의 sourceHash가 올바르지 않습니다.');
  }
  const formats = new Set(['plain', 'markdown', 'mdx', 'json', 'html', 'tsx']);
  if (typeof value.format !== 'string' || !formats.has(value.format)) {
    throw new Error('rewrite 결과 파일의 format이 올바르지 않습니다.');
  }
  const styleProfile = artifactString(value.styleProfile, 'styleProfile', 64).trim();
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,62}[\p{L}\p{N}])?$/u.test(styleProfile)) {
    throw new Error('rewrite 결과 파일의 styleProfile이 올바르지 않습니다.');
  }
  if (
    typeof value.changedCharsRatio !== 'number'
    || !Number.isFinite(value.changedCharsRatio)
    || value.changedCharsRatio < 0
    || value.changedCharsRatio > 1
  ) {
    throw new Error('rewrite 결과 파일의 changedCharsRatio는 0 이상 1 이하여야 합니다.');
  }
  if (!Array.isArray(value.violations) || value.violations.length !== 0) {
    throw new Error('승인 검토용 rewrite 결과에는 violation이 없어야 합니다.');
  }
  if (!Array.isArray(value.changes) || value.changes.length > 2_000) {
    throw new Error('rewrite 결과 파일의 changes는 최대 2,000개의 배열이어야 합니다.');
  }
  const seenSegments = new Set<string>();
  const changes = value.changes.map((entry, index): RewriteReviewArtifact['changes'][number] => {
    if (!isRecord(entry)) throw new Error(`changes[${String(index)}]는 객체여야 합니다.`);
    const allowedChange = new Set(['before', 'after', 'reason', 'ruleIds', 'segmentId', 'range']);
    const unknownChange = Object.keys(entry).filter((key) => !allowedChange.has(key));
    if (unknownChange.length) {
      throw new Error(`changes[${String(index)}]에 알 수 없는 필드가 있습니다: ${unknownChange.join(', ')}`);
    }
    const segmentId = artifactString(entry.segmentId, `changes[${String(index)}].segmentId`, 200);
    if (!/^SEG_[0-9]+_[a-f0-9]{8}$/u.test(segmentId) || seenSegments.has(segmentId)) {
      throw new Error(`changes[${String(index)}].segmentId가 올바르지 않거나 중복되었습니다.`);
    }
    seenSegments.add(segmentId);
    const ruleIds = optionalStringArray(entry.ruleIds, `changes[${String(index)}].ruleIds`, 100);
    if (ruleIds === undefined) throw new Error(`changes[${String(index)}].ruleIds가 필요합니다.`);
    return {
      before: artifactString(entry.before, `changes[${String(index)}].before`, 100_000, false, true),
      after: artifactString(entry.after, `changes[${String(index)}].after`, 100_000, true, true),
      reason: artifactString(entry.reason, `changes[${String(index)}].reason`, 2_000),
      ruleIds,
      segmentId,
      range: artifactRange(entry.range, `changes[${String(index)}].range`),
    };
  });
  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    kind: 'munche-rewrite-result',
    engineVersion: artifactString(value.engineVersion, 'engineVersion', 100),
    sourceHash: value.sourceHash,
    ...(value.filePath === undefined ? {} : { filePath: artifactString(value.filePath, 'filePath', 1_000) }),
    format: value.format as RewriteReviewArtifact['format'],
    profile: artifactString(value.profile, 'profile', 100),
    mode: 'natural',
    styleProfile,
    accepted: true,
    applied: false,
    provider: artifactString(value.provider, 'provider', 200),
    changedCharsRatio: value.changedCharsRatio,
    violations: [],
    changes,
    candidate: artifactString(value.candidate, 'candidate', 10 * 1024 * 1024, true, true),
    text: artifactString(value.text, 'text', 10 * 1024 * 1024, true, true),
  };
}

export function createRewriteReviewSession(text: string, artifact: RewriteReviewArtifact): ReviewSession {
  artifact = validateRewriteReviewArtifact(artifact);
  if (artifact.sourceHash !== hashReviewSource(text)) {
    throw new Error('rewrite 결과의 sourceHash가 현재 원문과 다릅니다.');
  }
  const sourceHash = artifact.sourceHash;
  const edits: TextEdit[] = [];
  const items = artifact.changes.map((change): ReviewItem => {
    if (change.range.end > text.length || text.slice(change.range.start, change.range.end) !== change.before) {
      throw new Error(`rewrite 변경 ${change.segmentId}의 원문 범위가 현재 파일과 다릅니다.`);
    }
    edits.push({ ...change.range, replacement: change.after, safety: 'review' });
    const ruleIds = [...new Set(['REWRITE-NATURAL', ...change.ruleIds])];
    return {
      id: itemId(sourceHash, `REWRITE-NATURAL:${change.segmentId}`, change.range, change.before),
      ruleId: 'REWRITE-NATURAL',
      ruleIds,
      segmentId: change.segmentId,
      category: 'rewrite',
      message: change.reason,
      rationale: '보존 가드를 통과한 natural 재작성 제안입니다. 사람이 최종 표현과 사실을 다시 확인해야 합니다.',
      range: { ...change.range },
      before: change.before,
      proposals: [{ text: change.after, message: change.reason, risk: 'high' }],
    };
  });
  let reconstructed: string;
  try {
    reconstructed = applyTextEdits(text, edits);
  } catch (error) {
    throw new Error(`rewrite 변경 범위를 적용할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reconstructed !== artifact.candidate || artifact.text !== artifact.candidate) {
    throw new Error('rewrite 결과의 candidate가 changes에서 재구성한 내용과 다릅니다.');
  }
  const ratio = changedCharsRatioForEdits(text, reconstructed, edits);
  if (Math.abs(ratio - artifact.changedCharsRatio) > 1e-12) {
    throw new Error('rewrite 결과의 changedCharsRatio가 changes에서 계산한 값과 다릅니다.');
  }
  return finalizeReviewSession(
    sourceHash,
    artifact.engineVersion,
    artifact.format,
    artifact.profile,
    items,
    artifact.filePath,
    artifact.styleProfile,
  );
}

export function validateReviewDecisionDocument(value: unknown): ReviewDecisionDocument {
  if (!isRecord(value)) throw new Error('검토 결정 파일은 JSON 객체여야 합니다.');
  const unknownTopLevel = Object.keys(value).filter((key) => (
    key !== 'schemaVersion' && key !== 'sourceHash' && key !== 'sessionHash' && key !== 'resolutions'
  ));
  if (unknownTopLevel.length) throw new Error(`검토 결정 파일에 알 수 없는 필드가 있습니다: ${unknownTopLevel.join(', ')}`);
  if (value.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported review decision schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (typeof value.sourceHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceHash)) {
    throw new Error('검토 결정 파일의 sourceHash가 올바르지 않습니다.');
  }
  if (typeof value.sessionHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sessionHash)) {
    throw new Error('검토 결정 파일의 sessionHash가 올바르지 않습니다.');
  }
  if (!Array.isArray(value.resolutions) || value.resolutions.length > 2_000) {
    throw new Error('검토 결정 파일의 resolutions는 최대 2,000개의 배열이어야 합니다.');
  }
  const decisions = new Set(['accepted', 'edited', 'rejected', 'kept']);
  const seenItemIds = new Set<string>();
  const resolutions = value.resolutions.map((entry, index): ReviewResolution => {
    if (!isRecord(entry)) throw new Error(`resolutions[${String(index)}]는 객체여야 합니다.`);
    const unknown = Object.keys(entry).filter((key) => ![
      'itemId', 'decision', 'proposalIndex', 'after', 'reasonTags', 'lockedClaims',
    ].includes(key));
    if (unknown.length) throw new Error(`resolutions[${String(index)}]에 알 수 없는 필드가 있습니다: ${unknown.join(', ')}`);
    if (typeof entry.itemId !== 'string' || !/^review_[a-f0-9]{24}$/u.test(entry.itemId)) {
      throw new Error(`resolutions[${String(index)}].itemId가 올바르지 않습니다.`);
    }
    if (seenItemIds.has(entry.itemId)) {
      throw new Error(`resolutions[${String(index)}].itemId가 중복되었습니다.`);
    }
    seenItemIds.add(entry.itemId);
    if (typeof entry.decision !== 'string' || !decisions.has(entry.decision)) {
      throw new Error(`resolutions[${String(index)}].decision이 올바르지 않습니다.`);
    }
    if (
      entry.proposalIndex !== undefined &&
      (!Number.isSafeInteger(entry.proposalIndex) || (entry.proposalIndex as number) < 0)
    ) {
      throw new Error(`resolutions[${String(index)}].proposalIndex가 올바르지 않습니다.`);
    }
    if (entry.after !== undefined && typeof entry.after !== 'string') {
      throw new Error(`resolutions[${String(index)}].after는 문자열이어야 합니다.`);
    }
    if (typeof entry.after === 'string') {
      if (entry.after.length > 100_000) throw new Error(`resolutions[${String(index)}].after는 100000자를 넘을 수 없습니다.`);
      if (entry.after.includes('\0')) throw new Error(`resolutions[${String(index)}].after에 null 문자를 사용할 수 없습니다.`);
    }
    if (entry.decision === 'edited' && entry.after === undefined) {
      throw new Error(`resolutions[${String(index)}]의 edited 결정에는 after가 필요합니다.`);
    }
    if (entry.decision !== 'edited' && entry.after !== undefined) {
      throw new Error(`resolutions[${String(index)}]의 ${entry.decision as string} 결정에는 after를 사용할 수 없습니다.`);
    }
    const reasonTags = optionalStringArray(entry.reasonTags, `resolutions[${String(index)}].reasonTags`, 100);
    const lockedClaims = optionalStringArray(entry.lockedClaims, `resolutions[${String(index)}].lockedClaims`, 1_000);
    return {
      itemId: entry.itemId,
      decision: entry.decision as ReviewResolution['decision'],
      ...(entry.proposalIndex === undefined ? {} : { proposalIndex: entry.proposalIndex as number }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
      ...(reasonTags === undefined ? {} : { reasonTags }),
      ...(lockedClaims === undefined ? {} : { lockedClaims }),
    };
  });
  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    sourceHash: value.sourceHash,
    sessionHash: value.sessionHash,
    resolutions,
  };
}

export function resolveReviewSession(
  text: string,
  session: ReviewSession,
  resolutions: readonly ReviewResolution[],
  options: ResolveReviewOptions,
): ResolvedReview {
  if (session.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported review session schemaVersion: ${String(session.schemaVersion)}`);
  }
  const { sessionHash, ...sessionCore } = session;
  if (sessionHash !== hashReviewSession(sessionCore)) {
    throw new Error('검토 세션 내용이 생성된 뒤 바뀌어 결정을 적용하지 않았습니다.');
  }
  if (session.sourceHash !== hashReviewSource(text)) {
    throw new Error('검토를 시작한 뒤 원문이 바뀌어 결정을 적용하지 않았습니다.');
  }
  if (session.styleId && session.styleId !== options.styleId) {
    throw new Error(`검토 세션의 styleId(${session.styleId})와 적용할 styleId(${options.styleId})가 다릅니다.`);
  }
  const byId = new Map(session.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const feedback: CopyFeedbackInput[] = [];
  const edits: TextEdit[] = [];
  for (const resolution of resolutions) {
    if (!['accepted', 'edited', 'rejected', 'kept'].includes(resolution.decision)) {
      throw new Error(`알 수 없는 검토 결정입니다: ${String(resolution.decision)}`);
    }
    if (resolution.decision !== 'edited' && resolution.after !== undefined) {
      throw new Error(`${resolution.decision} 결정에는 after를 사용할 수 없습니다.`);
    }
    if (resolution.decision === 'edited') {
      if (typeof resolution.after !== 'string') throw new Error(`${resolution.itemId}의 edited 결정에는 after가 필요합니다.`);
      if (resolution.after.length > 100_000) throw new Error(`${resolution.itemId}의 after는 100000자를 넘을 수 없습니다.`);
      if (resolution.after.includes('\0')) throw new Error(`${resolution.itemId}의 after에 null 문자를 사용할 수 없습니다.`);
    }
    if (seen.has(resolution.itemId)) throw new Error(`중복된 검토 결정입니다: ${resolution.itemId}`);
    seen.add(resolution.itemId);
    const item = byId.get(resolution.itemId);
    if (!item) throw new Error(`현재 세션에 없는 검토 항목입니다: ${resolution.itemId}`);
    if (text.slice(item.range.start, item.range.end) !== item.before) {
      throw new Error(`검토 항목 ${item.id}의 원문 범위가 바뀌었습니다.`);
    }
    const reasonTags = normalizedList([item.category, ...(resolution.reasonTags ?? [])], 'reasonTags', 100);
    const lockedClaims = normalizedList(resolution.lockedClaims, 'lockedClaims', 1_000);
    const source: CopyFeedbackSource = {
      ...(options.source ?? {}),
      format: session.format,
      range: { ...item.range },
      ...(item.segmentId ? { segmentId: item.segmentId } : {}),
    };
    const base = {
      styleId: options.styleId,
      before: item.before,
      reasonTags,
      ruleIds: [...item.ruleIds],
      lockedClaims,
      source,
      engineVersion: options.engineVersion,
    } as const;

    if (resolution.decision === 'accepted') {
      const proposal = selectedProposal(item, resolution);
      feedback.push({ ...base, decision: 'accepted', proposal: proposal.text });
      edits.push({ ...item.range, replacement: proposal.text, safety: 'review' });
    } else if (resolution.decision === 'edited') {
      const after = resolution.after;
      if (after === undefined) throw new Error(`${item.id}의 edited 결정에는 after가 필요합니다.`);
      const proposal = resolution.proposalIndex === undefined
        ? undefined
        : selectedProposal(item, resolution).text;
      feedback.push({
        ...base,
        decision: 'edited',
        ...(proposal === undefined ? {} : { proposal }),
        after,
      });
      edits.push({ ...item.range, replacement: after, safety: 'review' });
    } else if (resolution.decision === 'rejected') {
      const rejected = resolution.proposalIndex === undefined
        ? item.proposals
        : [selectedProposal(item, resolution)];
      if (!rejected.length) throw new Error(`${item.id}에는 거절할 제안이 없습니다.`);
      for (const proposal of rejected) {
        feedback.push({ ...base, decision: 'rejected', proposal: proposal.text });
      }
    } else {
      const proposal = resolution.proposalIndex === undefined
        ? undefined
        : selectedProposal(item, resolution).text;
      feedback.push({ ...base, decision: 'kept', ...(proposal === undefined ? {} : { proposal }) });
    }
  }
  if (seen.size !== session.items.length) {
    const missing = session.items.filter((item) => !seen.has(item.id)).map((item) => item.id);
    throw new Error(`결정하지 않은 검토 항목이 있습니다: ${missing.join(', ')}`);
  }
  return { text: applyTextEdits(text, edits), feedback, edits };
}
