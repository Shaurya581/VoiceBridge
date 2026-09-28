import { readFile } from 'node:fs/promises';
import { summarizeSpeechEvaluation, type SpeechEvaluationSample } from '../services/speech-evaluation.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: pnpm --filter @voicebridge/api eval:stt <samples.jsonl>');
  process.exitCode = 2;
} else {
  const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u).filter((line) => line.trim());
  const samples: SpeechEvaluationSample[] = lines.map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on line ${index + 1}`); }
    if (!value || typeof value !== 'object') throw new Error(`Invalid sample on line ${index + 1}`);
    const sample = value as Record<string, unknown>;
    if (!['hi', 'hinglish', 'ta'].includes(String(sample.language))) throw new Error(`Unsupported language on line ${index + 1}`);
    if (!['clean', 'noisy'].includes(String(sample.audioQuality))) throw new Error(`audioQuality must be clean or noisy on line ${index + 1}`);
    if (typeof sample.reference !== 'string' || typeof sample.hypothesis !== 'string') throw new Error(`reference and hypothesis must be strings on line ${index + 1}`);
    return sample as unknown as SpeechEvaluationSample;
  });
  console.log(JSON.stringify({ note: 'Dataset result only; this is not evidence that proposal targets are met.', ...summarizeSpeechEvaluation(samples) }, null, 2));
}
