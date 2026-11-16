// Writes src/stars.json, the stars src/starfield.ts draws around the globe,
// from the Yale Bright Star Catalog (5th ed., every star to about magnitude
// 6.5), as converted to JSON by brettonw/YaleBrightStarCatalog (MIT):
//
//   node scripts/stars.mjs [bsc5-short.json]
//
// Without a file it downloads the conversion. Each star is four numbers: right
// ascension and declination (J2000, degrees), visual magnitude and color
// temperature (hundreds of kelvin).
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json';
const OUTPUT = new URL('../src/stars.json', import.meta.url);

// "00h 05m 09.9s" and "+45° 13′ 45″" as degrees.
function sexagesimal(text, unit) {
  const [whole, minutes, seconds] = text.match(/[\d.]+/g).map(Number);
  const value = (whole + minutes / 60 + seconds / 3600) * unit;
  return text.trim().startsWith('-') ? -value : value;
}

const round = (value, digits) => Number(value.toFixed(digits));

const file = process.argv[2];
const catalog = JSON.parse(file ? await readFile(file, 'utf8') : await (await fetch(SOURCE)).text());
const stars = catalog
  .filter((star) => star.RA && star.Dec && star.V)
  .map((star) => [
    round(sexagesimal(star.RA, 15), 2),
    round(sexagesimal(star.Dec, 1), 2),
    round(Number(star.V), 2),
    Math.round(Number(star.K || 5800) / 100),
  ])
  // Brightest last, so they draw over the faint ones.
  .sort((a, b) => b[2] - a[2]);
await writeFile(OUTPUT, `${JSON.stringify(stars.flat())}\n`);
console.log(`${stars.length} stars`);
