import { describe, expect, it } from 'vitest';
import { transliterateHinglish, hasDevanagari } from './transliterate.js';

describe('Devanagari → Hinglish transliteration', () => {
  it('returns Latin-script text unchanged', () => {
    const text = 'Machine 4 se strange noise aa rahi hai packaging line ke paas';
    expect(transliterateHinglish(text)).toBe(text);
  });

  it('transliterates a pure Hindi sentence to Romanized Hinglish', () => {
    const result = transliterateHinglish('पैकेजिंग लाइन के पास मशीन से अजीब आवाज आ रही है');
    expect(result).toBe('packaging line ke paas machine se ajeeb awaaz aa rahi hai');
  });

  it('normalizes a Hindi machine number to English form', () => {
    const result = transliterateHinglish('मशीन 4 से बहुत तेज आवाज आ रही है');
    expect(result).toContain('machine 4');
    expect(result).toContain('bahut');
    expect(result).toContain('tez');
    expect(result).toContain('awaaz');
  });

  it('preserves existing English words in mixed text', () => {
    const result = transliterateHinglish('Machine 4 packaging line के पास तेज आवाज');
    expect(result).toContain('Machine 4');
    expect(result).toContain('packaging line');
    expect(result).toContain('ke paas');
    expect(result).toContain('tez');
  });

  it('transliterates IT-related Hindi keywords', () => {
    const result = transliterateHinglish('सर्वर रूम में नेटवर्क डाउन है');
    expect(result).toContain('server');
    expect(result).toContain('room');
    expect(result).toContain('network');
  });

  it('transliterates Facilities-related Hindi keywords', () => {
    const result = transliterateHinglish('कैफेटेरिया के पास पानी का रिसाव');
    expect(result).toContain('cafeteria');
    expect(result).toContain('ke paas');
    expect(result).toContain('paani');
    expect(result).toContain('risaav');
  });

  it('does not translate — preserves Hinglish character', () => {
    const result = transliterateHinglish('मशीन से अजीब आवाज आ रही है');
    // Should NOT produce English translation like "strange noise from machine"
    expect(result).toContain('ajeeb');
    expect(result).toContain('awaaz');
    expect(result).not.toContain('strange');
    expect(result).not.toContain('noise');
  });
});

describe('hasDevanagari', () => {
  it('detects Devanagari characters', () => {
    expect(hasDevanagari('मशीन 4')).toBe(true);
    expect(hasDevanagari('machine 4')).toBe(false);
    expect(hasDevanagari('packaging line के पास')).toBe(true);
  });
});
