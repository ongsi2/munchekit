import { analyze, applyFixes } from 'munchekit';

const source = '사전에 미리 검토를 진행했습니다!!';
const report = analyze(source, { profile: 'web' });
const fixed = applyFixes(source, report);

console.log(report.diagnostics);
console.log(fixed.text);
