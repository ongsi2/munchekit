import type { ExtractedDocument } from './document.js';
import type { Fixability, RuleMeta, Severity, StyleProfile, Suggestion, TextRange } from './types.js';

export interface Sentence extends TextRange {
  text: string;
  register: 'plain' | 'polite' | 'casual' | 'unknown';
  ending?: string;
}

export interface FindingDraft {
  range: TextRange;
  message: string;
  rationale: string;
  confidence: number;
  suggestions?: Suggestion[];
  replacement?: string;
  fixability?: Fixability;
  severity?: Severity;
  /** Document-level findings may intentionally span immutable source syntax. */
  allowStructuralSpan?: boolean;
}

export interface RuleContext {
  document: ExtractedDocument;
  profile: StyleProfile;
  sentences: Sentence[];
}

export interface Rule {
  meta: RuleMeta;
  check(context: RuleContext): FindingDraft[];
}
