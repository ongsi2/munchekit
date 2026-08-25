import safeRegex from 'safe-regex2';

function hasBackreference(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\\') continue;
    const next = source[index + 1] ?? '';
    if (/[1-9]/u.test(next) || (next === 'k' && source[index + 2] === '<')) return true;
    index += 1;
  }
  return false;
}

function startsRepeatingQuantifier(source: string, index: number): boolean {
  const character = source[index];
  if (character === '+' || character === '*') return true;
  if (character !== '{') return false;
  const match = source.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/u);
  if (!match) return false;
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined
    ? minimum
    : (match[2] === '' ? Number.POSITIVE_INFINITY : Number(match[2]));
  return maximum > 1;
}

function hasAlternationInsideRepeatedGroup(source: string): boolean {
  const groups: Array<{ alternation: boolean }> = [];
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(') {
      groups.push({ alternation: false });
      continue;
    }
    if (character === '|' && groups.length) {
      const current = groups.at(-1);
      if (current) current.alternation = true;
      continue;
    }
    if (character !== ')' || !groups.length) continue;
    const completed = groups.pop();
    if (!completed) continue;
    if (completed.alternation && startsRepeatingQuantifier(source, index + 1)) return true;
    if (completed.alternation) {
      const parent = groups.at(-1);
      if (parent) parent.alternation = true;
    }
  }
  return false;
}

export function compileUserPattern(source: string): RegExp {
  if (source.length === 0 || source.length > 200) {
    throw new Error('pattern length must be between 1 and 200 characters.');
  }
  let expression: RegExp;
  try {
    expression = new RegExp(source, 'gu');
  } catch (error) {
    throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  // One repetition node is intentionally strict. Multiple independent-looking
  // quantifiers can still interact (`a+a+$`) and become superlinear on failure.
  if (!safeRegex(expression, { limit: 1 }) || hasBackreference(source) || hasAlternationInsideRepeatedGroup(source)) {
    throw new Error('potentially unsafe repetition, alternation, or backreference in preservePatterns.');
  }
  return expression;
}
