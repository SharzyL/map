// The keys station search matches (station-search.ts), shared by the Worker,
// which folds queries with them, and the build, which folds the index's names
// with them (data_builder/stations/search-keys.mjs), so both fold alike.
//
// Plain TypeScript without imports, which Node runs as it is: the Han table
// comes in as an argument (hanFolder).

// ── Folding ─────────────────────────────────────────────

const toKatakana = (text: string) => text.replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// Latin letters without their marks (ō o, ü u); kana keep theirs (ガ)
const withoutMarks = (text: string) =>
  text.replace(/[\u00c0-\u024f\u1e00-\u1eff]/g, (c) => c.normalize('NFD').replace(/\p{M}/gu, ''));

// A name or query as compared: full-width forms, case and Latin letters' marks
// folded, hiragana as katakana, ヶ as ケ, every Han character in its
// simplified form, 々 as the character it repeats, without spaces,
// punctuation, or a trailing 駅/站. `pairs` is han-fold.json's table: each
// character followed by its simplified form.
export function hanFolder(pairs: string): (text: string) => string {
  const han = new Map<string, string>();
  const chars = [...pairs];
  for (let i = 0; i + 1 < chars.length; i += 2) han.set(chars[i], chars[i + 1]);
  return (text) => {
    const folded: string[] = [];
    for (const c of toKatakana(withoutMarks(text.normalize('NFKC').toLowerCase()))) {
      if (/[\s\p{P}\p{S}]/u.test(c)) continue;
      if (c === '々' || c === '〻') {
        if (folded.length) folded.push(folded[folded.length - 1]);
        continue;
      }
      const kana = c === 'ヶ' ? 'ケ' : c === 'ヵ' ? 'カ' : c;
      folded.push(han.get(kana) ?? kana);
    }
    return folded.join('').replace(/(?<=.)(驿|站)$/, '');
  };
}

// ── Romaji ──────────────────────────────────────────────

const KANA: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  ヴ: 'vu', ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ヮ: 'wa',
}; // prettier-ignore
const SMALL_Y: Record<string, string> = { ャ: 'a', ュ: 'u', ョ: 'o' };
const SMALL_VOWEL = new Set(['ァ', 'ィ', 'ゥ', 'ェ', 'ォ']);

// A reading in katakana as Hepburn romaji (シンジュク → shinjuku); what is not
// kana is dropped.
export function romaji(yomi: string): string {
  let out = '';
  let double = false;
  const add = (syllable: string) => {
    out += double && /^[bcdfghjkmprstvwz]/.test(syllable) ? (syllable.startsWith('ch') ? 't' : syllable[0]) : '';
    out += syllable;
    double = false;
  };
  for (const c of toKatakana(yomi)) {
    if (c === 'ッ') {
      double = true;
    } else if (c in SMALL_Y && out.endsWith('i')) {
      // キャ kya, シャ sha, ジャ ja
      const base = out.slice(0, -1);
      out = /(sh|ch|j)$/.test(base) ? base + SMALL_Y[c] : `${base}y${SMALL_Y[c]}`;
    } else if (SMALL_VOWEL.has(c) && /[aiueo]$/.test(out)) {
      // ファ fa, ティ ti, シェ she, ウィ wi
      const base = out.slice(0, -1);
      out = (base === '' || /[aiueon]$/.test(base) ? `${base}w` : base) + KANA[c];
    } else if (c in KANA) {
      add(KANA[c]);
    }
  }
  return out;
}

// Romaji as compared, the same however it was written: without marks or
// anything but letters, kunrei as Hepburn (si shi, tu tsu, zyo jo), m before
// b/p/m as n (shimbashi), and long vowels as short ones (toukyou, tōkyō,
// oosaka: tokyo, osaka).
export function romajiKey(text: string): string {
  let s = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  s = s
    .replace(/sy(?=[auo])/g, 'sh')
    .replace(/ty(?=[auo])/g, 'ch')
    .replace(/[zj]y(?=[auo])/g, 'j')
    .replace(/si/g, 'shi')
    .replace(/ti/g, 'chi')
    .replace(/tu/g, 'tsu')
    .replace(/(?<![sc])hu/g, 'fu')
    .replace(/[zd]i/g, 'ji')
    .replace(/du/g, 'zu')
    .replace(/cch/g, 'tch')
    .replace(/m(?=[bpm])/g, 'n')
    .replace(/nn/g, 'n');
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/ou|oo/g, 'o').replace(/uu/g, 'u').replace(/aa/g, 'a').replace(/ii/g, 'i').replace(/ee/g, 'e');
  }
  return s;
}

// The keys a station is found by, which the build adds to the index
// (data_builder/stations/search-keys.mjs) so the Worker computes none: `f`
// its folded name and reading, `a` its romaji (Japan, as romajiKey compares
// them: from its reading and OSM's Latin names) or its pinyin and initials
// (China).
export interface KeyedStation {
  c: 'cn' | 'jp';
  n: string;
  y?: string | null;
  l: string[];
}

export function stationKeys(station: KeyedStation, foldName: (text: string) => string): { f: string[]; a: string[] } {
  const names = new Set([foldName(station.n)]);
  const latin = new Set<string>();
  if (station.c === 'jp') {
    if (station.y) {
      names.add(foldName(station.y));
      latin.add(romajiKey(romaji(station.y)));
    }
    for (const l of station.l) latin.add(romajiKey(l.replace(/\s+station$/i, '')));
  } else {
    for (const l of station.l) latin.add(l.toLowerCase().replace(/[^a-z]/g, ''));
  }
  return { f: [...names].filter(Boolean), a: [...latin].filter(Boolean) };
}
