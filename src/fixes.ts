import { diffChars } from 'diff';

import type { AnalysisReport, Diagnostic, FixOptions, FixResult, TextEdit } from './types.js';

function overlaps(left: TextEdit, right: TextEdit): boolean {
  return left.start < right.end && right.start < left.end;
}

export function changedCharsRatio(before: string, after: string): number {
  if (before === after) return 0;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  // Myers diff can become superlinear on large, repetitive, widely changed
  // strings. For guardrail use, a conservative upper bound is preferable to a hang.
  if (beforeMiddle.length + afterMiddle.length > 20_000) {
    return Math.min(1, Math.max(beforeMiddle.length, afterMiddle.length) / Math.max(1, before.length, after.length));
  }
  const changes = diffChars(beforeMiddle, afterMiddle);
  const removed = changes.reduce((total, part) => total + (part.removed ? part.value.length : 0), 0);
  const added = changes.reduce((total, part) => total + (part.added ? part.value.length : 0), 0);
  return Math.min(1, Math.max(removed, added) / Math.max(1, before.length, after.length));
}

export function changedCharsRatioForEdits(before: string, after: string, edits: TextEdit[]): number {
  let removed = 0;
  let added = 0;
  for (const edit of edits) {
    for (const part of diffChars(before.slice(edit.start, edit.end), edit.replacement)) {
      if (part.removed) removed += part.value.length;
      if (part.added) added += part.value.length;
    }
  }
  return Math.min(1, Math.max(removed, added) / Math.max(1, before.length, after.length));
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const output: string[] = [];
  let cursor = 0;
  let previous: TextEdit | undefined;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new RangeError(`Invalid text edit range: ${String(edit.start)}..${String(edit.end)}`);
    }
    if (previous && overlaps(edit, previous)) {
      throw new RangeError(`Overlapping text edits: ${String(edit.start)}..${String(edit.end)}`);
    }
    output.push(text.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
    previous = edit;
  }
  output.push(text.slice(cursor));
  return output.join('');
}

export function applyFixes(text: string, report: AnalysisReport, options: FixOptions = {}): FixResult {
  const safety = options.safety ?? 'safe';
  if (
    options.maxChangedCharsRatio !== undefined &&
    (!Number.isFinite(options.maxChangedCharsRatio) || options.maxChangedCharsRatio < 0 || options.maxChangedCharsRatio > 1)
  ) {
    throw new RangeError('maxChangedCharsRatio must be between 0 and 1.');
  }
  const maxChangedCharsRatio = options.maxChangedCharsRatio ?? 0.15;
  const candidates = report.diagnostics
    .filter((diagnostic) => diagnostic.fix && (safety === 'review' || diagnostic.fix.safety === 'safe'))
    .sort(
      (left, right) =>
        left.range.start - right.range.start || right.confidence - left.confidence || left.ruleId.localeCompare(right.ruleId),
    );

  const conflictSet = new Set<Diagnostic>();
  let furthest: Diagnostic | undefined;
  for (const candidate of candidates) {
    if (!candidate.fix) continue;
    if (furthest?.fix && overlaps(furthest.fix, candidate.fix)) {
      conflictSet.add(furthest);
      conflictSet.add(candidate);
    }
    if (!furthest?.fix || candidate.fix.end > furthest.fix.end || candidate.fix.start >= furthest.fix.end) {
      furthest = candidate;
    }
  }
  const conflicts = candidates.filter((diagnostic) => conflictSet.has(diagnostic));
  const selected = candidates.filter((diagnostic) => !conflictSet.has(diagnostic));
  const selectedSet = new Set(selected);
  const edits = selected.flatMap((diagnostic) => (diagnostic.fix ? [diagnostic.fix] : []));
  const output = applyTextEdits(text, edits);
  const ratio = changedCharsRatioForEdits(text, output, edits);
  // The ratio guard catches runaway batch edits. On very short snippets, one safe
  // replacement can dominate the ratio even though only a few characters changed.
  if ((options.maxChangedCharsRatio !== undefined || text.length >= 200) && ratio > maxChangedCharsRatio) {
    return {
      text,
      applied: [],
      skipped: [...report.diagnostics],
      conflicts,
      changedCharsRatio: ratio,
      limitExceeded: true,
    };
  }
  return {
    text: output,
    applied: selected,
    skipped: report.diagnostics.filter((diagnostic) => !selectedSet.has(diagnostic)),
    conflicts,
    changedCharsRatio: ratio,
    limitExceeded: false,
  };
}
