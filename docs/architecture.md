# Architecture

MuncheKit separates four concerns that are often collapsed into one prompt.

```text
source file
  → format-aware extraction
  → protected-range masking
  → deterministic rule findings
  → safe TextEdit[] or review-only suggestions
  → optional provider rewrite
  → invariant verification
```

## 1. Extraction before language rules

The engine first creates a same-length analysis mask. Characters that belong to prose stay at their original UTF-16 offsets; code and syntax become spaces while line breaks remain. Alongside it, `proseRanges` records the exact contiguous spans lexical rules may inspect. Every lexical regex runs per prose-range/block intersection, so whitespace masking cannot bridge JSON values, tags, code, placeholders, or paragraphs.

- Markdown/MDX: `mdast` text nodes, selected MDX attributes, and raw HTML parsed through `parse5`
- JSON/JSONC: string values reported by `jsonc-parser` (diagnostics and review-only edits)
- HTML: text nodes and selected user-facing attributes from `parse5`
- JS/JSX/TS/TSX: JSX text, selected user-facing attributes, and Korean string values from the Babel parser; generic program strings are review-only
- Plain text: the complete input

Parse errors produce `KO-PARSE-001`. The engine does not fall back to plain text because that could turn imports, code examples, or object keys into false findings.

## 2. Findings, not a single score

Each rule returns a source range and evidence. The engine adds line/column locations, an excerpt, severity, confidence, and fixability.

```ts
interface Diagnostic {
  ruleId: string;
  severity: 'info' | 'warning' | 'error';
  confidence: number;
  range: { start: number; end: number };
  location: SourceLocation;
  rationale: string;
  suggestions: Suggestion[];
  fixability: 'safe' | 'review' | 'none';
  fix?: TextEdit;
}
```

A universal “human score” would hide disagreement between genres and authors. MuncheKit reports separate, inspectable findings instead.

## 3. Edit safety

`safe` means the rule pack treats the edit as context-independent and meaning-preserving. `review` means a candidate can be useful but a person must decide. `none` means the rule only points to a structural issue.

Before applying edits, the engine:

1. sorts candidate edits by source offset and confidence;
2. sends overlaps to `conflicts` instead of picking silently;
3. assembles non-overlapping edits in one source-order pass;
4. always enforces an explicitly supplied change limit and applies the default runaway-batch guard to longer documents;
5. returns the original text when the change limit is exceeded.

Safe fixes must be idempotent: `fix(fix(text)) === fix(text)`.

Rule safety and source safety are separate. Even a context-independent punctuation or spacing rule is downgraded to `review` inside JSON values and generic program strings, where text may be an opaque key, pattern, or protocol value. Explicit JSX text and allowlisted user-facing attributes keep the rule's declared safety.

## 4. Optional provider boundary

The core knows only the `RewriteProvider` interface. `AnthropicProvider` is one adapter; a local model can implement the same interface.

Before a provider call, MuncheKit extracts only editable, sentence-bounded Korean segments. The provider returns the same segment IDs; MuncheKit applies those replacements to the untouched local source. Code, source syntax, URLs, explicit preserve terms/patterns, quoted spans, and numbers stay outside segment text. Negation and modality remain inside the segment so the provider can change their inflection or position without losing their meaning. Local diagnostic excerpts are not included; only findings that overlap the segment and their review suggestions are attached.

After reconstruction, MuncheKit reparses the candidate, compares a structure signature and exact protected-value multiset, and binds normalized negation/modality anchors to a neighboring predicate and relation class. Thus moving `안` to another predicate or changing `않고` into an unapproved causal form is rejected; an exact local suggestion can authorize its own specific `않고 → 않습니다` transition. Non-exact edits also preserve tense, host-bound case-particle roles such as subject and object, and sentence force such as statement, question, or exclamation. A counted lexical guard allows only the additions and deletions encoded by exact deterministic replacements. Small token-level findings without replacements can authorize local deletion, but sentence-level register, rhythm, and readability spans cannot. Non-exact edits must preserve the relative order of shared content words; deterministic replacements are the only order-changing authorization. Character-change limits remain a damage bound, not a semantic-equivalence score.

Provider output must be one strict JSON object with the original segment IDs and no extra prose or fields. HTTPS is required by default, redirects are rejected, and provider responses have time and size limits. A failed candidate never replaces the original.

This guard is a damage limiter, not a proof of semantic equivalence. All provider output remains review-only.

## 5. Suppression and configuration

Rules resolve in this order:

```text
per-run override → profile override → rule default
```

Source directives are applied after a finding is created, so a directive can target one rule without hiding the text from all other checks.

User `preservePatterns` are length- and count-bounded and allow at most one repetition node; repeated alternation and backreferences are also rejected before JavaScript evaluates them. This deliberately rejects some safe expressions to reduce ReDoS risk. It is still not a proof for arbitrary regular expressions, so keep configuration files trusted and prefer literal `preserveTerms` when possible.

## Non-goals

- author or AI-origin detection
- adversarial detector evasion
- universal Korean grammar correction
- factual verification
- automatically enforcing one person's voice on every genre
