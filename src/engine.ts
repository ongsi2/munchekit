import {
  createDocument,
  excerptFor,
  isBlockRange,
  isProseRange,
  isReviewOnlyRange,
  isSuppressed,
  locationFor,
} from './document.js';
import { resolveProfile } from './profiles.js';
import { parseRuleMeta, rules, segmentSentences } from './rules.js';
import type { FindingDraft, Rule } from './rule-types.js';
import type {
  AnalysisReport,
  AnalyzeOptions,
  Diagnostic,
  RuleLevel,
  Severity,
  StyleProfile,
  TextRange,
} from './types.js';

export const ENGINE_VERSION = '0.2.0';

const severityOrder: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function resolveLevel(rule: Rule, profile: StyleProfile, options: AnalyzeOptions): RuleLevel {
  return options.rules?.[rule.meta.id] ?? profile.ruleLevels[rule.meta.id] ?? rule.meta.defaultLevel;
}

function toDiagnostic(
  rule: Rule,
  level: Severity,
  finding: FindingDraft,
  document: ReturnType<typeof createDocument>,
): Diagnostic {
  const declaredFixability = finding.fixability ?? rule.meta.fixability;
  const fixability = declaredFixability === 'safe' && isReviewOnlyRange(document, finding.range)
    ? 'review'
    : declaredFixability;
  const diagnostic: Diagnostic = {
    ruleId: rule.meta.id,
    category: rule.meta.category,
    severity: finding.severity ?? level,
    message: finding.message,
    rationale: finding.rationale,
    confidence: Math.max(0, Math.min(1, finding.confidence)),
    fixability,
    range: finding.range,
    location: locationFor(document, finding.range),
    excerpt: excerptFor(document, finding.range),
    suggestions: finding.suggestions ?? [],
  };
  if (finding.replacement !== undefined && fixability !== 'none') {
    diagnostic.fix = {
      ...finding.range,
      replacement: finding.replacement,
      safety: fixability,
    };
  }
  return diagnostic;
}

function parseDiagnostics(document: ReturnType<typeof createDocument>): Diagnostic[] {
  return document.parseErrors.map((error) => {
    const start = Math.max(0, Math.min(error.offset, document.text.length));
    const range: TextRange = { start, end: Math.min(document.text.length, start + 1) };
    return {
      ruleId: parseRuleMeta.id,
      category: parseRuleMeta.category,
      severity: 'error',
      message: error.message,
      rationale: '소스 구조를 안전하게 분리하지 못하면 코드와 콘텐츠를 구분해 검사할 수 없습니다.',
      confidence: 1,
      fixability: parseRuleMeta.fixability,
      range,
      location: locationFor(document, range),
      excerpt: excerptFor(document, range),
      suggestions: [{ message: '원본 파일의 구문 오류를 먼저 고쳐 주세요.', risk: 'low' }],
    };
  });
}

function deduplicate(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.ruleId}:${String(diagnostic.range.start)}:${String(diagnostic.range.end)}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyze(text: string, options: AnalyzeOptions = {}): AnalysisReport {
  const profile = resolveProfile(options.profile);
  const document = createDocument(text, options);
  const diagnostics = parseDiagnostics(document);
  if (!document.parseErrors.length) {
    const sentences = segmentSentences({ document });
    const context = { document, profile, sentences };
    for (const rule of rules) {
      const level = resolveLevel(rule, profile, options);
      if (level === 'off') continue;
      for (const finding of rule.check(context)) {
        if (finding.range.end <= finding.range.start) continue;
        if (!finding.allowStructuralSpan && !isProseRange(document, finding.range)) continue;
        if (!finding.allowStructuralSpan && !isBlockRange(document, finding.range)) continue;
        if (isSuppressed(document, rule.meta.id, finding.range)) continue;
        diagnostics.push(toDiagnostic(rule, level, finding, document));
      }
    }
  }

  const ordered = deduplicate(diagnostics).sort(
    (left, right) =>
      left.range.start - right.range.start ||
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.ruleId.localeCompare(right.ruleId),
  );
  return {
    schemaVersion: '1.0',
    engineVersion: ENGINE_VERSION,
    offsetEncoding: 'utf-16',
    ...(options.filePath ? { filePath: options.filePath } : {}),
    format: document.format,
    profile: profile.id,
    diagnostics: ordered,
    summary: {
      error: ordered.filter((item) => item.severity === 'error').length,
      warning: ordered.filter((item) => item.severity === 'warning').length,
      info: ordered.filter((item) => item.severity === 'info').length,
      fixable: ordered.filter((item) => item.fix?.safety === 'safe').length,
    },
  };
}
