// Forecast of Roblox's Up-and-Coming top 10 for the 72 hourly reads after the history ends.
// Reads $MAKEFUN_INPUT_DIR (else /input): history.ndjson and task.json.
// Writes $MAKEFUN_OUTPUT_DIR (else /output): forecast.json.
// Deterministic: no clock, no randomness.
//
// Model: for each place k, the share of the window's hours that place k is held by a game that is
// now at rank r (or by a game not on the chart now), fitted from the history itself on pairs of
// reads whose lag matches the window's lags, with a wide kernel as the prior. Each game on the
// last chart is then named at every place with its share, adjusted for its recent climb or fall
// and for the day it turns 28 days old and leaves the chart.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_ROWS = 100;
const RANK_CAP = 100;

export type Row = { id: number; rank: number; playing: number | null; up: number | null; down: number | null };
export type Read = { at: number; rows: Row[]; created: Map<number, number> | null };
export type Task = { from: number; until: number; slots: number; slotMs: number; places: number };

export const DEFAULTS = {
  // prior kernel
  kWidth0: 1.8,
  kWidthK: 0.25,
  kAbove: 1.15,
  kFar: 1.2,
  u0: 0.12,
  u0K: 0.01,
  // fitted table
  alpha: 100, // prior strength, in pairs of reads
  bucketH: 6, // lag bucket width
  halfLifeH: 120, // recency of the later read of a pair, relative to the cut
  // momentum: rising games act as if ranked higher
  beta: 0.6,
  lookH: 12,
  // smallest row worth writing
  pMin: 1e-6,
};
export type Params = typeof DEFAULTS;

// Rank bins of the transition table: ranks 1..15 alone, then wider.
const BIN_EDGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 26, 31, 41, 51, 71, 101];
const NB = BIN_EDGES.length - 1;
function binOf(rank: number): number {
  for (let b = 0; b < NB; b++) if (rank < BIN_EDGES[b + 1]) return b;
  return NB - 1;
}

function num(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseHistory(text: string): Read[] {
  const reads: Read[] = [];
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
    const list = doc.up_and_coming.filter((g: any) => g && Number.isSafeInteger(Number(g.universe_id)));
    // keep the served order; rank fields only break ties of a missing order
    const rows: Row[] = [];
    const seen = new Set<number>();
    for (const g of list) {
      const id = Number(g.universe_id);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, rank: rows.length + 1, playing: num(g.playing), up: num(g.up_votes), down: num(g.down_votes) });
    }
    if (rows.length === 0) continue;
    let created: Map<number, number> | null = null;
    if (doc.details && typeof doc.details === 'object') {
      created = new Map();
      for (const [k, v] of Object.entries<any>(doc.details)) {
        const t = v && typeof v.created === 'string' ? Date.parse(v.created) : NaN;
        if (Number.isFinite(t)) created.set(Number(k), t);
      }
    }
    reads.push({ at, rows, created });
  }
  reads.sort((a, b) => a.at - b.at);
  return reads;
}

export function parseTask(doc: any, reads: Read[]): Task {
  const w = (doc && doc.window) || {};
  const slotMs = (num(w.slot_minutes) || 60) * 60 * 1000;
  let from = Date.parse(w.from || doc?.history_until || '');
  if (!Number.isFinite(from)) from = reads.length ? Math.ceil(reads[reads.length - 1].at / HOUR) * HOUR : 0;
  const slots = num(w.slots) || 72;
  let until = Date.parse(w.until || '');
  if (!Number.isFinite(until)) until = from + slots * slotMs;
  const places = Number.isInteger(doc?.places) && doc.places > 0 ? doc.places : 10;
  return { from, until, slots, slotMs, places };
}

function priorKernel(P: Params, k: number, r: number): number {
  const d = r - k;
  const width = P.kWidth0 + P.kWidthK * k;
  const near = Math.exp(-Math.abs(d) / (d < 0 ? width * P.kAbove : width));
  return near + P.kFar / (4 + r);
}

// prior per-game share of place k for a game at each rank 1..RANK_CAP, and the prior unnamed mass
function priorShares(P: Params, k: number, chartLen: number): { share: number[]; absent: number } {
  const absent = Math.min(0.6, P.u0 + P.u0K * k);
  const w: number[] = [];
  let tot = 0;
  for (let r = 1; r <= RANK_CAP; r++) {
    const v = r <= chartLen ? priorKernel(P, k, r) : 0;
    w.push(v);
    tot += v;
  }
  return { share: w.map((v) => ((1 - absent) * v) / tot), absent };
}

// The window's lags, in hours after the last read, one per slot.
function windowLags(task: Task, lastAt: number): number[] {
  const lags: number[] = [];
  for (let s = 0; s < task.slots; s++) lags.push((task.from + s * task.slotMs - lastAt) / HOUR);
  return lags;
}

// Fitted table: share[k][bin] (per game in the bin) and absent[k], averaged over the window lags.
export function fitTable(reads: Read[], task: Task, P: Params): { share: number[][]; absent: number[] } {
  const places = task.places;
  const last = reads[reads.length - 1];
  const lags = windowLags(task, last.at);
  const nBuckets = Math.max(1, Math.ceil((lags[lags.length - 1] + 1) / P.bucketH));
  // per bucket: accumulated weight and hits
  const tot = new Array(nBuckets).fill(0);
  const hit: number[][][] = [];
  const abs: number[][] = [];
  for (let b = 0; b < nBuckets; b++) {
    hit.push(Array.from({ length: places }, () => new Array(NB).fill(0)));
    abs.push(new Array(places).fill(0));
  }
  const pos = reads.map((r) => new Map(r.rows.map((g) => [g.id, g.rank] as [number, number])));
  const binCount = reads.map((r) => {
    const c = new Array(NB).fill(0);
    for (const g of r.rows) if (g.rank <= RANK_CAP) c[binOf(g.rank)] += 1;
    return c;
  });
  for (let j = 1; j < reads.length; j++) {
    const rw = Math.pow(0.5, (last.at - reads[j].at) / HOUR / P.halfLifeH);
    for (let i = 0; i < j; i++) {
      const lag = (reads[j].at - reads[i].at) / HOUR;
      const b = Math.floor(lag / P.bucketH);
      if (b >= nBuckets) continue;
      tot[b] += rw;
      const rowsJ = reads[j].rows;
      for (let k = 1; k <= places && k <= rowsJ.length; k++) {
        const r = pos[i].get(rowsJ[k - 1].id);
        if (r === undefined || r > RANK_CAP) abs[b][k - 1] += rw;
        else {
          const bin = binOf(r);
          hit[b][k - 1][bin] += rw / binCount[i][bin];
        }
      }
    }
  }
  const chartLen = last.rows.length;
  const share: number[][] = [];
  const absent: number[] = [];
  for (let k = 1; k <= places; k++) {
    const pr = priorShares(P, k, chartLen);
    const prBin = new Array(NB).fill(0);
    const prN = new Array(NB).fill(0);
    for (let r = 1; r <= RANK_CAP; r++) {
      prBin[binOf(r)] += pr.share[r - 1];
      prN[binOf(r)] += 1;
    }
    for (let b = 0; b < NB; b++) prBin[b] /= prN[b];
    const sh = new Array(NB).fill(0);
    let ab = 0;
    for (const lag of lags) {
      let b = Math.max(0, Math.floor(lag / P.bucketH));
      if (b >= nBuckets) b = nBuckets - 1;
      // fall back to the nearest shorter bucket with data
      let bb = b;
      while (bb > 0 && tot[bb] === 0) bb--;
      const t = tot[bb];
      const denom = t + P.alpha;
      for (let x = 0; x < NB; x++) sh[x] += (hit[bb][k - 1][x] + P.alpha * prBin[x]) / denom;
      ab += (abs[bb][k - 1] + P.alpha * pr.absent) / denom;
    }
    share.push(sh.map((v) => v / lags.length));
    absent.push(ab / lags.length);
  }
  return { share, absent };
}

// rank of each game of the last read at about lookH hours before it (absent: RANK_CAP + 1)
function pastRanks(reads: Read[], lookH: number): Map<number, number> | null {
  const last = reads[reads.length - 1];
  let best: Read | null = null;
  for (const r of reads) {
    if (r === last) continue;
    const ago = (last.at - r.at) / HOUR;
    if (ago < lookH * 0.5) continue;
    if (!best || Math.abs(ago - lookH) < Math.abs((last.at - best.at) / HOUR - lookH)) best = r;
  }
  if (!best) return null;
  return new Map(best.rows.map((g) => [g.id, g.rank] as [number, number]));
}

// per-game share at a continuous rank: piecewise-constant bins, linear between bin centres
function shareAt(sh: number[], rank: number): number {
  const centres: number[] = [];
  for (let b = 0; b < NB; b++) centres.push((BIN_EDGES[b] + BIN_EDGES[b + 1] - 1) / 2);
  if (rank <= centres[0]) return sh[0];
  for (let b = 0; b < NB - 1; b++) {
    if (rank <= centres[b + 1]) {
      const f = (rank - centres[b]) / (centres[b + 1] - centres[b]);
      return sh[b] * (1 - f) + sh[b + 1] * f;
    }
  }
  return sh[NB - 1];
}

export type Forecast = { probabilities: { universe_id: number; place: number; p: number }[]; top10: number[] };

export function forecast(reads: Read[], task: Task, P: Params = DEFAULTS): Forecast {
  const probabilities: Forecast['probabilities'] = [];
  if (reads.length === 0) return { probabilities, top10: fillTop10([]) };
  const last = reads[reads.length - 1];
  const table = fitTable(reads, task, P);
  const games = last.rows.slice(0, MAX_ROWS);
  const past = P.beta !== 0 ? pastRanks(reads, P.lookH) : null;
  // latest known created date per game, from any read
  const created = new Map<number, number>();
  for (const r of reads) if (r.created) for (const [id, t] of r.created) created.set(id, t);
  // fraction of the window's slots each game is still young enough to be on the chart
  const alive = games.map((g) => {
    const c = created.get(g.id);
    if (c === undefined) return 1;
    const exit = c + 28 * DAY;
    let n = 0;
    for (let s = 0; s < task.slots; s++) if (task.from + s * task.slotMs < exit) n++;
    return n / task.slots;
  });
  const effRank = games.map((g) => {
    if (!past) return g.rank;
    const prev = past.get(g.id) ?? RANK_CAP + 1;
    const trend = Math.log((prev + 2) / (g.rank + 2));
    return Math.max(1, g.rank * Math.exp(-P.beta * trend));
  });
  const grid: number[][] = [];
  for (let k = 1; k <= task.places; k++) {
    const sh = table.share[k - 1];
    const base = games.map((g) => shareAt(sh, g.rank));
    const baseSum = base.reduce((a, b) => a + b, 0);
    let w = games.map((g, i) => shareAt(sh, effRank[i]));
    const wSum = w.reduce((a, b) => a + b, 0);
    if (wSum > 0) w = w.map((v) => (v * baseSum) / wSum);
    // games leaving at day 28 give up their mass to everyone else, pro rata
    const before = w.reduce((a, b) => a + b, 0) + table.absent[k - 1];
    w = w.map((v, i) => v * alive[i]);
    const after = w.reduce((a, b) => a + b, 0) + table.absent[k - 1];
    const scale = after > 0 ? before / after : 1;
    w = w.map((v) => v * scale);
    let total = w.reduce((a, b) => a + b, 0);
    const absent = table.absent[k - 1] * scale;
    if (total + absent > 1) w = w.map((v) => v / (total + absent));
    grid.push(w);
    for (let i = 0; i < games.length; i++) {
      const p = Math.floor(w[i] * 1e8) / 1e8;
      if (p < P.pMin) continue;
      probabilities.push({ universe_id: games[i].id, place: k, p });
    }
  }
  // best guess: greedy over places by the highest probability left
  const top10: number[] = [];
  const used = new Set<number>();
  for (let k = 0; k < Math.min(10, grid.length); k++) {
    let bi = -1;
    for (let i = 0; i < games.length; i++) if (!used.has(i) && (bi < 0 || grid[k][i] > grid[k][bi])) bi = i;
    if (bi >= 0) {
      used.add(bi);
      top10.push(games[bi].id);
    }
  }
  return { probabilities, top10: fillTop10(top10) };
}

function fillTop10(ids: number[]): number[] {
  const out = ids.slice(0, 10);
  let filler = 1;
  while (out.length < 10) {
    if (!out.includes(filler)) out.push(filler);
    filler += 1;
  }
  return out;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  let text = '';
  try {
    text = fs.readFileSync(path.join(inDir, 'history.ndjson'), 'utf8');
  } catch {
    text = '';
  }
  let taskDoc: any = {};
  try {
    taskDoc = JSON.parse(fs.readFileSync(path.join(inDir, 'task.json'), 'utf8'));
  } catch {
    taskDoc = {};
  }
  const reads = parseHistory(text);
  const task = parseTask(taskDoc, reads);
  const out = forecast(reads, task, DEFAULTS);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'forecast.json'), JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
