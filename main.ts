// Forecast of Roblox's Up-and-Coming top 10 for the 72 hours after the history ends.
// Reads $MAKEFUN_INPUT_DIR (else /input): history.ndjson and task.json.
// Writes $MAKEFUN_OUTPUT_DIR (else /output): forecast.json.
// Deterministic: no clock, no randomness that is not seeded.
import fs from 'node:fs';
import path from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR || '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const PLACES_DEFAULT = 10;
const MAX_ROWS = 100;

type Row = { rank: number; id: number; playing: number | null };
type Read = { at: number; rows: Row[] };

function readHistory(file: string): Read[] {
  const reads: Read[] = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return reads;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let doc: any;
    try {
      doc = JSON.parse(s);
    } catch {
      continue;
    }
    if (!doc || doc.ok === false || !Array.isArray(doc.up_and_coming)) continue;
    const at = Date.parse(doc.at);
    if (!Number.isFinite(at)) continue;
    const rows: Row[] = [];
    const seen = new Set<number>();
    for (const g of doc.up_and_coming) {
      const id = Number(g && g.universe_id);
      if (!Number.isSafeInteger(id) || seen.has(id)) continue;
      seen.add(id);
      rows.push({ rank: rows.length + 1, id, playing: typeof g.playing === 'number' ? g.playing : null });
    }
    if (rows.length > 0) reads.push({ at, rows });
  }
  reads.sort((a, b) => a.at - b.at);
  return reads;
}

function readTask(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Weight of the game now at rank r for place k: a wide two-sided kernel, since this chart moves a
// median of 6 of its top 10 places between reads a few hours apart.
// Lower places churn more than #1, so the near part widens with the place; games above the place
// (falling into it) count a little more than games below it (climbing into it).
function kernel(k: number, r: number): number {
  const d = r - k;
  const width = 1.8 + 0.25 * k;
  const near = Math.exp(-Math.abs(d) / (d < 0 ? width * 1.15 : width));
  const far = 0.6 / (4 + r);
  return near + far;
}

function forecast(reads: Read[], places: number): { probabilities: any[]; top10: number[] } {
  const probabilities: any[] = [];
  const last = reads.length > 0 ? reads[reads.length - 1] : { at: 0, rows: [] as Row[] };
  const named = last.rows.slice(0, MAX_ROWS);
  for (let k = 1; k <= places; k++) {
    const unnamedMass = 0.12 + 0.01 * k;
    const w = named.map((g) => kernel(k, g.rank));
    const total = w.reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;
    let sum = 0;
    for (let i = 0; i < named.length; i++) {
      const p = Math.floor(((1 - unnamedMass) * w[i]) / total * 1e7) / 1e7;
      if (p <= 0) continue;
      sum += p;
      if (sum > 0.999999) break;
      probabilities.push({ universe_id: named[i].id, place: k, p });
    }
  }
  const top10 = last.rows.slice(0, 10).map((g) => g.id);
  let filler = 1;
  while (top10.length < 10) {
    if (!top10.includes(filler)) top10.push(filler);
    filler += 1;
  }
  return { probabilities, top10 };
}

function main(): void {
  const task = readTask(path.join(INPUT_DIR, 'task.json'));
  const places = Number.isInteger(task.places) && task.places > 0 ? task.places : PLACES_DEFAULT;
  const reads = readHistory(path.join(INPUT_DIR, 'history.ndjson'));
  const out = forecast(reads, places);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'forecast.json'), JSON.stringify(out));
}

main();
