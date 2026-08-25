import pc from 'picocolors';

import { ruleCatalog } from './rules.js';
import type { AnalysisReport, Diagnostic, Severity } from './types.js';

function severityLabel(severity: Severity, color: boolean): string {
  const value = severity.padEnd(7);
  if (!color) return value;
  if (severity === 'error') return pc.red(value);
  if (severity === 'warning') return pc.yellow(value);
  return pc.blue(value);
}

function terminalText(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '�');
}

export function prettyReport(report: AnalysisReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? true;
  const file = terminalText(report.filePath ?? '<text>');
  if (!report.diagnostics.length) return `${color ? pc.green('✓') : '✓'} ${file}: 문제 없음`;
  const lines = report.diagnostics.flatMap((diagnostic) => {
    const where = `${file}:${String(diagnostic.location.start.line)}:${String(diagnostic.location.start.column)}`;
    const id = color ? pc.dim(diagnostic.ruleId) : diagnostic.ruleId;
    const fix = diagnostic.fix?.safety === 'safe' ? (color ? pc.green(' [safe fix]') : ' [safe fix]') : '';
    const rationale = `  ↳ 근거 (${String(Math.round(diagnostic.confidence * 100))}%): ${terminalText(diagnostic.rationale)}`;
    const suggestionLines = diagnostic.suggestions.flatMap((suggestion, index) => {
      const suffix = diagnostic.suggestions.length > 1 ? ` ${String(index + 1)}` : '';
      const lines = [`  ↳ 제안${suffix}: ${terminalText(suggestion.message)}`];
      if (suggestion.replacement) lines.push(`  ↳ 범위 교체${suffix}: ${terminalText(suggestion.replacement)}`);
      return lines.map((line) => (color ? pc.dim(line) : line));
    });
    return [
      `${where}  ${severityLabel(diagnostic.severity, color)}  ${terminalText(diagnostic.message)}  ${id}${fix}`,
      `  ${color ? pc.dim(terminalText(diagnostic.excerpt)) : terminalText(diagnostic.excerpt)}`,
      color ? pc.dim(rationale) : rationale,
      ...suggestionLines,
    ];
  });
  lines.push(
    `${String(report.summary.error)} error · ${String(report.summary.warning)} warning · ${String(report.summary.info)} info · ${String(report.summary.fixable)} safe fix`,
  );
  return lines.join('\n');
}

export function jsonReport(reports: AnalysisReport[]): string {
  return JSON.stringify(
    {
      schemaVersion: '1.0',
      offsetEncoding: 'utf-16',
      reports,
      summary: reports.reduce(
        (total, report) => ({
          error: total.error + report.summary.error,
          warning: total.warning + report.summary.warning,
          info: total.info + report.summary.info,
          fixable: total.fixable + report.summary.fixable,
        }),
        { error: 0, warning: 0, info: 0, fixable: 0 },
      ),
    },
    null,
    2,
  );
}

function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  return severity === 'info' ? 'note' : severity;
}

function sarifResult(report: AnalysisReport, diagnostic: Diagnostic): object {
  return {
    ruleId: diagnostic.ruleId,
    level: sarifLevel(diagnostic.severity),
    message: { text: `${diagnostic.message} ${diagnostic.rationale}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: (report.filePath ?? '<text>').replace(/\\/g, '/') },
          region: {
            startLine: diagnostic.location.start.line,
            startColumn: diagnostic.location.start.column,
            endLine: diagnostic.location.end.line,
            endColumn: diagnostic.location.end.column,
            charOffset: diagnostic.range.start,
            charLength: diagnostic.range.end - diagnostic.range.start,
          },
        },
      },
    ],
    properties: {
      confidence: diagnostic.confidence,
      fixability: diagnostic.fixability,
      excerpt: diagnostic.excerpt,
    },
  };
}

export function sarifReport(reports: AnalysisReport[]): string {
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'MuncheKit',
              informationUri: 'https://github.com/ongsi2/munchekit',
              rules: ruleCatalog.map((rule) => ({
                id: rule.id,
                name: rule.name,
                shortDescription: { text: rule.description },
                helpUri: rule.docsUrl,
                defaultConfiguration: {
                  level: rule.defaultLevel === 'off' ? 'none' : sarifLevel(rule.defaultLevel),
                },
                properties: {
                  category: rule.category,
                  fixability: rule.fixability,
                  stability: rule.stability,
                },
              })),
            },
          },
          results: reports.flatMap((report) => report.diagnostics.map((diagnostic) => sarifResult(report, diagnostic))),
        },
      ],
    },
    null,
    2,
  );
}
