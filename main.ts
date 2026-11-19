// main.ts — token-radar-01 entry runner (Node 22, standard library plus the vendored dossier writer).
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>), builds both cohorts with the
// shared model in dashboard/engine.mjs, writes the ranked board to /output/board.json, writes the page's
// data to /output/data.js beside the dashboard, copies dashboard/ and screenshots/ to /output and, last,
// writes /output/dossier.json with the vendored buildDossier.
//
//   grader:  node main.ts                       (/input/snapshot.json -> /output)
//   locally: MAKEFUN_OUTPUT_DIR=out node main.ts --input /root/tr-kit/token-radar-01-kit/input/snapshot.json
//   preview: ... --preview                      (board + data only; no screenshots, no dossier)
//
// The gate's shape is checked here before anything is written: 100..4000 rows, one row per slug, dense
// ranks inside each cohort, whole-dollar values inside the cap, farm plans of 3..12 steps of 20..600
// characters, every watchlist slug present, exactly three screenshots under 512 KiB, dossier under 1.5 MiB.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar } from './dashboard/engine.mjs';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const SHOT_NAMES = ['1-board.png', '2-detail.png', '3-filtered.png'];

/** --name <value> or --name=<value> out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount /input`);
const raw = readFileSync(inputFile);
const snapshot = JSON.parse(raw.toString('utf8'));
if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.as_of)) fail('snapshot is not the sealed shape (protocols, watchlist, as_of)');

const radar = buildRadar(snapshot);
const rows = radar.rows;
const preToken = radar.cohorts.preToken;
const trading = radar.cohorts.trading;

// ---- the gate's shape, checked before a byte is written
if (rows.length < 100 || rows.length > 4000) fail(`board holds ${rows.length} rows, outside 100..4000`);
const slugs = new Set(rows.map((r) => r.slug));
if (slugs.size !== rows.length) fail('a slug appears twice on the board');
for (const want of snapshot.watchlist) if (!slugs.has(want)) fail(`watchlist slug ${want} is missing from the board`);
for (const cohort of [preToken, trading]) {
  cohort.forEach((r, i) => {
    if (r.cohort_rank !== i + 1) fail(`cohort ranks are not dense in ${r.cohort}: ${r.slug} is ${r.cohort_rank} at ${i + 1}`);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) fail(`implied value out of range: ${r.slug}`);
    if (i > 0 && cohort[i - 1]!.implied_value_usd < r.implied_value_usd) fail(`values are not monotone in ${r.cohort} at ${r.slug}`);
    if (r.farm_steps.length < 5 || r.farm_steps.length > 7) fail(`farm plan length ${r.farm_steps.length} for ${r.slug}`);
    for (const step of r.farm_steps) {
      const n = step.trim().length;
      if (n < 120 || n > 600) fail(`farm step of ${n} chars for ${r.slug} (want 120..600)`);
    }
  });
}
if (new Set(preToken.map((r) => r.implied_value_usd)).size < 2) fail('the pre-token cohort ranks nothing by value');

// The gate's sorted_by_value: the whole board's ranks are exactly 1..N once each, and the value
// never rises as the rank ascends.
{
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  if (byRank.some((r, i) => r.rank !== i + 1)) fail('the board ranks are not 1..N once each over all rows');
  for (let i = 1; i < byRank.length; i++) if (byRank[i - 1]!.implied_value_usd < byRank[i]!.implied_value_usd) fail(`values rise as rank ascends at ${byRank[i]!.slug}`);
}

const out = resolve(arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output'));
if (out === resolve(here) || out === resolve(here, 'dashboard') || out === resolve(here, 'screenshots')) fail('output must not overwrite the source');
mkdirSync(out, { recursive: true });

function copyTree(from: string, to: string): number {
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(from, name);
    const st = lstatSync(p);
    if (st.isDirectory()) n += copyTree(p, join(to, name));
    else if (st.isFile()) {
      copyFileSync(p, join(to, name));
      n += 1;
    } else fail(`only regular files and directories are copied, not ${p}`);
  }
  return n;
}

writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: radar.version, as_of: radar.as_of, cohorts: { 'pre-token': preToken.length, trading: trading.length }, rows })}\n`);

// The page's data: raw snapshot fields only, so the page recomputes the identical model with no network
// and no second copy of any number the board states. Kept outside dashboard/ so the dossier's text (the
// dashboard's source) stays inside 64 KiB.
const compact = snapshot.protocols.map((p: any) => [p.slug, p.name, p.category, p.chains, p.tvl_usd, p.change_7d, p.mcap_usd, p.listed_at, p.gecko_id, p.symbol]);
const data = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  watchlist: snapshot.watchlist,
  protocols: compact,
};
writeFileSync(join(out, 'data.js'), `window.SEALED=${JSON.stringify(data).replace(/</g, '\\u003c')};\n`);
writeFileSync(
  join(out, 'provenance.json'),
  `${JSON.stringify({
    model: radar.version,
    snapshot_sha256: createHash('sha256').update(raw).digest('hex'),
    as_of: radar.as_of,
    rows: rows.length,
    pre_token: preToken.length,
    trading: trading.length,
    watchlist: snapshot.watchlist.length,
    comparables: radar.comp_count,
    ceiling: radar.ceiling,
    calibration: radar.calibration,
    farm: radar.farm,
  })}\n`,
);
copyTree(join(here, 'dashboard'), join(out, 'dashboard'));

if (process.argv.includes('--preview')) {
  process.stdout.write(
    `${JSON.stringify({
      preview: true,
      rows: rows.length,
      pre_token: preToken.length,
      trading: trading.length,
      watchlist: snapshot.watchlist.length,
      comparables: radar.comp_count,
      ceiling: radar.ceiling,
      capped_rows: radar.capped_rows,
      calibration: radar.calibration,
      n_eff: radar.n_eff,
      n_cat: radar.n_cat,
      ratio: radar.ratio,
      farm: radar.farm,
      top: preToken.slice(0, 5).map((r: any) => ({ name: r.name, value: r.implied_value_usd, n: r.stats.n_cat, n_eff: r.stats.n_eff, ratio: +(r.implied_value_usd / r.tvl_usd).toFixed(3) })),
    })}\n`,
  );
} else {
  const shotsDir = join(here, 'screenshots');
  if (!existsSync(shotsDir)) fail('three screenshots are required in screenshots/');
  copyTree(shotsDir, join(out, 'screenshots'));
  const shots = readdirSync(join(out, 'screenshots')).filter((n) => !n.startsWith('.'));
  if (shots.length !== 3) fail(`screenshots/ holds ${shots.length} files, want exactly 3`);
  for (const name of SHOT_NAMES) if (!shots.includes(name)) fail(`screenshots/${name} is missing`);
  for (const name of shots) {
    const bytes = statSync(join(out, 'screenshots', name)).size;
    if (bytes > SHOT_CAPS.max_bytes) fail(`screenshots/${name} is ${bytes} bytes, over 524288`);
  }
  const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
  if (dossier.length > 1_572_864) fail(`dossier is ${dossier.length} bytes, over the competition's 1.5 MiB`);
  writeFileSync(join(out, 'dossier.json'), dossier);
  const text = JSON.parse(new TextDecoder().decode(dossier)).text as string;
  process.stdout.write(
    `${JSON.stringify({
      rows: rows.length,
      pre_token: preToken.length,
      trading: trading.length,
      watchlist: snapshot.watchlist.length,
      comparables: radar.comp_count,
      dossier_bytes: dossier.length,
      dossier_text_bytes: Buffer.byteLength(text, 'utf8'),
    })}\n`,
  );
}