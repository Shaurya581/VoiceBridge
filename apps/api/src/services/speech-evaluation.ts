export interface SpeechEvaluationSample {
  language: 'hi' | 'hinglish' | 'ta';
  audioQuality: 'clean' | 'noisy';
  reference: string;
  hypothesis: string;
}

export interface ErrorRate {
  errors: number;
  units: number;
  rate: number;
}

function normalize(text: string) {
  return text.normalize('NFC').toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function editDistance<T>(reference: T[], hypothesis: T[]) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (reference[row - 1] === hypothesis[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[hypothesis.length]!;
}

export function wordErrorRate(reference: string, hypothesis: string): ErrorRate {
  const expected = normalize(reference).split(' ').filter(Boolean);
  const actual = normalize(hypothesis).split(' ').filter(Boolean);
  const errors = editDistance(expected, actual);
  return { errors, units: expected.length, rate: expected.length ? errors / expected.length : (actual.length ? 1 : 0) };
}

export function characterErrorRate(reference: string, hypothesis: string): ErrorRate {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const expected = [...segmenter.segment(normalize(reference))].map(({ segment }) => segment).filter((part) => part !== ' ');
  const actual = [...segmenter.segment(normalize(hypothesis))].map(({ segment }) => segment).filter((part) => part !== ' ');
  const errors = editDistance(expected, actual);
  return { errors, units: expected.length, rate: expected.length ? errors / expected.length : (actual.length ? 1 : 0) };
}

export function summarizeSpeechEvaluation(samples: SpeechEvaluationSample[]) {
  const groups = new Map<string, SpeechEvaluationSample[]>();
  for (const sample of samples) {
    const key = `${sample.language}/${sample.audioQuality}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const summarize = (rows: SpeechEvaluationSample[]) => {
    const wordTotals = rows.reduce((total, row) => {
      const result = wordErrorRate(row.reference, row.hypothesis);
      return { errors: total.errors + result.errors, units: total.units + result.units };
    }, { errors: 0, units: 0 });
    const characterTotals = rows.reduce((total, row) => {
      const result = characterErrorRate(row.reference, row.hypothesis);
      return { errors: total.errors + result.errors, units: total.units + result.units };
    }, { errors: 0, units: 0 });
    return {
      samples: rows.length,
      wer: wordTotals.units ? wordTotals.errors / wordTotals.units : null,
      cer: characterTotals.units ? characterTotals.errors / characterTotals.units : null
    };
  };
  return {
    total: summarize(samples),
    groups: Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, summarize(rows)]))
  };
}
