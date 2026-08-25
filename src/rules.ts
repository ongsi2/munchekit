import type { FindingDraft, Rule, RuleContext, Sentence } from './rule-types.js';
import type { Fixability, RuleLevel, RuleMeta, Suggestion, TextRange } from './types.js';

const DOCS_BASE = 'https://github.com/ongsi2/munchekit/blob/main/docs/rules.md#';

function meta(
  id: string,
  name: string,
  category: string,
  description: string,
  defaultLevel: RuleLevel,
  fixability: Fixability,
  stability: RuleMeta['stability'] = 'experimental',
): RuleMeta {
  return {
    id,
    name,
    category,
    description,
    defaultLevel,
    fixability,
    stability,
    docsUrl: `${DOCS_BASE}${id.toLowerCase()}`,
  };
}

export const parseRuleMeta: RuleMeta = meta(
  'KO-PARSE-001',
  '소스 구문 오류',
  'parser',
  '구조화된 소스를 안전하게 분리할 수 없는 구문 오류를 보고합니다.',
  'error',
  'none',
  'stable',
);

function regexMatches(text: string, expression: RegExp): RegExpMatchArray[] {
  const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`;
  return [...text.matchAll(new RegExp(expression.source, flags))];
}

function regexMatchesInProse(context: RuleContext, expression: RegExp): RegExpMatchArray[] {
  const matches: RegExpMatchArray[] = [];
  const seen = new Set<string>();
  let firstPossibleBlock = 0;
  for (const prose of context.document.proseRanges) {
    while ((context.document.blocks[firstPossibleBlock]?.end ?? Number.POSITIVE_INFINITY) <= prose.start) {
      firstPossibleBlock += 1;
    }
    for (let index = firstPossibleBlock; index < context.document.blocks.length; index += 1) {
      const block = context.document.blocks[index];
      if (!block || block.start >= prose.end) break;
      const start = Math.max(prose.start, block.start);
      const end = Math.min(prose.end, block.end);
      if (end <= start) continue;
      for (const match of regexMatches(context.document.masked.slice(start, end), expression)) {
        if (match.index === undefined) continue;
        match.index += start;
        const key = `${String(match.index)}:${String(match[0].length)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(match);
      }
    }
  }
  return matches.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

interface RegexFindingOptions {
  message: string | ((match: RegExpMatchArray) => string);
  rationale: string;
  confidence: number;
  suggestions?: Suggestion[] | ((match: RegExpMatchArray) => Suggestion[]);
  replacement?: string | ((match: RegExpMatchArray) => string);
  skip?: (match: RegExpMatchArray, context: RuleContext) => boolean;
}

function regexRule(ruleMeta: RuleMeta, expression: RegExp, options: RegexFindingOptions): Rule {
  return {
    meta: ruleMeta,
    check(context) {
      const findings: FindingDraft[] = [];
      for (const match of regexMatchesInProse(context, expression)) {
        if (match.index === undefined || options.skip?.(match, context)) continue;
        const replacement =
          typeof options.replacement === 'function' ? options.replacement(match) : options.replacement;
        const suggestions =
          typeof options.suggestions === 'function' ? options.suggestions(match) : options.suggestions;
        findings.push({
          range: { start: match.index, end: match.index + match[0].length },
          message: typeof options.message === 'function' ? options.message(match) : options.message,
          rationale: options.rationale,
          confidence: options.confidence,
          ...(suggestions ? { suggestions } : {}),
          ...(replacement !== undefined ? { replacement } : {}),
        });
      }
      return findings;
    },
  };
}

function review(message: string): Suggestion[] {
  return [{ message, risk: 'medium' }];
}

const physicalThroughNouns = new Set([
  '문', '창문', '터널', '통로', '입구', '관문', '길', '창구', '구멍', '다리', '계단', '복도', '골목', '현관', '게이트',
]);
const standardBasedTerms = ['클라우드', '증거', '규칙', '역할', '이벤트', '웹', '데이터베이스'];

const calqueAbout = regexRule(
  meta(
    'KO-CALQUE-001',
    '‘~에 대해서’ 직역투',
    'translationese',
    '목적어를 직접 쓰면 더 짧고 자연스러운 문장이 될 수 있습니다.',
    'info',
    'review',
  ),
  /[가-힣A-Za-z0-9]+에\s+(?:대해서|대하여|대한)(?=$|[\s.,!?…:;)\]}>])/gu,
  {
    message: '‘~에 대해서/대한’ 없이 목적어와 서술어를 직접 연결해 보세요.',
    rationale: '영어 about 구문을 그대로 옮긴 표현은 문장의 초점을 흐릴 수 있습니다.',
    confidence: 0.78,
    suggestions: review('조사를 맞춘 뒤 ‘무엇을 설명한다/검토한다’처럼 직접 쓰세요.'),
  },
);

const calqueThrough = regexRule(
  meta(
    'KO-CALQUE-002',
    '추상적인 ‘~을 통해서’',
    'translationese',
    '수단이 분명하지 않은 ‘~을 통해서’를 직접적인 동사로 바꾸도록 제안합니다.',
    'info',
    'review',
  ),
  /([가-힣A-Za-z0-9]+)(?:을|를)\s+통(?:해서|하여)(?=$|[\s.,!?…:;)\]}>])/gu,
  {
    message: '수단을 나타내는 말이 아니라면 ‘~으로’ 또는 직접적인 동사를 검토하세요.',
    rationale: '추상 명사 뒤의 ‘통해서’는 번역투와 불필요한 우회 표현이 되기 쉽습니다.',
    confidence: 0.76,
    suggestions: (match) => {
      const noun = match[1] ?? '';
      const replacement = `${noun}${instrumentParticle(noun)}`;
      return [{ replacement, message: `이 범위를 “${replacement}”로 줄일 수 있습니다.`, risk: 'medium' }];
    },
    skip: (match) => physicalThroughNouns.has(match[1] ?? ''),
  },
);

const calqueBased = regexRule(
  meta(
    'KO-CALQUE-003',
    '반복되는 ‘기반’ 구문',
    'translationese',
    '‘기반으로/기반한’이 문장의 실제 관계를 가리는지 확인합니다.',
    'info',
    'review',
  ),
  /[가-힣A-Za-z0-9]+(?:에|을|를)?\s*기반(?:으로|하여|한|을\s+둔)(?=$|[\s.,!?…:;)\]}>])/gu,
  {
    message: '‘기반’ 대신 실제 관계(사용, 분석, 참고, 구축)를 밝혀 보세요.',
    rationale: '범용적인 “based on” 대응어는 구체적인 행동을 숨길 수 있습니다.',
    confidence: 0.67,
    suggestions: review('문맥에 따라 ‘사용해’, ‘분석해’, ‘참고해’, ‘위에 구축한’으로 구체화하세요.'),
    skip: (match) => standardBasedTerms.some((term) => match[0].startsWith(term)),
  },
);

const nominalizations: Array<[RegExp, string]> = [
  [/검토를\s+진행(?=하|했|해|합|할|한|하는)/gu, '검토'],
  [/분석을\s+(?:진행|수행)(?=하|했|해|합|할|한|하는)/gu, '분석'],
  [/확인을\s+진행(?=하|했|해|합|할|한|하는)/gu, '확인'],
  [/조사를\s+(?:진행|실시)(?=하|했|해|합|할|한|하는)/gu, '조사'],
  [/논의를\s+진행(?=하|했|해|합|할|한|하는)/gu, '논의'],
  [/협의를\s+진행(?=하|했|해|합|할|한|하는)/gu, '협의'],
  [/구현을\s+진행(?=하|했|해|합|할|한|하는)/gu, '구현'],
  [/테스트를\s+(?:진행|수행)(?=하|했|해|합|할|한|하는)/gu, '테스트'],
  [/개선을\s+진행(?=하|했|해|합|할|한|하는)/gu, '개선'],
];

const nominalizationRule: Rule = {
  meta: meta(
    'KO-NOM-001',
    '불필요한 명사화',
    'conciseness',
    '용언성 명사와 범용 동사의 결합을 더 직접적으로 쓸 수 있는지 확인합니다.',
    'warning',
    'review',
    'stable',
  ),
  check(context) {
    const findings: FindingDraft[] = [];
    for (const [expression, replacement] of nominalizations) {
      for (const match of regexMatchesInProse(context, expression)) {
        if (match.index === undefined) continue;
        findings.push({
          range: { start: match.index, end: match.index + match[0].length },
          message: `‘${match[0]}…’는 ‘${replacement}…’로 줄일 수 있습니다.`,
          rationale: '명사와 범용 동사의 결합이 같은 의미를 길게 표현합니다.',
          confidence: 0.9,
          suggestions: review(`수식어와 조사를 확인한 뒤 ‘${replacement}하다’처럼 직접 쓸지 검토하세요.`),
        });
      }
    }
    return findings;
  },
};

const redundantPairs: Array<[RegExp, string]> = [
  [/미리\s+사전에(?![가-힣])/gu, '사전에'],
  [/사전에\s+미리(?![가-힣])/gu, '미리'],
  [/다시\s+재검토(?=하|했|해|합|할|한|하는|$|[^가-힣])/gu, '재검토'],
  [/계속\s+지속(?=하|했|해|합|할|한|하는|되|됐|돼|된|될|$|[^가-힣])/gu, '지속'],
  [/서로\s+상호(?![가-힣])/gu, '서로'],
  [/가장\s+최적(?=이|인|$|[^가-힣])/gu, '최적'],
  [/직접\s+몸소(?![가-힣])/gu, '직접'],
];

const redundantPairRule: Rule = {
  meta: meta(
    'KO-RED-001',
    '겹말',
    'redundancy',
    '뜻이 겹치는 두 표현을 하나로 줄입니다.',
    'warning',
    'review',
    'stable',
  ),
  check(context) {
    const findings: FindingDraft[] = [];
    for (const [expression, replacement] of redundantPairs) {
      for (const match of regexMatchesInProse(context, expression)) {
        if (match.index === undefined) continue;
        findings.push({
          range: { start: match.index, end: match.index + match[0].length },
          message: `뜻이 겹치는 ‘${match[0]}’를 ‘${replacement}’로 줄일 수 있습니다.`,
          rationale: '같은 뜻을 되풀이하는 겹말입니다.',
          confidence: 0.9,
          suggestions: review(`두 표현의 실제 의미를 확인한 뒤 ‘${replacement}’만 남길지 검토하세요.`),
        });
      }
    }
    return findings;
  },
};

const approximateDoubleRule = regexRule(
  meta(
    'KO-RED-002',
    '겹친 어림 표현',
    'redundancy',
    '‘약’과 ‘정도/가량/내외’를 함께 쓴 표현을 하나로 줄입니다.',
    'warning',
    'review',
    'stable',
  ),
  /약\s+([0-9][0-9,.]*\s*(?:개|명|건|회|분|초|시간|일|주|개월|년|%|퍼센트)?)\s*(정도|가량|내외)/gu,
  {
    message: '어림을 나타내는 표현이 겹칩니다.',
    rationale: '‘약’과 ‘정도/가량/내외’ 중 하나만으로 범위를 나타낼 수 있습니다.',
    confidence: 0.9,
    suggestions: review('‘약’이 의약품을 뜻하지 않는지 확인한 뒤 어림 표현 하나만 남기세요.'),
  },
);

const doublePassiveReplacements: Record<string, string> = {
  되어지: '되',
  되어진: '된',
  되어질: '될',
  되어졌: '됐',
  되어져: '돼',
};

const doublePassiveRule = regexRule(
  meta(
    'KO-VOICE-001',
    '이중 피동 ‘되어지다’',
    'voice',
    '‘되어지다’를 ‘되다’로 줄입니다.',
    'warning',
    'safe',
    'stable',
  ),
  /되어지|되어진|되어질|되어졌|되어져/gu,
  {
    message: '‘되어지다’는 ‘되다’로 줄일 수 있습니다.',
    rationale: '‘되다’ 자체가 피동 의미를 가져 ‘-어지다’를 겹쳐 쓸 필요가 없습니다.',
    confidence: 0.99,
    replacement: (match) => doublePassiveReplacements[match[0]] ?? '되',
    suggestions: (match) => {
      const replacement = doublePassiveReplacements[match[0]] ?? '되';
      return [{ replacement, message: `‘${replacement}…’ 형태로 줄입니다.`, risk: 'low' }];
    },
  },
);

const possibilityRule = regexRule(
  meta(
    'KO-POSS-001',
    '기능 나열형 ‘~할 수 있다’',
    'directness',
    '가능 표현이 실제 행동을 우회하는지 확인합니다.',
    'info',
    'review',
  ),
  /([가-힣]{1,20})\s+수\s+(?:있습니다|있어요|있다)/gu,
  {
    message: '가능 여부보다 사용자가 실제로 하는 행동을 직접 써 보세요.',
    rationale: '기능 소개에서 반복되는 “~할 수 있다”는 문장을 길고 수동적으로 만듭니다.',
    confidence: 0.74,
    suggestions: review('예: “문서를 찾을 수 있습니다” → “문서를 찾습니다”'),
    skip: (match, context) => {
      const word = match[1];
      const last = word?.at(-1);
      if (!last) return true;
      const code = last.charCodeAt(0) - 0xac00;
      if (code < 0 || code > 11171 || code % 28 !== 8) return true;
      const before = context.document.masked.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
      return /(?:아|어|여|해)야(?:만)?\s[^.!?…\n]{0,30}$/u.test(before);
    },
  },
);

const vagueIntensifierRule = regexRule(
  meta(
    'KO-VAGUE-001',
    '근거 없는 강조 부사',
    'specificity',
    '강조 부사를 수치나 구체적인 사실로 바꿀지 묻습니다.',
    'info',
    'review',
  ),
  /(?<![가-힣A-Za-z0-9])(?:매우|정말|굉장히|상당히|아주|대폭|획기적으로|압도적으로)(?=$|[^가-힣A-Za-z0-9])/gu,
  {
    message: '강조의 근거를 숫자나 구체적인 사실로 보여줄 수 있는지 확인하세요.',
    rationale: '근거 없는 정도 부사는 정보보다 인상을 전달합니다.',
    confidence: 0.83,
    suggestions: review('근거가 없다면 삭제하고, 있다면 비교 기준이나 수치를 쓰세요.'),
  },
);

const vagueAdjectiveRule = regexRule(
  meta(
    'KO-VAGUE-002',
    '추상적인 홍보 표현',
    'specificity',
    '구체적인 근거 없이 쓰인 평가 형용사를 찾습니다.',
    'info',
    'review',
  ),
  /(?:혁신적인|강력한|최적의|탁월한|효율적인|원활한|유의미한|의미\s+있는|다양한)(?=$|[^가-힣A-Za-z0-9])/gu,
  {
    message: '무엇이 어떻게 달라졌는지 구체적인 사실로 바꿔 보세요.',
    rationale: '평가 형용사만으로는 독자가 효과나 차이를 확인하기 어렵습니다.',
    confidence: 0.76,
    suggestions: review('수치·사례·구체적인 기능을 쓰거나, 근거가 없으면 표현을 덜어내세요.'),
  },
);

const boilerplateRule = regexRule(
  meta(
    'KO-BOILER-001',
    '상투적인 서두',
    'boilerplate',
    '내용 없이 독자의 시간을 쓰는 도입 문구를 찾습니다.',
    'info',
    'review',
  ),
  /(?:오늘날|현대\s+사회에서|빠르게\s+변화하는\s+시대에|이번\s+글에서는|본\s+글에서는|지금부터)(?=$|[^가-힣A-Za-z0-9])[^.!?\n]{0,80}(?:살펴보겠습니다|알아보겠습니다|중요성이\s+커지고\s+있습니다|중요합니다)/gu,
  {
    message: '상투적인 예고 대신 독자가 바로 알아야 할 상황이나 문제로 시작해 보세요.',
    rationale: '일반적인 시대 배경과 글의 예고는 새 정보를 거의 주지 않습니다.',
    confidence: 0.91,
    suggestions: review('문단을 지우거나 구체적인 문제·사건·수치로 시작하세요.'),
  },
);

const aiPairRule = regexRule(
  meta(
    'KO-PAIR-001',
    '‘단순한 A를 넘어 B’ 대구',
    'boilerplate',
    '생성형 글에서 반복되는 과장된 대구를 찾습니다.',
    'info',
    'review',
  ),
  /단순(?:히|한)\s+[^.!?\n]{1,55}?\s*(?:을|를)?\s*넘어(?:서)?/gu,
  {
    message: '두 주장을 각각 직접 말하면 더 분명해질 수 있습니다.',
    rationale: '‘단순한 A를 넘어 B’ 구조는 실제 차이보다 전환을 과장하기 쉽습니다.',
    confidence: 0.88,
    suggestions: review('A를 지우고 B만 쓰거나, 두 문장으로 나눠 구체적인 관계를 밝히세요.'),
  },
);

const aiCliches = regexRule(
  meta(
    'KO-AI-001',
    '생성형 상투 표현',
    'boilerplate',
    '내용보다 분위기를 만드는 생성형 글의 상투 표현을 찾습니다.',
    'info',
    'review',
  ),
  /(?:새로운\s+가능성을\s+열(?:어|고)|한\s+단계\s+더\s+나아가|핵심적인\s+역할을\s+하|중요한\s+역할을\s+하|긍정적인\s+영향을\s+미치|도움이\s+될\s+것입니다)/gu,
  {
    message: '상투적인 평가 대신 실제 변화나 행동을 적어 보세요.',
    rationale: '여러 주제에 그대로 붙일 수 있는 표현은 글의 고유한 정보를 약하게 만듭니다.',
    confidence: 0.89,
    suggestions: review('누가 무엇을 어떻게 하는지 구체적인 문장으로 바꾸세요.'),
  },
);

interface CreationForm {
  lemma: string;
  purpose: string;
  negativeEnding: string;
}

const creationForms = new Map<string, CreationForm>([
  ['만듭니다', { lemma: '만들다', purpose: '만들기', negativeEnding: '않습니다' }],
  ['만들어요', { lemma: '만들다', purpose: '만들기', negativeEnding: '않아요' }],
  ['만든다', { lemma: '만들다', purpose: '만들기', negativeEnding: '않는다' }],
]);

const creationResults = new Map<string, ReadonlySet<string>>([
  ['만들다', new Set(['치아', '치열', '교합'])],
]);

const creationResultHeads = [...new Set([...creationResults.values()].flatMap((values) => [...values]))]
  .sort((left, right) => right.length - left.length)
  .join('|');
const creationFiniteForms = [...creationForms.keys()]
  .sort((left, right) => right.length - left.length)
  .join('|');
const attachmentExpression = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${creationResultHeads})(은|는)\\s+서두르지\\s+않(고|으며)\\s+(${creationFiniteForms})(?=$|[.!?…])`,
  'gu',
);

function objectParticle(noun: string): '을' | '를' {
  const last = noun.at(-1);
  if (!last) return '를';
  const code = last.charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? '을' : '를';
}

function instrumentParticle(noun: string): '으로' | '로' {
  const last = noun.at(-1);
  if (!last) return '으로';
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '으로';
  const finalIndex = code % 28;
  return finalIndex === 0 || finalIndex === 8 ? '로' : '으로';
}

const attachmentPurposeRule: Rule = {
  meta: meta(
    'KO-ATTACH-001',
    '결과물 주제화로 흐린 목적 관계',
    'clarity',
    '결과물을 주제로 먼저 세워 목적과 행위의 관계가 늦게 드러나는 문장을 찾습니다.',
    'info',
    'review',
  ),
  check(context) {
    const findings: FindingDraft[] = [];
    for (const match of regexMatchesInProse(context, attachmentExpression)) {
      if (match.index === undefined) continue;
      const head = match[1];
      const connector = match[3];
      const finite = match[4];
      if (!head || !connector || !finite) continue;
      const form = creationForms.get(finite);
      if (!form || !creationResults.get(form.lemma)?.has(head)) continue;
      const object = `${head}${objectParticle(head)}`;
      const range = { start: match.index, end: match.index + match[0].length };
      const purposeReplacement = `${object} ${form.purpose} 위해 서두르지 ${form.negativeEnding}`;
      const mannerReplacement = `${object} 서두르지 않${connector} ${finite}`;
      findings.push({
        range,
        message: '결과물을 ‘은/는’으로 세운 뒤 만드는 방식을 이어 써, 목적과 행위의 관계가 늦게 드러납니다.',
        rationale: '문법 오류는 아니지만, 서두르지 않는 일이 목적을 위한 선택인지 단순한 방식인지 문장 끝에서야 알 수 있습니다.',
        confidence: 0.82,
        suggestions: [
          {
            replacement: purposeReplacement,
            message: `목적 관계라면 이 범위를 “${purposeReplacement}”로 바꿔 관계를 밝히세요.`,
            risk: 'medium',
          },
          {
            replacement: mannerReplacement,
            message: `단순한 방식 관계라면 이 범위를 “${mannerReplacement}”로 바꿔 목적어 조사만 밝히세요.`,
            risk: 'medium',
          },
        ],
      });
    }
    return findings;
  },
};

function sentenceLengthRule(): Rule {
  return {
    meta: meta(
      'KO-LEN-001',
      '긴 문장',
      'readability',
      '프리셋 기준보다 길고 절이 많은 문장을 찾습니다.',
      'info',
      'none',
    ),
    check(context) {
      return context.sentences.flatMap((sentence) => {
        const compactLength = sentence.text.replace(/\s/gu, '').length;
        const clauses = (sentence.text.match(/,|(?:지만|는데|으며|면서|므로|해서|하고)\s/gu) ?? []).length;
        if (compactLength <= context.profile.maxSentenceLength || clauses < 2) return [];
        return [
          {
            range: { start: sentence.start, end: sentence.end },
            message: `공백을 뺀 길이가 ${String(compactLength)}자이고 절이 ${String(clauses + 1)}개인 문장입니다.`,
            rationale: '한 문장에 여러 사건이나 판단이 겹치면 독자가 관계를 다시 읽게 됩니다.',
            confidence: 0.86,
            suggestions: review('접속 지점에서 두 문장으로 나누되 인과·대조 관계는 유지하세요.'),
            allowStructuralSpan: true,
          },
        ];
      });
    },
  };
}

function paragraphDensityRule(): Rule {
  return {
    meta: meta(
      'KO-PARA-001',
      '빽빽한 문단',
      'readability',
      '한 문단에 너무 많은 문장이 모였는지 확인합니다.',
      'info',
      'none',
    ),
    check(context) {
      const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });
      const findings: FindingDraft[] = [];
      for (const block of context.document.blocks) {
        const content = context.document.masked.slice(block.start, block.end);
        const count = [...segmenter.segment(content)].filter((segment) => /[가-힣]/u.test(segment.segment)).length;
        if (count <= context.profile.maxParagraphSentences) continue;
        findings.push({
          range: block,
          message: `한 문단에 문장이 ${String(count)}개 있습니다.`,
          rationale: '한 문단에 여러 생각이 섞였을 수 있습니다.',
          confidence: 0.72,
          suggestions: review('주제가 바뀌는 지점이 있는지 보고 문단을 나누세요.'),
          allowStructuralSpan: true,
        });
      }
      return findings;
    },
  };
}

function endingSuffix(text: string): string | undefined {
  const cleaned = text.trim().replace(/[.!?…]+$/u, '').trim();
  if (/(?:습니다|니다)$/u.test(cleaned)) return '~ㅂ니다/습니다';
  if (/요$/u.test(cleaned)) return '~요';
  const endings = [
    '할 수 있습니다',
    '되어 있습니다',
    '하고 있습니다',
    '있습니다',
    '없습니다',
    '했습니다',
    '됩니다',
    '합니다',
    '입니다',
    '있어요',
    '없어요',
    '했어요',
    '해요',
    '예요',
    '이에요',
    '했다',
    '한다',
    '된다',
    '이다',
    '있다',
    '없다',
  ];
  return endings.find((ending) => cleaned.endsWith(ending));
}

export function classifyRegister(text: string): Sentence['register'] {
  const cleaned = text.trim().replace(/[.!?…]+$/u, '').trim();
  const beforeSida = cleaned.endsWith('시다') ? cleaned[cleaned.length - 3] : undefined;
  const beforeSidaCode = beforeSida ? beforeSida.charCodeAt(0) - 0xac00 : -1;
  const bieupHortative = beforeSidaCode >= 0 && beforeSidaCode <= 11171 && beforeSidaCode % 28 === 17;
  if (/(?:습니다|니다|십시오)$/u.test(cleaned) || bieupHortative) return 'polite';
  if (/요$/u.test(cleaned)) return 'casual';
  if (/(?:다|한다|했다|된다|됐다|이다|아니다|였다|있다|없다|겠다)$/u.test(cleaned)) return 'plain';
  return 'unknown';
}

export function segmentSentences(context: Pick<RuleContext, 'document'>): Sentence[] {
  const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });
  const sentences: Sentence[] = [];
  for (const block of context.document.blocks) {
    const content = context.document.masked.slice(block.start, block.end);
    for (const item of segmenter.segment(content)) {
      if (!/[가-힣]/u.test(item.segment)) continue;
      const leading = item.segment.length - item.segment.trimStart().length;
      const trailing = item.segment.length - item.segment.trimEnd().length;
      const start = block.start + item.index + leading;
      const end = block.start + item.index + item.segment.length - trailing;
      const text = context.document.masked.slice(start, end);
      const ending = endingSuffix(text);
      sentences.push({
        start,
        end,
        text,
        register: classifyRegister(text),
        ...(ending ? { ending } : {}),
      });
    }
  }
  return sentences;
}

function repeatedEndingRule(): Rule {
  return {
    meta: meta(
      'KO-END-001',
      '같은 종결 반복',
      'rhythm',
      '같은 문장 종결이 네 번 이상 이어지는 구간을 찾습니다.',
      'info',
      'none',
    ),
    check(context) {
      const findings: FindingDraft[] = [];
      let runStart = 0;
      for (let index = 1; index <= context.sentences.length; index += 1) {
        const current = context.sentences[index];
        const first = context.sentences[runStart];
        if (current?.ending && first?.ending === current.ending) continue;
        const runLength = index - runStart;
        if (first?.ending && runLength >= 4) {
          const last = context.sentences[index - 1];
          if (last) {
            findings.push({
              range: { start: first.start, end: last.end },
              message: `‘${first.ending}’ 종결이 ${String(runLength)}문장 연속됩니다.`,
              rationale: '같은 길이와 종결이 이어지면 정보가 나열처럼 들릴 수 있습니다.',
              confidence: 0.9,
              suggestions: review('일부 문장을 합치거나 주어·서술 구조를 바꿔 리듬을 조절하세요.'),
              allowStructuralSpan: true,
            });
          }
        }
        runStart = index;
      }
      return findings;
    },
  };
}

function registerRule(): Rule {
  return {
    meta: meta(
      'KO-REGISTER-001',
      '격식체 혼용',
      'register',
      '평서체, 격식 존댓말, 해요체가 의도 없이 섞였는지 확인합니다.',
      'warning',
      'review',
    ),
    check(context) {
      const known = context.sentences.filter((sentence) => sentence.register !== 'unknown');
      if (known.length < 3) return [];
      const counts = new Map<Sentence['register'], number>();
      for (const sentence of known) counts.set(sentence.register, (counts.get(sentence.register) ?? 0) + 1);
      const expected = context.profile.register;
      if (expected !== 'preserve') {
        const mismatches = known.filter((sentence) => sentence.register !== expected);
        if (!mismatches.length) return [];
        const first = mismatches[0];
        if (!first) return [];
        return [
          {
            range: { start: first.start, end: first.end },
            message: `${context.profile.label} 프리셋은 ‘${expected}’ 말투를 기대하지만 다른 종결이 ${String(mismatches.length)}개 있습니다.`,
            rationale: '같은 문서에서 격식 수준이 바뀌면 화자와 독자의 관계가 흔들립니다.',
            confidence: 0.88,
            suggestions: review('직접 인용·UI 라벨이 아니라면 프리셋의 말투로 통일하세요.'),
            allowStructuralSpan: true,
          },
        ];
      }
      const populated = [...counts.entries()].filter(([, count]) => count >= 2);
      if (populated.length < 2) return [];
      const minority = populated.sort((left, right) => left[1] - right[1])[0]?.[0];
      const first = known.find((sentence) => sentence.register === minority);
      if (!first) return [];
      return [
        {
          range: { start: first.start, end: first.end },
          message: '평서체·격식 존댓말·해요체가 한 문서에 반복해서 섞여 있습니다.',
          rationale: '의도하지 않은 말투 혼용은 문서의 목소리를 불안정하게 만듭니다.',
          confidence: 0.84,
          suggestions: review('인용문을 제외하고 주된 말투 하나를 정해 통일하세요.'),
          allowStructuralSpan: true,
        },
      ];
    },
  };
}

const connectives = ['또한', '따라서', '하지만', '그러나', '한편', '즉', '특히', '결론적으로'];

function connectiveRule(): Rule {
  return {
    meta: meta(
      'KO-CONNECT-001',
      '문두 접속어 남용',
      'flow',
      '문장마다 기계적으로 붙은 접속어를 찾습니다.',
      'info',
      'review',
    ),
    check(context) {
      const hits = context.sentences.flatMap((sentence) => {
        const found = connectives.find((word) => sentence.text.trimStart().startsWith(word));
        return found ? [{ sentence, word: found }] : [];
      });
      if (hits.length <= context.profile.connectiveThreshold) return [];
      const first = hits[context.profile.connectiveThreshold];
      if (!first) return [];
      return [
        {
          range: { start: first.sentence.start, end: first.sentence.start + first.word.length },
          message: `문두 접속어가 ${String(hits.length)}번 쓰였습니다.`,
          rationale: '관계가 문장 자체로 드러나면 접속어를 매번 붙일 필요가 없습니다.',
          confidence: 0.78,
          suggestions: review('없어도 관계가 분명한 접속어부터 덜어내세요.'),
        },
      ];
    },
  };
}

function repeatedSubjectRule(): Rule {
  return {
    meta: meta(
      'KO-PRON-001',
      '연속된 주어 반복',
      'flow',
      '같은 주어로 시작하는 문장이 이어지는지 확인합니다.',
      'info',
      'review',
    ),
    check(context) {
      const findings: FindingDraft[] = [];
      const subjectPattern = /^(우리는|저희는|사용자는|고객은|본\s+서비스는|이\s+기능은)(?=$|[^가-힣A-Za-z0-9])/u;
      for (let index = 1; index < context.sentences.length; index += 1) {
        const previous = context.sentences[index - 1];
        const current = context.sentences[index];
        if (!previous || !current) continue;
        const previousSubject = previous.text.trimStart().match(subjectPattern)?.[1];
        const currentMatch = current.text.trimStart().match(subjectPattern);
        if (!previousSubject || currentMatch?.[1] !== previousSubject) continue;
        const leading = current.text.length - current.text.trimStart().length;
        findings.push({
          range: { start: current.start + leading, end: current.start + leading + previousSubject.length },
          message: `앞 문장과 같은 주어 ‘${previousSubject}’가 반복됩니다.`,
          rationale: '한국어에서는 문맥상 분명한 주어를 생략하면 흐름이 자연스러워지는 경우가 많습니다.',
          confidence: 0.77,
          suggestions: review('주어를 생략해도 뜻이 분명한지 확인하세요.'),
        });
      }
      return findings;
    },
  };
}

const overPoliteRule = regexRule(
  meta(
    'KO-POLITE-001',
    '과도한 겸양 표현',
    'register',
    '정보 전달을 늦추는 겹친 겸양 표현을 찾습니다.',
    'info',
    'review',
  ),
  /(?:말씀드리고자\s+합니다|안내해\s+드리도록\s+하겠습니다|알려드릴\s+수\s+있도록\s+하겠습니다|양해\s+부탁드리겠습니다)/gu,
  {
    message: '핵심 행동을 한 단계 짧게 표현할 수 있습니다.',
    rationale: '겸양·의지·가능 표현이 겹치면 문장이 필요 이상으로 멀어집니다.',
    confidence: 0.94,
    suggestions: review('예: “안내해 드리도록 하겠습니다” → “안내하겠습니다”'),
  },
);

const genericMetaEndingRule = regexRule(
  meta(
    'KO-META-001',
    '상투적인 맺음말',
    'boilerplate',
    '본문 정보와 무관한 생성형 맺음말을 찾습니다.',
    'info',
    'review',
  ),
  /(?:도움이\s+되었기를\s+바랍니다|유익한\s+시간이\s+되었기를\s+바랍니다|앞으로도\s+많은\s+관심과\s+사랑\s+부탁드립니다)/gu,
  {
    message: '독자에게 필요한 다음 행동이나 마지막 사실로 끝내는 편이 더 구체적입니다.',
    rationale: '어떤 글에도 붙일 수 있는 맺음말은 정보 밀도를 낮춥니다.',
    confidence: 0.96,
    suggestions: review('삭제하거나 실제 다음 단계·제약·링크로 바꾸세요.'),
  },
);

const multipleExclamationRule = regexRule(
  meta(
    'KO-PUNCT-001',
    '겹친 느낌표',
    'punctuation',
    '한국어 문장 끝의 연속 느낌표를 하나로 줄입니다.',
    'warning',
    'safe',
    'stable',
  ),
  /!{2,}/gu,
  {
    message: '느낌표가 연속으로 쓰였습니다.',
    rationale: '문장부호를 겹쳐도 정보의 강도는 더 정확해지지 않습니다.',
    confidence: 1,
    replacement: '!',
    suggestions: [{ replacement: '!', message: '느낌표 하나만 남깁니다.', risk: 'low' }],
    skip: (match, context) => {
      const start = match.index ?? 0;
      const before = context.document.text[start - 1] ?? '';
      const after = context.document.text[start + match[0].length] ?? '';
      // `!!` is also a shell history token, C/JS boolean idiom, and double
      // factorial notation. Only a Hangul-final prose surface is safe.
      return !/[가-힣]/u.test(before) || /[\p{L}\p{N}_]/u.test(after);
    },
  },
);

function exclamationDensityRule(): Rule {
  return {
    meta: meta(
      'KO-PUNCT-002',
      '느낌표 남용',
      'punctuation',
      '문서 전체에서 느낌표가 반복되는지 확인합니다.',
      'info',
      'review',
    ),
    check(context) {
      const matches = regexMatchesInProse(context, /!/gu);
      if (matches.length <= 2) return [];
      const third = matches[2];
      if (third?.index === undefined) return [];
      return [
        {
          range: { start: third.index, end: third.index + 1 },
          message: `문서에 느낌표가 ${String(matches.length)}개 있습니다.`,
          rationale: '강조가 반복되면 중요한 지점의 힘도 약해집니다.',
          confidence: 0.8,
          suggestions: review('행동을 유도하는 핵심 문장 외의 느낌표를 마침표로 바꿔 보세요.'),
        },
      ];
    },
  };
}

const redundantPluralRule = regexRule(
  meta(
    'KO-PLURAL-001',
    '수량어 뒤 복수 표지',
    'conciseness',
    '복수 의미가 이미 드러난 명사 뒤의 ‘들’을 확인합니다.',
    'info',
    'review',
  ),
  /(?:여러|많은|모든|각종)\s+[가-힣]{1,12}들(?:은|는|이|가|을|를|과|와|도|에게|에서)?/gu,
  {
    message: '수량어가 복수를 이미 나타내므로 ‘들’을 덜어낼 수 있습니다.',
    rationale: '복수 정보가 겹치면 번역투처럼 느껴질 수 있습니다.',
    confidence: 0.82,
    suggestions: review('조사가 함께 있다면 자연스럽게 다시 붙여 ‘들’만 덜어내세요.'),
  },
);

const compactSuNouns = new Set(['철수', '몰수', '발수', '골수', '필수', '실수', '말수', '절수', '살수']);
const safeAttributiveSyllables = new Set(['을', '할', '될']);

function spacingRule(): Rule {
  return {
    meta: meta(
      'KO-SPACE-001',
      '‘수 있다/없다’ 띄어쓰기',
      'mechanics',
      '관형형 뒤의 의존 명사 ‘수’를 띄어 씁니다.',
      'warning',
      'safe',
      'stable',
    ),
    check(context) {
      const findings: FindingDraft[] = [];
      for (const match of regexMatchesInProse(context, /([가-힣])수(있|없)/gu)) {
        if (match.index === undefined) continue;
        const preceding = match[1];
        if (!preceding) continue;
        const code = preceding.charCodeAt(0) - 0xac00;
        if (code < 0 || code > 11171 || code % 28 !== 8) continue;
        if (compactSuNouns.has(`${preceding}수`)) continue;
        const start = match.index + preceding.length;
        const replacement = ` 수 ${match[2] ?? ''}`;
        const safe = safeAttributiveSyllables.has(preceding);
        findings.push({
          range: { start, end: match.index + match[0].length },
          message: `‘${match[0].slice(preceding.length)}…’에서 의존 명사 ‘수’를 띄어 씁니다.`,
          rationale: '가능성을 나타내는 의존 명사 ‘수’는 앞말과 띄어 씁니다.',
          confidence: safe ? 0.995 : 0.72,
          ...(safe ? { replacement } : { fixability: 'review' as const }),
          suggestions: safe
            ? [{ replacement: replacement.trimStart(), message: '‘수 있/수 없’으로 띄어 씁니다.', risk: 'low' }]
            : review('앞말이 용언의 관형형인지 확인한 뒤 ‘수 있/수 없’으로 띄어 쓰세요.'),
        });
      }
      return findings;
    },
  };
}

export const rules: Rule[] = [
  calqueAbout,
  calqueThrough,
  calqueBased,
  attachmentPurposeRule,
  nominalizationRule,
  redundantPairRule,
  approximateDoubleRule,
  doublePassiveRule,
  possibilityRule,
  vagueIntensifierRule,
  vagueAdjectiveRule,
  boilerplateRule,
  aiPairRule,
  aiCliches,
  sentenceLengthRule(),
  paragraphDensityRule(),
  repeatedEndingRule(),
  registerRule(),
  connectiveRule(),
  repeatedSubjectRule(),
  overPoliteRule,
  genericMetaEndingRule,
  multipleExclamationRule,
  exclamationDensityRule(),
  redundantPluralRule,
  spacingRule(),
];

export const ruleCatalog: RuleMeta[] = [...rules.map((rule) => rule.meta), parseRuleMeta];

export function rangeOverlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}
