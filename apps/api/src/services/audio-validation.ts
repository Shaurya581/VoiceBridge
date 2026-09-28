import { open } from 'node:fs/promises';

const supportedMimeTypes = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/mpeg', 'audio/aac'
]);

export function canonicalAudioMimeType(mimeType: string) {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function hasAudioSignature(header: Uint8Array, mimeType: string) {
  const mime = canonicalAudioMimeType(mimeType);
  if (!supportedMimeTypes.has(mime) || header.byteLength < 4) return false;
  const ascii = (start: number, end: number) => String.fromCharCode(...header.subarray(start, end));
  const isFrameSync = header[0] === 0xff && (header[1]! & 0xe0) === 0xe0;

  switch (mime) {
    case 'audio/webm': return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
    case 'audio/ogg': return ascii(0, 4) === 'OggS';
    case 'audio/wav': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
    case 'audio/mp4':
    case 'audio/x-m4a': return header.byteLength >= 8 && ascii(4, 8) === 'ftyp';
    case 'audio/mpeg': return ascii(0, 3) === 'ID3' || isFrameSync;
    case 'audio/aac': return isFrameSync;
    default: return false;
  }
}

export async function validateAudioFile(filePath: string, mimeType: string) {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return hasAudioSignature(header.subarray(0, bytesRead), mimeType);
  } finally {
    await file.close();
  }
}
