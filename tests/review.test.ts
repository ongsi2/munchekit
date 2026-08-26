import { describe, expect, it } from 'vitest';

import { analyze } from '../src/engine.js';
import { createFeedbackRecord } from '../src/feedback.js';
import { changedCharsRatio } from '../src/fixes.js';
import {
  createReviewSession,
  createRewriteReviewSession,
  hashReviewSession,
  hashReviewSource,
  resolveReviewSession,
  validateReviewDecisionDocument,
  validateRewriteReviewArtifact,
} from '../src/review.js';

describe('review sessions', () => {
  it('records exact accepted and edited decisions and applies only their ranges', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다. 결과가 저장되어진다.';
    const session = createReviewSession(source, analyze(source, { profile: 'web' }), 'gounseon');
    const attachment = session.items.find((item) => item.ruleId === 'KO-ATTACH-001');
    const passive = session.items.find((item) => item.ruleId === 'KO-VOICE-001');
    if (!attachment || !passive) throw new Error('expected review items');

    const result = resolveReviewSession(source, session, [
      { itemId: attachment.id, decision: 'accepted', proposalIndex: 0, lockedClaims: ['가지런한 치아'] },
      { itemId: passive.id, decision: 'edited', after: '된', reasonTags: ['직접 수정'] },
    ], {
      styleId: 'gounseon',
      engineVersion: 'test',
      source: { filePath: 'page.html' },
    });

    expect(result.text).toBe('가지런한 치아를 만들기 위해 서두르지 않습니다. 결과가 저장된다.');
    expect(result.feedback).toHaveLength(2);
    expect(result.feedback[0]).toMatchObject({
      styleId: 'gounseon',
      decision: 'accepted',
      proposal: '치아를 만들기 위해 서두르지 않습니다',
      lockedClaims: ['가지런한 치아'],
      ruleIds: ['KO-ATTACH-001'],
    });
    expect(result.feedback[1]).toMatchObject({ decision: 'edited', before: '되어진', after: '된' });
    expect(() => createFeedbackRecord(result.feedback[0]!)).not.toThrow();
  });

  it('records all rejected proposals without changing the source', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const session = createReviewSession(source, analyze(source, { profile: 'web' }));
    const item = session.items[0];
    if (!item) throw new Error('expected a review item');

    const result = resolveReviewSession(source, session, [
      { itemId: item.id, decision: 'rejected', reasonTags: ['원문 의도와 다름'] },
    ], { styleId: 'gounseon', engineVersion: 'test' });

    expect(result.text).toBe(source);
    expect(result.feedback).toHaveLength(2);
    expect(result.feedback.every((entry) => entry.decision === 'rejected')).toBe(true);
  });

  it('rejects stale, duplicate, missing, and invalid decisions', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const session = createReviewSession(source, analyze(source, { profile: 'web' }), 'gounseon');
    const item = session.items[0];
    if (!item) throw new Error('expected a review item');
    const options = { styleId: 'gounseon', engineVersion: 'test' };

    expect(session.sourceHash).toBe(hashReviewSource(source));
    const { sessionHash, ...sessionCore } = session;
    expect(sessionHash).toBe(hashReviewSession(sessionCore));
    expect(() => resolveReviewSession(`${source} 변경`, session, [], options)).toThrow(/원문이 바뀌어/u);
    expect(() => resolveReviewSession(source, { ...session, profile: 'business' }, [], options)).toThrow(/세션 내용이/u);
    expect(() => resolveReviewSession(source, session, session.items.map((entry) => ({
      itemId: entry.id,
      decision: 'kept' as const,
    })), { styleId: 'other-style', engineVersion: 'test' })).toThrow(/styleId/u);
    expect(() => resolveReviewSession(source, session, [], options)).toThrow(/결정하지 않은/u);
    expect(() => resolveReviewSession(source, session, [
      { itemId: item.id, decision: 'kept' },
      { itemId: item.id, decision: 'kept' },
    ], options)).toThrow(/중복/u);
    expect(() => resolveReviewSession(source, session, [
      { itemId: item.id, decision: 'accepted', proposalIndex: 99 },
    ], options)).toThrow(/proposalIndex/u);
    expect(validateReviewDecisionDocument({
      schemaVersion: '1.0',
      sourceHash: session.sourceHash,
      sessionHash: session.sessionHash,
      resolutions: [{ itemId: item.id, decision: 'kept' }],
    }).resolutions).toHaveLength(1);
    expect(() => validateReviewDecisionDocument({
      schemaVersion: '1.0',
      sourceHash: session.sourceHash,
      sessionHash: session.sessionHash,
      resolutions: [{ itemId: item.id, decision: 'invented' }],
    })).toThrow(/decision/u);
    expect(() => validateReviewDecisionDocument({
      schemaVersion: '1.0',
      sourceHash: session.sourceHash,
      sessionHash: session.sessionHash,
      resolutions: [{ itemId: item.id, decision: 'accepted', after: '무시되면 안 되는 값' }],
    })).toThrow(/after/u);
    expect(() => validateReviewDecisionDocument({
      schemaVersion: '1.0',
      sourceHash: session.sourceHash,
      sessionHash: session.sessionHash,
      resolutions: [
        { itemId: item.id, decision: 'kept' },
        { itemId: item.id, decision: 'kept' },
      ],
    })).toThrow(/중복/u);
  });

  it('keeps diagnostics without replacements reviewable through edit or keep', () => {
    const source = '성장 시기를 이용합니다. 치료 계획을 설명합니다. 초등 저학년 때 검진을 받아보세요.';
    const session = createReviewSession(source, analyze(source, { profile: 'web' }));
    const item = session.items.find((candidate) => candidate.ruleId === 'KO-REGISTER-001');
    if (!item) throw new Error('expected a register item');

    const resolutions = session.items.map((candidate) => (
      candidate.id === item.id
        ? { itemId: candidate.id, decision: 'kept' as const }
        : { itemId: candidate.id, decision: 'kept' as const }
    ));
    const result = resolveReviewSession(source, session, resolutions, {
      styleId: 'gounseon',
      engineVersion: 'test',
    });
    expect(result.text).toBe(source);
    expect(result.feedback.find((entry) => entry.ruleIds?.includes('KO-REGISTER-001'))?.decision).toBe('kept');
  });

  it('hands a guarded natural rewrite artifact into the same approval flow', () => {
    const source = '교정은 같은 의사를 만나는 일입니다.';
    const candidate = '처음 상담한 의사가 교정이 끝날 때까지 진료합니다.';
    const artifact = validateRewriteReviewArtifact({
      schemaVersion: '1.0',
      kind: 'munche-rewrite-result',
      engineVersion: 'test',
      sourceHash: hashReviewSource(source),
      filePath: 'page.html',
      format: 'plain',
      profile: 'web',
      mode: 'natural',
      styleProfile: 'gounseon',
      accepted: true,
      applied: false,
      provider: 'mock',
      changedCharsRatio: changedCharsRatio(source, candidate),
      violations: [],
      changes: [{
        before: source,
        after: candidate,
        reason: '승인 문체에 맞춤',
        ruleIds: [],
        segmentId: 'SEG_001_1234abcd',
        range: { start: 0, end: source.length },
      }],
      candidate,
      text: candidate,
    });
    const session = createRewriteReviewSession(source, artifact);
    const item = session.items[0];
    if (!item) throw new Error('expected a rewrite review item');
    const accepted = resolveReviewSession(source, session, [
      { itemId: item.id, decision: 'accepted', proposalIndex: 0 },
    ], { styleId: 'gounseon', engineVersion: 'test' });

    expect(accepted.text).toBe(candidate);
    expect(accepted.feedback[0]).toMatchObject({
      decision: 'accepted',
      before: source,
      proposal: candidate,
      ruleIds: ['REWRITE-NATURAL'],
    });
    expect(() => createRewriteReviewSession(source, { ...artifact, candidate: '변조된 결과' })).toThrow(/재구성/u);
    expect(() => validateRewriteReviewArtifact({ ...artifact, applied: true })).toThrow(/아직 적용하지 않은/u);
    expect(() => validateRewriteReviewArtifact({
      ...artifact,
      changes: [{ ...artifact.changes[0], reason: '\u001B[31m가짜 검토' }],
    })).toThrow(/제어 문자/u);
  });
});
