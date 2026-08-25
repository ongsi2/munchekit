import { parse as parseJavaScript } from '@babel/parser';
import type { Root as MdastRoot } from 'mdast';
import { visit as visitJson } from 'jsonc-parser';
import { parse as parseHtml } from 'parse5';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { compileUserPattern } from './patterns.js';
import type { AnalyzeOptions, SourceFormat, SourceLocation, TextRange } from './types.js';

interface PositionLike {
  offset?: number;
}

interface AstNode {
  type?: string;
  start?: number | null;
  end?: number | null;
  position?: {
    start?: PositionLike;
    end?: PositionLike;
  };
  [key: string]: unknown;
}

interface HtmlLocation {
  startOffset: number;
  endOffset: number;
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: HtmlLocation | null;
}

export interface Suppression {
  range: TextRange;
  ruleIds?: ReadonlySet<string>;
}

export interface ExtractedDocument {
  text: string;
  masked: string;
  format: Exclude<SourceFormat, 'auto'>;
  /** Contiguous source ranges that are eligible for lexical prose rules. */
  proseRanges: TextRange[];
  /** Prose ranges whose runtime meaning is unknown, so fixes must require review. */
  reviewOnlyRanges: TextRange[];
  blocks: TextRange[];
  lineStarts: number[];
  suppressions: Suppression[];
  parseErrors: Array<{ message: string; offset: number }>;
}

const supportedExtensions: Record<string, Exclude<SourceFormat, 'auto'>> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'mdx',
  '.json': 'json',
  '.jsonc': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.jsx': 'tsx',
  '.tsx': 'tsx',
  '.js': 'tsx',
  '.mjs': 'tsx',
  '.cjs': 'tsx',
  '.ts': 'tsx',
  '.mts': 'tsx',
  '.cts': 'tsx',
  '.txt': 'plain',
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

export function inferFormat(filePath?: string): Exclude<SourceFormat, 'auto'> {
  if (!filePath) return 'plain';
  const path = normalizePath(filePath);
  const dot = path.lastIndexOf('.');
  return dot === -1 ? 'plain' : (supportedExtensions[path.slice(dot)] ?? 'plain');
}

function isValidRange(range: TextRange, length: number): boolean {
  return range.start >= 0 && range.end > range.start && range.end <= length;
}

function mergeRanges(ranges: TextRange[], length: number): TextRange[] {
  const sorted = ranges
    .filter((range) => isValidRange(range, length))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function subtractRanges(ranges: TextRange[], excluded: TextRange[], length: number): TextRange[] {
  const sources = mergeRanges(ranges, length);
  const barriers = mergeRanges(excluded, length);
  const output: TextRange[] = [];
  let barrierIndex = 0;
  for (const source of sources) {
    while ((barriers[barrierIndex]?.end ?? Number.POSITIVE_INFINITY) <= source.start) barrierIndex += 1;
    let cursor = source.start;
    for (let index = barrierIndex; index < barriers.length; index += 1) {
      const barrier = barriers[index];
      if (!barrier) break;
      if (barrier.start >= source.end) break;
      if (barrier.start > cursor) output.push({ start: cursor, end: Math.min(barrier.start, source.end) });
      cursor = Math.max(cursor, barrier.end);
      if (cursor >= source.end) break;
    }
    if (cursor < source.end) output.push({ start: cursor, end: source.end });
    while ((barriers[barrierIndex]?.end ?? Number.POSITIVE_INFINITY) <= source.end) barrierIndex += 1;
  }
  return output.filter((range) => range.end > range.start);
}

function rangesContainedBySources(candidates: TextRange[], sources: TextRange[], length: number): TextRange[] {
  const orderedCandidates = candidates
    .filter((range) => isValidRange(range, length))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const orderedSources = mergeRanges(sources, length);
  const contained: TextRange[] = [];
  let sourceIndex = 0;
  for (const candidate of orderedCandidates) {
    while ((orderedSources[sourceIndex]?.end ?? Number.POSITIVE_INFINITY) <= candidate.start) sourceIndex += 1;
    const source = orderedSources[sourceIndex];
    if (source && candidate.start >= source.start && candidate.end <= source.end) contained.push(candidate);
  }
  return mergeRanges(contained, length);
}

function copyRanges(text: string, ranges: TextRange[]): string {
  // split('') intentionally works in UTF-16 code units. Parser offsets, JS string
  // slicing, diagnostics, and LSP all use the same encoding; Array.from would
  // collapse an astral emoji into one item and shift every following range.
  const output: string[] = text.split('').map((character) => (character === '\n' || character === '\r' ? character : ' '));
  for (const range of mergeRanges(ranges, text.length)) {
    for (let index = range.start; index < range.end; index += 1) {
      output[index] = text[index] ?? ' ';
    }
  }
  return output.join('');
}

function maskRanges(text: string, ranges: TextRange[]): string {
  const output = text.split('');
  for (const range of mergeRanges(ranges, text.length)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  }
  return output.join('');
}

function hasKorean(text: string): boolean {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(text);
}

function rangeFromPosition(node: AstNode): TextRange | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;
}

function walkObject(
  value: unknown,
  visitor: (node: AstNode, parent?: AstNode, key?: string, ancestors?: AstNode[]) => void,
): void {
  const seen = new Set<object>();
  const walk = (current: unknown, parent?: AstNode, key?: string, ancestors: AstNode[] = []): void => {
    if (!current || typeof current !== 'object') return;
    const object = current as AstNode;
    if (seen.has(object)) return;
    seen.add(object);
    visitor(object, parent, key, ancestors);
    for (const [childKey, child] of Object.entries(object)) {
      if (childKey === 'loc' || childKey === 'comments' || childKey === 'tokens' || childKey === 'errors') continue;
      if (Array.isArray(child)) {
        for (const item of child) walk(item, object, childKey, [...ancestors, object]);
      } else {
        walk(child, object, childKey, [...ancestors, object]);
      }
    }
  };
  walk(value);
}

const visibleHtmlAttributes = new Set(['alt', 'aria-label', 'content', 'placeholder', 'title']);
const visibleJsxAttributes = new Set([
  ...visibleHtmlAttributes,
  'label',
  'description',
  'message',
  'text',
  'heading',
  'caption',
  'helperText',
]);

function looksLikeSourceIdentifier(value: string): boolean {
  return /^(?:[./\\]|[a-z][a-z0-9+.-]*:)/iu.test(value);
}

function isUrlMetadataKey(value: string | undefined): boolean {
  return Boolean(value && /(?:^|:)(?:url|image|video|audio|player)(?::(?:url|secure_url))?$/iu.test(value));
}

function staticAttributeValue(attribute: AstNode): string | undefined {
  if (typeof attribute.value === 'string') return attribute.value;
  const value = attribute.value as AstNode | undefined;
  return typeof value?.value === 'string' ? value.value : undefined;
}

function isProtectedMdxMetaContent(attribute: AstNode, parent: AstNode | undefined): boolean {
  if (attribute.name !== 'content' || parent?.name !== 'meta') return false;
  const attributes = Array.isArray(parent.attributes) ? parent.attributes as AstNode[] : [];
  let refresh = false;
  let metadataKey: string | undefined;
  for (const candidate of attributes) {
    const name = typeof candidate.name === 'string' ? candidate.name.toLowerCase() : undefined;
    const value = staticAttributeValue(candidate);
    if ((name === 'httpequiv' || name === 'http-equiv') && value?.toLowerCase() === 'refresh') refresh = true;
    if (name === 'property' || name === 'name') metadataKey = value;
  }
  return refresh || isUrlMetadataKey(metadataKey);
}

function extractMarkdown(
  text: string,
  mdx: boolean,
  ignoreQuotes: boolean,
): {
  spans: TextRange[];
  blocks: TextRange[];
  suppressionSpans: TextRange[];
  errors: Array<{ message: string; offset: number }>;
} {
  const processor = unified().use(remarkParse);
  if (mdx) processor.use(remarkMdx);
  const tree = processor.parse(text) as MdastRoot;
  const spans: TextRange[] = [];
  const blocks: TextRange[] = [];
  const suppressionSpans: TextRange[] = [];
  const errors: Array<{ message: string; offset: number }> = [];
  walkObject(tree, (node, parent, _key, ancestors = []) => {
    const range = rangeFromPosition(node);
    if (!range) return;
    const insideBlockquote = ignoreQuotes && ancestors.some((ancestor) => ancestor.type === 'blockquote');
    if (node.type === 'text' && !insideBlockquote && hasKorean(text.slice(range.start, range.end))) spans.push(range);
    if (node.type === 'image' && typeof node.alt === 'string' && hasKorean(node.alt)) {
      const raw = text.slice(range.start, range.end);
      const closing = raw.indexOf('](', 2);
      const rawAlt = raw.startsWith('![') && closing >= 2 ? raw.slice(2, closing) : undefined;
      if (!insideBlockquote && rawAlt === node.alt && !/[\\&]/u.test(rawAlt)) {
        spans.push({ start: range.start + 2, end: range.start + closing });
      }
    }
    if (!insideBlockquote && node.type === 'mdxJsxAttribute' && typeof node.name === 'string' && visibleJsxAttributes.has(node.name) && typeof node.value === 'string' && hasKorean(node.value)) {
      if (looksLikeSourceIdentifier(node.value) || isProtectedMdxMetaContent(node, parent)) return;
      const valueRange = attributeValueRange(text, { startOffset: range.start, endOffset: range.end });
      if (valueRange) spans.push(valueRange);
    }
    if (node.type === 'html' && !insideBlockquote) {
      const raw = text.slice(range.start, range.end);
      if (hasKorean(raw) || /<!--\s*munche-/iu.test(raw)) {
        const extracted = extractHtml(raw, ignoreQuotes);
        const shifted = (item: TextRange): TextRange => ({
          start: range.start + item.start,
          end: range.start + item.end,
        });
        spans.push(...extracted.spans.map(shifted));
        blocks.push(...extracted.blocks.map(shifted));
        suppressionSpans.push(...extracted.suppressionSpans.map(shifted));
        errors.push(...extracted.errors.map((error) => ({
          message: error.message,
          offset: range.start + error.offset,
        })));
      }
    }
    if (node.type === 'paragraph' || node.type === 'heading') blocks.push(range);
  });
  const frontmatter = text.match(/^(?:\uFEFF)?(---|\+\+\+)[\t ]*\r?\n[\s\S]*?\r?\n\1[\t ]*(?:\r?\n|$)/u);
  if (!frontmatter) return { spans, blocks, suppressionSpans, errors };
  const protectedEnd = frontmatter[0].length;
  return {
    spans: spans.filter((range) => range.start >= protectedEnd),
    blocks: blocks.filter((range) => range.start >= protectedEnd),
    suppressionSpans: suppressionSpans.filter((range) => range.start >= protectedEnd),
    errors: errors.filter((error) => error.offset >= protectedEnd),
  };
}

function extractJson(text: string): { spans: TextRange[]; blocks: TextRange[]; errors: Array<{ message: string; offset: number }> } {
  const spans: TextRange[] = [];
  const errors: Array<{ message: string; offset: number }> = [];
  visitJson(
    text,
    {
      onLiteralValue(value, offset, length) {
        if (typeof value !== 'string' || !hasKorean(value)) return;
        const raw = text.slice(offset, offset + length);
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
          const content = raw.slice(1, -1);
          if (!content.includes('\\')) spans.push({ start: offset + 1, end: offset + length - 1 });
        }
      },
      onError(error, offset) {
        errors.push({ message: `JSON 파싱 오류(code ${String(error)})`, offset });
      },
    },
    { allowTrailingComma: true, disallowComments: false },
  );
  return { spans, blocks: [...spans], errors };
}

function attributeValueRange(text: string, location: { startOffset: number; endOffset: number }): TextRange | undefined {
  const raw = text.slice(location.startOffset, location.endOffset);
  const equals = raw.indexOf('=');
  if (equals === -1) return undefined;
  const afterEquals = raw.slice(equals + 1);
  const leading = afterEquals.length - afterEquals.trimStart().length;
  const valueStart = location.startOffset + equals + 1 + leading;
  const quote = text[valueStart];
  if (quote === '"' || quote === "'") {
    const closing = text.lastIndexOf(quote, location.endOffset - 1);
    return closing > valueStart ? { start: valueStart + 1, end: closing } : undefined;
  }
  return { start: valueStart, end: location.endOffset };
}

const htmlBlockElements = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'td', 'th', 'dt', 'dd',
]);
const protectedHtmlElements = new Set(['script', 'style', 'code', 'pre', 'template']);

function extractHtml(
  text: string,
  ignoreQuotes: boolean,
): {
  spans: TextRange[];
  blocks: TextRange[];
  suppressionSpans: TextRange[];
  errors: Array<{ message: string; offset: number }>;
} {
  const errors: Array<{ message: string; offset: number }> = [];
  const root = parseHtml(text, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === 'missing-doctype') return;
      errors.push({ message: `HTML 파싱 오류(${error.code})`, offset: error.startOffset });
    },
  }) as unknown as HtmlNode;
  const spans: TextRange[] = [];
  const flowSpans: TextRange[] = [];
  const blocks: TextRange[] = [];
  const suppressionSpans: TextRange[] = [];
  const walk = (node: HtmlNode, protectedParent = false): void => {
    const isProtectedElement = protectedParent || Boolean(
      node.tagName && (protectedHtmlElements.has(node.tagName) || (ignoreQuotes && node.tagName === 'blockquote')),
    );
    const location = node.sourceCodeLocation;
    const firstFlowSpan = flowSpans.length;
    if (!isProtectedElement && node.nodeName === '#comment' && location && /munche-/iu.test(node.data ?? node.value ?? '')) {
      suppressionSpans.push({ start: location.startOffset, end: location.endOffset });
    }
    if (!isProtectedElement && node.nodeName === '#text' && location && hasKorean(node.value ?? '')) {
      const range = { start: location.startOffset, end: location.endOffset };
      spans.push(range);
      flowSpans.push(range);
    }
    if (!isProtectedElement && location?.attrs && node.attrs) {
      const isMetaRefresh = node.tagName === 'meta' && node.attrs.some(
        (attribute) => attribute.name === 'http-equiv' && attribute.value.toLowerCase() === 'refresh',
      );
      const metadataKey = node.tagName === 'meta'
        ? node.attrs.find((attribute) => attribute.name === 'property' || attribute.name === 'name')?.value
        : undefined;
      for (const attribute of node.attrs) {
        if (!visibleHtmlAttributes.has(attribute.name) || !hasKorean(attribute.value)) continue;
        if (isMetaRefresh && attribute.name === 'content') continue;
        if (attribute.name === 'content' && isUrlMetadataKey(metadataKey)) continue;
        if (looksLikeSourceIdentifier(attribute.value)) continue;
        const attributeLocation = location.attrs[attribute.name];
        const range = attributeLocation ? attributeValueRange(text, attributeLocation) : undefined;
        if (range) {
          spans.push(range);
          blocks.push(range);
        }
      }
    }
    for (const child of node.childNodes ?? []) walk(child, isProtectedElement);
    if (node.content) walk(node.content, isProtectedElement);
    if (!isProtectedElement && node.tagName && htmlBlockElements.has(node.tagName)) {
      const descendants = flowSpans.slice(firstFlowSpan);
      const first = descendants[0];
      const last = descendants.at(-1);
      if (first && last) blocks.push({ start: first.start, end: last.end });
    }
  };
  walk(root);
  return { spans, blocks: blocks.length ? blocks : [...spans], suppressionSpans, errors };
}

const ignoredStringParents = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
  'TSLiteralType',
  'TSImportType',
  'ImportExpression',
  'SwitchCase',
  'ObjectMethod',
  'ClassMethod',
  'TSModuleDeclaration',
  'DirectiveLiteral',
]);

function astName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const name = (node as AstNode).name;
  return typeof name === 'string' ? name : undefined;
}

function jsxElementName(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'JSXElement') return undefined;
  const opening = node.openingElement as AstNode | undefined;
  return astName(opening?.name);
}

function isProtectedJsxMetaContent(attribute: AstNode, ancestors: AstNode[]): boolean {
  if (astName(attribute.name)?.toLowerCase() !== 'content') return false;
  const opening = [...ancestors].reverse().find((ancestor) => ancestor.type === 'JSXOpeningElement');
  if (!opening || astName(opening.name)?.toLowerCase() !== 'meta') return false;
  const attributes = Array.isArray(opening.attributes) ? opening.attributes as AstNode[] : [];
  let refresh = false;
  let metadataKey: string | undefined;
  for (const candidate of attributes) {
    if (candidate.type !== 'JSXAttribute') continue;
    const name = astName(candidate.name)?.toLowerCase();
    const staticValue = staticAttributeValue(candidate);
    if ((name === 'httpequiv' || name === 'http-equiv') && staticValue?.toLowerCase() === 'refresh') refresh = true;
    if (name === 'property' || name === 'name') metadataKey = staticValue;
  }
  return refresh || isUrlMetadataKey(metadataKey);
}

function isModuleOrComputedString(parent: AstNode | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property') return true;
  if (parent.type !== 'CallExpression' && parent.type !== 'NewExpression') return false;
  const callee = parent.callee as AstNode | undefined;
  return callee?.type === 'Import' || (callee?.type === 'Identifier' && callee.name === 'require');
}

function isProtectedJsxContext(ancestors: AstNode[], ignoreQuotes: boolean): boolean {
  return ancestors.some((ancestor) => {
    const name = jsxElementName(ancestor)?.toLowerCase();
    return Boolean(name && (
      ['code', 'pre', 'script', 'style'].includes(name) || (ignoreQuotes && name === 'blockquote')
    ));
  });
}

function isExecutableTemplateContext(ancestors: AstNode[]): boolean {
  return ancestors.some((ancestor) => {
    if (ancestor.type === 'TaggedTemplateExpression' || ancestor.type === 'ImportExpression') return true;
    if (ancestor.type !== 'CallExpression' && ancestor.type !== 'NewExpression') return false;
    const callee = ancestor.callee as AstNode | undefined;
    return callee?.type === 'Import' || (callee?.type === 'Identifier' && callee.name === 'require');
  });
}

function quotedContentRange(text: string, start: number, end: number): TextRange | undefined {
  const first = text[start];
  const last = text[end - 1];
  if ((first === '"' || first === "'") && last === first && !text.slice(start + 1, end - 1).includes('\\')) {
    return { start: start + 1, end: end - 1 };
  }
  return undefined;
}

function extractTsx(
  text: string,
  ignoreQuotes: boolean,
): {
  spans: TextRange[];
  reviewOnlySpans: TextRange[];
  blocks: TextRange[];
  errors: Array<{ message: string; offset: number }>;
  suppressionSpans: TextRange[];
} {
  const spans: TextRange[] = [];
  const reviewOnlySpans: TextRange[] = [];
  const flowSpans: TextRange[] = [];
  const elementRanges: Array<{ range: TextRange; name?: string }> = [];
  const errors: Array<{ message: string; offset: number }> = [];
  let ast: unknown;
  try {
    ast = parseJavaScript(text, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['jsx', 'typescript'],
    });
  } catch (error) {
    const withLocation = error as { message?: string; pos?: number };
    errors.push({ message: withLocation.message ?? 'TSX 파싱 오류', offset: withLocation.pos ?? 0 });
    return { spans, reviewOnlySpans, blocks: [], errors, suppressionSpans: [] };
  }
  walkObject(ast, (node, parent, key, ancestors = []) => {
    const start = node.start;
    const end = node.end;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    if (node.type === 'JSXElement') {
      const name = jsxElementName(node);
      elementRanges.push(name ? { range: { start, end }, name } : { range: { start, end } });
    }
    if (node.type === 'JSXText' && hasKorean(text.slice(start, end))) {
      if (isProtectedJsxContext(ancestors, ignoreQuotes)) return;
      const range = { start, end };
      spans.push(range);
      flowSpans.push(range);
      return;
    }
    if (node.type === 'StringLiteral' && hasKorean(text.slice(start, end))) {
      if (isProtectedJsxContext(ancestors, ignoreQuotes)) return;
      if (parent?.type && ignoredStringParents.has(parent.type)) return;
      if (parent?.type === 'ObjectProperty' && key === 'key') return;
      if (isModuleOrComputedString(parent, key)) return;
      const jsxAttribute = parent?.type === 'JSXAttribute'
        ? parent
        : [...ancestors].reverse().find((ancestor) => ancestor.type === 'JSXAttribute');
      if (jsxAttribute) {
        const attributeName = astName(jsxAttribute.name);
        if (!attributeName || !visibleJsxAttributes.has(attributeName)) return;
        if (isProtectedJsxMetaContent(jsxAttribute, ancestors)) return;
      }
      const range = quotedContentRange(text, start, end);
      if (range) {
        const value = text.slice(range.start, range.end);
        if (looksLikeSourceIdentifier(value)) return;
        spans.push(range);
        // A generic program string may be an opaque lookup key, regex, protocol
        // value, or API payload. Keep diagnostics, but never label its edit safe.
        if (!jsxAttribute) reviewOnlySpans.push(range);
        if (!jsxAttribute && ancestors.some((ancestor) => ancestor.type === 'JSXElement')) flowSpans.push(range);
      }
      return;
    }
    if (node.type === 'TemplateElement') {
      const raw = text.slice(start, end);
      if (
        hasKorean(raw) &&
        !raw.includes('\\') &&
        !looksLikeSourceIdentifier(raw) &&
        !isProtectedJsxContext(ancestors, ignoreQuotes) &&
        !isExecutableTemplateContext(ancestors)
      ) {
        const range = { start, end };
        spans.push(range);
        reviewOnlySpans.push(range);
        if (ancestors.some((ancestor) => ancestor.type === 'JSXElement')) flowSpans.push(range);
      }
    }
  });
  const parserErrors = (ast as { errors?: Array<{ message?: string; pos?: number }> }).errors ?? [];
  for (const error of parserErrors) {
    errors.push({ message: error.message ?? 'TSX 파싱 오류', offset: error.pos ?? 0 });
  }
  const blocks: TextRange[] = [];
  for (const element of elementRanges) {
    const isBlock = !element.name || htmlBlockElements.has(element.name) || /^[A-Z]/u.test(element.name);
    if (!isBlock) continue;
    const descendants = flowSpans.filter((span) => span.start >= element.range.start && span.end <= element.range.end);
    const first = descendants[0];
    const last = descendants.at(-1);
    if (first && last) blocks.push({ start: first.start, end: last.end });
  }
  return { spans, reviewOnlySpans, blocks: blocks.length ? blocks : [...spans], errors, suppressionSpans: [] };
}

function collectRegexRanges(text: string, expression: RegExp): TextRange[] {
  const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`;
  const regex = new RegExp(expression.source, flags);
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function quoteProtectionRanges(text: string): TextRange[] {
  return [
    /"(?:\\.|[^"\\\n])*"/gu,
    /“[^”]*”/gu,
    /‘[^’]*’/gu,
    /「[^」]*」/gu,
    /『[^』]*』/gu,
  ].flatMap((pattern) => collectRegexRanges(text, pattern));
}

function protectionRanges(text: string, options: AnalyzeOptions, format: Exclude<SourceFormat, 'auto'>): TextRange[] {
  const ranges: TextRange[] = [];
  const patterns = [
    /```[\s\S]*?```|~~~[\s\S]*?~~~/gu,
    /`[^`\n]+`/gu,
    /https?:\/\/[^\s<>"')\]]+/giu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    /\$\{[^}\n]+\}|\{\{[^}\n]+\}\}|%\([^)]+\)s|%[sd]/gu,
  ];
  for (const pattern of patterns) ranges.push(...collectRegexRanges(text, pattern));

  if (options.ignoreQuotes !== false) {
    ranges.push(...quoteProtectionRanges(text));
  }

  for (const term of options.preserveTerms ?? []) {
    if (!term) continue;
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(term, cursor);
      if (start === -1) break;
      ranges.push({ start, end: start + term.length });
      cursor = start + term.length;
    }
  }

  for (const source of options.preservePatterns ?? []) {
    try {
      ranges.push(...collectRegexRanges(text, compileUserPattern(source)));
    } catch {
      // Invalid user patterns are reported by configuration loading; the library stays non-throwing here.
    }
  }
  return ranges;
}

function plainBlocks(masked: string): TextRange[] {
  const blocks: TextRange[] = [];
  const separator = /(?:\r?\n)[\t \r]*\r?\n/gu;
  let cursor = 0;
  for (const match of masked.matchAll(separator)) {
    const end = match.index ?? cursor;
    if (hasKorean(masked.slice(cursor, end))) blocks.push(trimRange(masked, { start: cursor, end }));
    cursor = end + match[0].length;
  }
  if (hasKorean(masked.slice(cursor))) blocks.push(trimRange(masked, { start: cursor, end: masked.length }));
  return blocks.filter((range) => range.end > range.start);
}

function trimRange(text: string, range: TextRange): TextRange {
  let { start, end } = range;
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  return { start, end };
}

function parseRuleIds(raw: string): ReadonlySet<string> | undefined {
  const values = raw
    .trim()
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? new Set(values) : undefined;
}

function lineRangeAfter(text: string, offset: number, next: boolean): TextRange {
  const currentEnd = text.indexOf('\n', offset);
  const start = next ? (currentEnd === -1 ? text.length : currentEnd + 1) : text.lastIndexOf('\n', offset - 1) + 1;
  const endIndex = text.indexOf('\n', start);
  return { start, end: endIndex === -1 ? text.length : endIndex };
}

export function collectSuppressions(
  text: string,
  allowedSpans?: TextRange[],
  excludedSpans: TextRange[] = [],
): Suppression[] {
  const suppressions: Suppression[] = [];
  const active: Array<{ start: number; ruleIds?: ReadonlySet<string> }> = [];
  const directive = /<!--\s*munche-(disable-next-line|disable|enable|ignore)\b([^>]*)-->/giu;
  for (const match of text.matchAll(directive)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (allowedSpans && !allowedSpans.some((range) => start >= range.start && end <= range.end)) continue;
    if (excludedSpans.some((range) => start < range.end && range.start < end)) continue;
    const kind = match[1]?.toLowerCase();
    const ruleIds = parseRuleIds(match[2] ?? '');
    if (kind === 'disable') {
      active.push({ start: end, ...(ruleIds ? { ruleIds } : {}) });
    } else if (kind === 'enable') {
      const openedIndex = ruleIds
        ? active.findLastIndex((entry) => Boolean(entry.ruleIds && [...ruleIds].some((ruleId) => entry.ruleIds?.has(ruleId))))
        : active.length - 1;
      const opened = openedIndex >= 0 ? active.splice(openedIndex, 1)[0] : undefined;
      if (opened) suppressions.push({ range: { start: opened.start, end: start }, ...(opened.ruleIds ? { ruleIds: opened.ruleIds } : {}) });
    } else if (kind === 'disable-next-line') {
      suppressions.push({ range: lineRangeAfter(text, end, true), ...(ruleIds ? { ruleIds } : {}) });
    } else if (kind === 'ignore') {
      suppressions.push({ range: lineRangeAfter(text, start, false), ...(ruleIds ? { ruleIds } : {}) });
    }
  }
  for (const opened of active) {
    suppressions.push({ range: { start: opened.start, end: text.length }, ...(opened.ruleIds ? { ruleIds: opened.ruleIds } : {}) });
  }
  return suppressions;
}

export function isSuppressed(document: ExtractedDocument, ruleId: string, range: TextRange): boolean {
  return document.suppressions.some(
    (suppression) =>
      range.start >= suppression.range.start &&
      range.start < suppression.range.end &&
      (!suppression.ruleIds || suppression.ruleIds.has(ruleId)),
  );
}

export function createDocument(text: string, options: AnalyzeOptions = {}): ExtractedDocument {
  const format = options.format && options.format !== 'auto' ? options.format : inferFormat(options.filePath);
  let spans: TextRange[] = [];
  let reviewOnlySpans: TextRange[] = [];
  let blocks: TextRange[] = [];
  let suppressionSpans: TextRange[] | undefined;
  const parseErrors: Array<{ message: string; offset: number }> = [];

  try {
    if (format === 'plain') {
      spans = [{ start: 0, end: text.length }];
    } else if (format === 'markdown' || format === 'mdx') {
      const extracted = extractMarkdown(
        text,
        format === 'mdx',
        options.ignoreQuotes !== false,
      );
      ({ spans, blocks, suppressionSpans } = extracted);
      parseErrors.push(...extracted.errors);
    } else if (format === 'json') {
      const extracted = extractJson(text);
      ({ spans, blocks } = extracted);
      // JSON values can be display copy, but they can also be machine-facing
      // identifiers or protocol payloads. Diagnostics remain useful; edits are review-only.
      reviewOnlySpans = [...spans];
      suppressionSpans = [];
      parseErrors.push(...extracted.errors);
    } else if (format === 'html') {
      const extracted = extractHtml(text, options.ignoreQuotes !== false);
      ({ spans, blocks, suppressionSpans } = extracted);
      parseErrors.push(...extracted.errors);
    } else if (format === 'tsx') {
      const extracted = extractTsx(text, options.ignoreQuotes !== false);
      ({ spans, blocks } = extracted);
      reviewOnlySpans = extracted.reviewOnlySpans;
      suppressionSpans = extracted.suppressionSpans;
      parseErrors.push(...extracted.errors);
    }
  } catch (error) {
    parseErrors.push({ message: error instanceof Error ? error.message : String(error), offset: 0 });
  }

  const spanProtectedRanges = rangesContainedBySources(protectionRanges(text, options, format), spans, text.length);
  const blockQuoteRanges = options.ignoreQuotes === false
    ? []
    : rangesContainedBySources(quoteProtectionRanges(text), blocks, text.length);
  const protectedRanges = mergeRanges([...spanProtectedRanges, ...blockQuoteRanges], text.length);
  const proseRanges = subtractRanges(spans, protectedRanges, text.length);
  const reviewOnlyRanges = mergeRanges(reviewOnlySpans, text.length);
  let masked = copyRanges(text, spans);
  masked = maskRanges(masked, protectedRanges);
  blocks = mergeRanges(blocks, text.length)
    .map((range) => trimRange(masked, range))
    .filter((range) => range.end > range.start && hasKorean(masked.slice(range.start, range.end)));
  if (!blocks.length || format === 'plain') blocks = plainBlocks(masked);
  if (format !== 'plain') {
    const uncovered: TextRange[] = [];
    let firstPossibleBlock = 0;
    for (const range of proseRanges) {
      while ((blocks[firstPossibleBlock]?.end ?? Number.POSITIVE_INFINITY) <= range.start) firstPossibleBlock += 1;
      const block = blocks[firstPossibleBlock];
      const covered = Boolean(block && range.start >= block.start && range.end <= block.end);
      if (!covered && hasKorean(masked.slice(range.start, range.end))) uncovered.push(range);
    }
    blocks = [...blocks, ...uncovered].sort((left, right) => left.start - right.start || left.end - right.end);
  }

  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') index += 1;
      lineStarts.push(index + 1);
    } else if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    text,
    masked,
    format,
    proseRanges,
    reviewOnlyRanges,
    blocks,
    lineStarts,
    suppressions: collectSuppressions(text, suppressionSpans, protectedRanges),
    parseErrors,
  };
}

function isContainedInSortedRanges(ranges: TextRange[], target: TextRange): boolean {
  let low = 0;
  let high = ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if ((range?.start ?? Number.POSITIVE_INFINITY) <= target.start) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const range = candidate >= 0 ? ranges[candidate] : undefined;
  return Boolean(range && target.start >= range.start && target.end <= range.end);
}

export function isProseRange(document: ExtractedDocument, range: TextRange): boolean {
  return isContainedInSortedRanges(document.proseRanges, range);
}

export function isReviewOnlyRange(document: ExtractedDocument, range: TextRange): boolean {
  return isContainedInSortedRanges(document.reviewOnlyRanges, range);
}

export function isBlockRange(document: ExtractedDocument, range: TextRange): boolean {
  return isContainedInSortedRanges(document.blocks, range);
}

function lineIndexAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = lineStarts[middle] ?? 0;
    if (value <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

export function locationFor(document: ExtractedDocument, range: TextRange): SourceLocation {
  const startLine = lineIndexAt(document.lineStarts, range.start);
  const endLine = lineIndexAt(document.lineStarts, range.end);
  return {
    start: {
      line: startLine + 1,
      column: range.start - (document.lineStarts[startLine] ?? 0) + 1,
      offset: range.start,
    },
    end: {
      line: endLine + 1,
      column: range.end - (document.lineStarts[endLine] ?? 0) + 1,
      offset: range.end,
    },
  };
}

export function excerptFor(document: ExtractedDocument, range: TextRange, radius = 36): string {
  const startLine = lineIndexAt(document.lineStarts, range.start);
  const endLine = lineIndexAt(document.lineStarts, Math.max(range.start, range.end - 1));
  const lineStart = document.lineStarts[startLine] ?? 0;
  const nextLineStart = document.lineStarts[endLine + 1];
  const lineEnd = nextLineStart === undefined ? document.text.length : nextLineStart - 1;
  const start = Math.max(lineStart, range.start - radius);
  const end = Math.min(lineEnd, range.end + radius);
  return `${start > lineStart ? '…' : ''}${document.text.slice(start, end).trim()}${end < lineEnd ? '…' : ''}`;
}
