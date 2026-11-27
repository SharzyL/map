// Writes src/worker/api/han-fold.json, the character map the station search
// folds names and queries through (src/worker/api/station-search.ts), so 涩谷,
// 澀谷 and 渋谷 find the same station. It is made from OpenCC's tables
// (https://github.com/BYVoid/OpenCC, Apache-2.0), at a pinned release:
//
//   node scripts/han-fold.mjs [dir of OpenCC's data/dictionary]
//
// Without a directory it downloads the tables. Every character goes to its
// simplified Chinese form: a Japanese shinjitai form (渋, 駅, 図) to its
// traditional one first (JPVariants), a Taiwanese or Hong Kong variant (裡) to
// the standard one (TWVariants, HKVariants), then traditional to simplified
// (TSCharacters); where a table gives several, the first is taken. A character
// that is itself simplified Chinese keeps that meaning (沪 is Shanghai, not
// the shinjitai of 濾), and shinjitai standing for several characters (弁)
// stay. The variants of place names the tables lack (濵, 﨑, 髙) are listed
// below. Only characters that change are written, as one string of pairs:
// each character followed by its folded form.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RELEASE = 'ver.1.1.9';
const SOURCE = `https://raw.githubusercontent.com/BYVoid/OpenCC/${RELEASE}/data/dictionary/`;
const OUTPUT = new URL('../src/worker/api/han-fold.json', import.meta.url);
// Itaiji of Japanese names, to their usual form
const EXTRA = { 濵: '濱', 邉: '邊', 嶋: '島', 嶌: '島', 﨑: '崎', 嵜: '崎', 髙: '高', 舘: '館', 槇: '槙', 冨: '富' };

const dir = process.argv[2];
async function table(name) {
  const text = dir
    ? await readFile(path.join(dir, name), 'utf8')
    : await (async () => {
        const response = await fetch(SOURCE + name);
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        return response.text();
      })();
  // "from<TAB>to [to ...]", characters only (the phrase tables are not read)
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([from, to]) => from && to && [...from].length === 1)
    .map(([from, to]) => [from, to.split(' ').filter((c) => [...c].length === 1)]);
}

const toSimplified = new Map();
for (const [from, to] of await table('TSCharacters.txt')) if (to[0] !== from) toSimplified.set(from, to[0]);
const simplified = new Set(toSimplified.values());
const toStandard = new Map(Object.entries(EXTRA));
// Japanese and regional forms, inverted: the tables map the standard
// (traditional) form to them
for (const name of ['JPVariants.txt', 'TWVariants.txt', 'HKVariants.txt']) {
  for (const [standard, variants] of await table(name)) {
    for (const variant of variants) {
      if (variant !== standard && !simplified.has(variant) && !toStandard.has(variant))
        toStandard.set(variant, standard);
    }
  }
}

// Shinjitai standing for several unrelated characters
for (const c of ['弁', '缶', '芸', '予', '余', '欠', '糸']) toStandard.delete(c);

const step = (c) => {
  const standard = toStandard.get(c) ?? c;
  return toSimplified.get(standard) ?? standard;
};
// To a character that stays (薴 to 苧 to 苎)
const fold = (c) => {
  for (let next = step(c); next !== c; next = step(c)) c = next;
  return c;
};
const pairs = [...new Set([...toSimplified.keys(), ...toStandard.keys()])]
  .filter((c) => fold(c) !== c)
  .sort()
  .map((c) => c + fold(c));
await writeFile(OUTPUT, `${JSON.stringify(pairs.join(''))}\n`);
console.log(`${pairs.length} characters folded`);
