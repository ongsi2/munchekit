import { describe, expect, it } from 'vitest';

import { createDocument, inferFormat } from '../src/document.js';

describe('document extraction', () => {
  it('infers supported source formats', () => {
    expect(inferFormat('post.md')).toBe('markdown');
    expect(inferFormat('Component.tsx')).toBe('tsx');
    expect(inferFormat('worker.ts')).toBe('tsx');
    expect(inferFormat('script.mjs')).toBe('tsx');
    expect(inferFormat('messages/ko.json')).toBe('json');
    expect(inferFormat('unknown.bin')).toBe('plain');
  });

  it('keeps Markdown prose and protects code, URLs, and direct quotes', () => {
    const source = [
      '# 매우 강력한 기능',
      '',
      '문서를 검토를 진행했다.',
      '',
      '`검토를 진행했다`는 코드다.',
      '',
      '```ts',
      'const message = "매우 강력한 기능";',
      '```',
      '',
      '“매우 강력한 기능입니다.”라고 말했다.',
      'https://example.com/매우-강력한-기능',
    ].join('\n');
    const document = createDocument(source, { format: 'markdown' });

    expect(document.masked).toContain('매우 강력한 기능');
    expect(document.masked).toContain('문서를 검토를 진행했다.');
    expect(document.masked).not.toContain('const message');
    expect(document.masked).not.toContain('매우 강력한 기능입니다.');
    expect(document.masked).not.toContain('example.com');
  });

  it('extracts JSON values but not property names', () => {
    const source = '{"매우 강력한 키":"매우 강력한 값","code":"const 매우 = 1"}';
    const document = createDocument(source, { format: 'json' });

    expect(document.masked).not.toContain('매우 강력한 키');
    expect(document.masked).toContain('매우 강력한 값');
    expect(document.masked).toContain('const 매우 = 1');
  });

  it('extracts visible HTML text and selected accessibility attributes', () => {
    const source = '<main><h1>매우 강력한 검색</h1><input placeholder="문서를 찾을 수 있습니다"><script>const x="매우"</script></main>';
    const document = createDocument(source, { format: 'html' });

    expect(document.masked).toContain('매우 강력한 검색');
    expect(document.masked).toContain('문서를 찾을 수 있습니다');
    expect(document.masked).not.toContain('const x');
  });

  it('protects HTML code, preformatted text, refresh targets, and quotations', () => {
    const source = [
      '<code>미리 사전에</code>',
      '<pre>매우 강력한</pre>',
      '<meta http-equiv="refresh" content="0; URL=/미리 사전에">',
      '<blockquote>“매우 강력한 경험”</blockquote>',
      '<p>실제 본문은 매우 빠르다.</p>',
    ].join('\n');
    const document = createDocument(source, { format: 'html' });

    expect(document.masked).not.toContain('미리 사전에');
    expect(document.masked).not.toContain('강력한 경험');
    expect(document.masked).toContain('실제 본문은 매우 빠르다.');
    expect(createDocument(source, { format: 'html', ignoreQuotes: false }).masked).toContain('매우 강력한 경험');
  });

  it('extracts TSX text and Korean string values without imports', () => {
    const source = [
      "import thing from '매우-강력한-패키지';",
      'const title = "매우 강력한 검색";',
      'export const View = () => <button aria-label="문서를 찾을 수 있습니다">검토를 진행했다</button>;',
    ].join('\n');
    const document = createDocument(source, { format: 'tsx' });

    expect(document.masked).not.toContain('매우-강력한-패키지');
    expect(document.masked).toContain('매우 강력한 검색');
    expect(document.masked).toContain('문서를 찾을 수 있습니다');
    expect(document.masked).toContain('검토를 진행했다');
  });

  it('limits TSX attributes and protects module paths, computed keys, and nested code', () => {
    const source = [
      'const route = import("./미리 사전에.js");',
      'const item = registry["미리 사전에"];',
      'const view = <main><a href="/미리 사전에" title="매우 강력한 안내">본문</a>',
      '<code><span>{"미리 사전에"}</span></code></main>;',
    ].join('\n');
    const document = createDocument(source, { format: 'tsx' });

    expect(document.masked).not.toContain('./미리 사전에.js');
    expect(document.masked).not.toContain('/미리 사전에');
    expect(document.masked).not.toContain('{"미리 사전에"}');
    expect(document.masked).toContain('매우 강력한 안내');
    expect(document.masked).toContain('본문');
  });

  it('extracts visible MDX attributes without treating quote delimiters as direct speech', () => {
    const source = '<Card id="내부키" title="매우 강력한 안내" />';
    const document = createDocument(source, { format: 'mdx' });

    expect(document.masked).not.toContain('내부키');
    expect(document.masked).toContain('매우 강력한 안내');
  });

  it('keeps UTF-16 offsets stable after astral Unicode characters', () => {
    const source = '🙂 앞부분 <strong>매우 강력한 기능</strong>';
    const document = createDocument(source, { format: 'html' });

    expect(document.masked.length).toBe(source.length);
    expect(document.masked.indexOf('매우')).toBe(source.indexOf('매우'));
  });

  it('keeps offsets stable after many astral characters outside a prose span', () => {
    const source = `<script>${'😀'.repeat(20)}</script><p>미리 사전에 확인했다.</p>`;
    const document = createDocument(source, { format: 'html' });

    expect(document.masked.length).toBe(source.length);
    expect(document.masked.indexOf('미리')).toBe(source.indexOf('미리'));
  });
});
