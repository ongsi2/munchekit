export type Severity = 'info' | 'warning' | 'error';
export type RuleLevel = Severity | 'off';
export type Fixability = 'safe' | 'review' | 'none';
export type RuleStability = 'experimental' | 'stable';
export type Register = 'preserve' | 'plain' | 'polite' | 'casual';
export type SourceFormat = 'auto' | 'plain' | 'markdown' | 'mdx' | 'json' | 'html' | 'tsx';

export interface TextRange {
  /** UTF-16 code-unit offset, matching JavaScript, TypeScript, and LSP conventions. */
  start: number;
  /** Exclusive UTF-16 code-unit offset. */
  end: number;
}

export interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}

export interface SourceLocation {
  start: SourcePosition;
  end: SourcePosition;
}

export interface TextEdit extends TextRange {
  replacement: string;
  safety: Exclude<Fixability, 'none'>;
}

export interface Suggestion {
  replacement?: string;
  message: string;
  risk: 'low' | 'medium' | 'high';
}

export interface Diagnostic {
  ruleId: string;
  category: string;
  severity: Severity;
  message: string;
  rationale: string;
  confidence: number;
  fixability: Fixability;
  range: TextRange;
  location: SourceLocation;
  excerpt: string;
  suggestions: Suggestion[];
  fix?: TextEdit;
}

export interface RuleMeta {
  id: string;
  name: string;
  category: string;
  description: string;
  defaultLevel: RuleLevel;
  fixability: Fixability;
  stability: RuleStability;
  docsUrl: string;
}

export interface StyleProfile {
  id: string;
  label: string;
  description: string;
  register: Register;
  maxSentenceLength: number;
  maxParagraphSentences: number;
  connectiveThreshold: number;
  ruleLevels: Record<string, RuleLevel>;
}

export type ProfileName = 'natural' | 'web' | 'tech-blog' | 'business' | 'thmm-tech';

export interface AnalyzeOptions {
  filePath?: string;
  format?: SourceFormat;
  profile?: ProfileName | StyleProfile;
  rules?: Record<string, RuleLevel>;
  preserveTerms?: string[];
  preservePatterns?: string[];
  ignoreQuotes?: boolean;
}

export interface ReportSummary {
  error: number;
  warning: number;
  info: number;
  fixable: number;
}

export interface AnalysisReport {
  schemaVersion: '1.0';
  engineVersion: string;
  offsetEncoding: 'utf-16';
  filePath?: string;
  format: Exclude<SourceFormat, 'auto'>;
  profile: string;
  diagnostics: Diagnostic[];
  summary: ReportSummary;
}

export interface FixOptions {
  safety?: 'safe' | 'review';
  maxChangedCharsRatio?: number;
}

export interface FixResult {
  text: string;
  applied: Diagnostic[];
  skipped: Diagnostic[];
  conflicts: Diagnostic[];
  changedCharsRatio: number;
  limitExceeded: boolean;
}

export interface MuncheConfig {
  profile?: ProfileName;
  files?: string[];
  ignore?: string[];
  preserveTerms?: string[];
  preservePatterns?: string[];
  ignoreQuotes?: boolean;
  rules?: Record<string, RuleLevel>;
  rewrite?: {
    maxChangedCharsRatio?: number;
  };
}

export interface RewriteProviderRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface RewriteProvider {
  readonly name: string;
  complete(request: RewriteProviderRequest): Promise<string>;
}

export interface RewriteChange {
  before: string;
  after: string;
  reason: string;
  ruleIds: string[];
}

export interface RewriteOptions extends AnalyzeOptions {
  provider: RewriteProvider;
  maxChangedCharsRatio?: number;
}

export interface RewriteResult {
  original: string;
  candidate?: string;
  text: string;
  accepted: boolean;
  violations: string[];
  changes: RewriteChange[];
  report: AnalysisReport;
  provider: string;
  changedCharsRatio: number;
}
