import { describe, expect, it } from 'vitest';
import { canonicalAudioMimeType, hasAudioSignature } from './audio-validation.js';

describe('audio upload validation', () => {
  it('normalizes browser MIME codec parameters', () => {
    expect(canonicalAudioMimeType('Audio/WebM;codecs=opus')).toBe('audio/webm');
  });

  it('recognizes the supported audio container signatures', () => {
    expect(hasAudioSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm')).toBe(true);
    expect(hasAudioSignature(Buffer.from('OggS\u0000'), 'audio/ogg')).toBe(true);
    expect(hasAudioSignature(Buffer.from('RIFF0000WAVE'), 'audio/wav')).toBe(true);
    expect(hasAudioSignature(Buffer.from('0000ftypM4A '), 'audio/mp4')).toBe(true);
    expect(hasAudioSignature(Buffer.from('ID3\u0004\u0000\u0000'), 'audio/mpeg')).toBe(true);
    expect(hasAudioSignature(Buffer.from([0xff, 0xf1, 0x50, 0x80]), 'audio/aac')).toBe(true);
  });

  it('rejects a mismatched MIME label and unsupported content', () => {
    expect(hasAudioSignature(Buffer.from('<html>not audio'), 'audio/webm')).toBe(false);
    expect(hasAudioSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'application/octet-stream')).toBe(false);
  });
});
