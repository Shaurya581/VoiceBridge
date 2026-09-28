import { afterEach, describe, expect, it, vi } from 'vitest';
import { canTransitionIncident, classifySafety } from './safety.js';

afterEach(() => vi.unstubAllEnvs());

describe('safety classification and incident state transitions', () => {
  it('classifies configured danger language as critical before ordinary routing', () => {
    expect(classifySafety('There is a gas leak near the loading area.')).toMatchObject({ emergency: true, priority: 'CRITICAL' });
  });

  it('accepts configured emergency terms', () => {
    vi.stubEnv('EMERGENCY_TERMS', 'fire|toxic release');
    expect(classifySafety('Possible toxic release in the storage room.').emergency).toBe(true);
    expect(classifySafety('Machine is making noise.').emergency).toBe(false);
  });

  it('recognizes Hindi and Tamil emergency language without English-only word boundaries', () => {
    expect(classifySafety('मशीन के पास आग लगी है').emergency).toBe(true);
    expect(classifySafety('இங்கே வாயு கசிவு உள்ளது').emergency).toBe(true);
  });

  it('does not allow closure before reporter confirmation', () => {
    expect(canTransitionIncident('REPORTER_VERIFICATION_PENDING', 'CLOSED')).toBe(false);
    expect(canTransitionIncident('REPORTER_VERIFICATION_PENDING', 'REPORTER_CONFIRMED')).toBe(true);
    expect(canTransitionIncident('REPORTER_REJECTED', 'REOPENED')).toBe(true);
  });
});
