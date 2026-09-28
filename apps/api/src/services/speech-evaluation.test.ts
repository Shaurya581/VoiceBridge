import { describe, expect, it } from 'vitest';
import { characterErrorRate, summarizeSpeechEvaluation, wordErrorRate } from './speech-evaluation.js';

describe('speech evaluation metrics', () => {
  it('calculates normalized word error rate using corpus edit counts', () => {
    expect(wordErrorRate('Machine 4 is noisy!', 'machine four is noisy')).toEqual({ errors: 1, units: 4, rate: 0.25 });
  });

  it('calculates grapheme error rate for Indic scripts', () => {
    expect(characterErrorRate('கதவு திறக்கவில்லை', 'கதவு திறந்தது').units).toBeGreaterThan(0);
    expect(characterErrorRate('வணக்கம்', 'வணக்கம்').rate).toBe(0);
  });

  it('reports separate Hindi/Hinglish/Tamil and clean/noisy groups without claiming target attainment', () => {
    const result = summarizeSpeechEvaluation([
      { language: 'hi', audioQuality: 'clean', reference: 'मशीन चालू है', hypothesis: 'मशीन चालू है' },
      { language: 'hinglish', audioQuality: 'noisy', reference: 'machine band karo', hypothesis: 'machine chalu karo' },
      { language: 'ta', audioQuality: 'clean', reference: 'இயந்திரம் நிறுத்து', hypothesis: 'இயந்திரம் நிறுத்து' }
    ]);
    expect(result.total.samples).toBe(3);
    expect(Object.keys(result.groups)).toEqual(['hi/clean', 'hinglish/noisy', 'ta/clean']);
    expect(result.groups['hi/clean']?.wer).toBe(0);
    expect(result.groups['hinglish/noisy']?.wer).toBeGreaterThan(0);
  });
});
