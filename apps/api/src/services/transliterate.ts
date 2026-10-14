/**
 * Deterministic Devanagari → Latin transliteration for Hinglish output.
 *
 * This is a lightweight, dependency-free character mapper that converts
 * Hindi Devanagari script to approximate Romanized Hinglish. It does NOT
 * translate — it preserves the original Hindi words in Roman script.
 *
 * Known limitations:
 * - Schwa deletion is approximate (applies a simple trailing-vowel rule).
 * - Conjuncts and rare characters may not produce perfect output.
 * - Browser SpeechRecognition accuracy varies; this only handles the script conversion.
 */

const vowels: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'अं': 'an', 'अः': 'ah'
};

const matras: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  'ं': 'n', 'ः': 'h', 'ँ': 'n'
};

const consonants: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh',
  'फ़': 'f', 'ऱ': 'r'
};

const nuqtaConsonants: Record<string, string> = {
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f'
};

const virama = '्';

/** Common Hindi words → preferred Hinglish romanization for natural output */
const wordOverrides: Record<string, string> = {
  'के': 'ke', 'का': 'ka', 'की': 'ki', 'है': 'hai', 'हैं': 'hain',
  'में': 'mein', 'से': 'se', 'पर': 'par', 'को': 'ko', 'और': 'aur',
  'के पास': 'ke paas', 'कृपया': 'kripya', 'भी': 'bhi',
  'नहीं': 'nahi', 'बहुत': 'bahut', 'तेज': 'tez', 'अजीब': 'ajeeb',
  'आवाज': 'awaaz', 'आवाज़': 'awaaz', 'शोर': 'shor',
  'मशीन': 'machine', 'पैकेजिंग': 'packaging', 'लाइन': 'line',
  'सर्वर': 'server', 'रूम': 'room', 'कंप्यूटर': 'computer',
  'नेटवर्क': 'network', 'प्रिंटर': 'printer', 'मोटर': 'motor',
  'कन्वेयर': 'conveyor', 'पानी': 'paani', 'रिसाव': 'risaav',
  'दरवाज़ा': 'darwaza', 'लाइट': 'light', 'एसी': 'AC',
  'जांचें': 'jaanchein', 'जाँचें': 'jaanchein',
  'कैफेटेरिया': 'cafeteria', 'गोदाम': 'godaam',
  'वेयरहाउस': 'warehouse', 'बॉयलर': 'boiler',
  'लोडिंग': 'loading', 'बे': 'bay', 'असेंबली': 'assembly',
  'प्रोडक्शन': 'production', 'उपकरण': 'upkaran',
  'बताएं': 'bataein', 'ठीक': 'theek', 'करें': 'karein',
  'रही': 'rahi', 'रहा': 'raha', 'रहे': 'rahe',
  'हो': 'ho', 'कर': 'kar', 'चेक': 'check', 'देखें': 'dekhein',
  'प्लीज': 'please', 'मेंटेनेंस': 'maintenance'
};

function transliterateWord(word: string): string {
  // If the word is already Latin script, return as-is
  if (/^[\x00-\x7F]+$/u.test(word)) return word;

  // Check word overrides first
  const override = wordOverrides[word];
  if (override) return override;

  let result = '';
  const chars = [...word]; // Handle multi-byte characters correctly
  let i = 0;

  while (i < chars.length) {
    const char = chars[i]!;
    const next = chars[i + 1];

    // Check for two-char nuqta consonants (e.g., क़)
    if (next && nuqtaConsonants[char + next]) {
      const consonant = nuqtaConsonants[char + next]!;
      i += 2;
      if (chars[i] === virama) {
        result += consonant;
        i += 1; // skip virama, no inherent vowel
      } else if (chars[i] && matras[chars[i]!]) {
        result += consonant + matras[chars[i]!];
        i += 1;
      } else {
        result += consonant + 'a';
      }
      continue;
    }

    // Vowel (standalone)
    if (vowels[char]) {
      result += vowels[char];
      i += 1;
      continue;
    }

    // Consonant
    if (consonants[char]) {
      const base = consonants[char]!;
      i += 1;
      if (chars[i] === virama) {
        result += base; // halant — no inherent vowel
        i += 1;
      } else if (chars[i] && matras[chars[i]!]) {
        result += base + matras[chars[i]!];
        i += 1;
      } else {
        // Inherent 'a' — add it unless at end of word (schwa deletion)
        const atEnd = i >= chars.length || (i === chars.length - 1 && (matras[chars[i]!] || chars[i] === virama));
        result += atEnd ? base : base + 'a';
      }
      continue;
    }

    // Matra without preceding consonant (shouldn't happen in valid text, but be safe)
    if (matras[char]) {
      result += matras[char];
      i += 1;
      continue;
    }

    // Virama alone
    if (char === virama) {
      i += 1;
      continue;
    }

    // Numbers — keep as-is
    if (/\d/.test(char)) {
      result += char;
      i += 1;
      continue;
    }

    // Devanagari digits
    const devanagariDigit = '०१२३४५६७८९'.indexOf(char);
    if (devanagariDigit >= 0) {
      result += String(devanagariDigit);
      i += 1;
      continue;
    }

    // Anything else (punctuation, etc.) — pass through
    result += char;
    i += 1;
  }

  return result;
}

/** Returns true if the text contains Devanagari characters */
export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/u.test(text);
}

/**
 * Transliterate a Hindi/Devanagari transcript into Romanized Hinglish.
 *
 * - Already-Latin words (English technical terms) are preserved.
 * - Common Hindi words use preferred Hinglish spellings from a lookup table.
 * - Remaining Devanagari is transliterated character-by-character.
 * - Multi-word overrides (e.g. "के पास" → "ke paas") are applied first.
 */
export function transliterateHinglish(text: string): string {
  if (!hasDevanagari(text)) return text;

  // Apply multi-word overrides first
  let processed = text;
  for (const [hindi, roman] of Object.entries(wordOverrides)) {
    if (hindi.includes(' ') && processed.includes(hindi)) {
      processed = processed.replaceAll(hindi, roman);
    }
  }

  // Split by whitespace, transliterate each word
  return processed.split(/(\s+)/u).map((segment) => {
    if (/^\s+$/u.test(segment)) return segment; // preserve whitespace
    return transliterateWord(segment);
  }).join('');
}
