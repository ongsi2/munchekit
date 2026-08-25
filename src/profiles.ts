import type { ProfileName, StyleProfile } from './types.js';

export const profiles: Record<ProfileName, StyleProfile> = {
  natural: {
    id: 'natural',
    label: '자연스러운 한국어',
    description: '말투는 유지하면서 번역투, 군더더기, 반복을 보수적으로 찾습니다.',
    register: 'preserve',
    maxSentenceLength: 100,
    maxParagraphSentences: 5,
    connectiveThreshold: 3,
    ruleLevels: {},
  },
  web: {
    id: 'web',
    label: '웹·앱 카피',
    description: '짧고 직접적인 존댓말 제품 문구를 기준으로 검사합니다.',
    register: 'polite',
    maxSentenceLength: 70,
    maxParagraphSentences: 4,
    connectiveThreshold: 2,
    ruleLevels: {
      'KO-ATTACH-001': 'warning',
      'KO-LEN-001': 'warning',
      'KO-VAGUE-001': 'warning',
      'KO-VAGUE-002': 'warning',
    },
  },
  'tech-blog': {
    id: 'tech-blog',
    label: '기술 블로그',
    description: '구체적인 사실과 평서체를 선호하는 기술 글 프리셋입니다.',
    register: 'plain',
    maxSentenceLength: 105,
    maxParagraphSentences: 5,
    connectiveThreshold: 3,
    ruleLevels: {
      'KO-BOILER-001': 'warning',
      'KO-META-001': 'warning',
      'KO-VAGUE-002': 'warning',
    },
  },
  business: {
    id: 'business',
    label: '업무 문서',
    description: '격식을 유지하되 장황한 명사화와 중복을 줄입니다.',
    register: 'polite',
    maxSentenceLength: 120,
    maxParagraphSentences: 6,
    connectiveThreshold: 4,
    ruleLevels: {
      'KO-META-001': 'off',
      'KO-POLITE-001': 'off',
    },
  },
  'thmm-tech': {
    id: 'thmm-tech',
    label: 'thmm 기술 글',
    description: '사실, 숫자, 실패 과정을 앞세우는 개인 기술 문체 프리셋입니다.',
    register: 'plain',
    maxSentenceLength: 95,
    maxParagraphSentences: 4,
    connectiveThreshold: 2,
    ruleLevels: {
      'KO-VAGUE-001': 'warning',
      'KO-VAGUE-002': 'warning',
      'KO-PUNCT-002': 'warning',
      'KO-BOILER-001': 'warning',
      'KO-META-001': 'warning',
    },
  },
};

export function resolveProfile(profile: ProfileName | StyleProfile | undefined): StyleProfile {
  if (!profile) return profiles.natural;
  return typeof profile === 'string' ? profiles[profile] : profile;
}
