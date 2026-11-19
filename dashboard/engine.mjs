// engine.mjs — the shared model of the Lensa radar (v2): one file, plain ES module, no dependencies.
// main.ts imports it to write the board; dashboard/app.js imports the same file so the page recomputes
// exactly what the board says. Nothing here reads the clock, the network or the file system.

export const MODEL = 'lensa-comps-2';
/** Pseudo-count of the empirical-Bayes weight n/(n+K): a thin group never overrules the pool. */
export const K = 4;
/** The ceiling's quantile of the live-token ratio pool, computed from the snapshot itself. */
export const CAP_QUANTILE = 0.9;
/** The bands the comparables are pooled across, by TVL in whole dollars. */
export const BANDS = ['<25M', '25-100M', '100-500M', '500M-2B', '>=2B'];

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const round = (x, d = 4) => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};
export const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A protocol records a token when the snapshot gives it a CoinGecko id or a ticker. */
export const hasToken = (p) => p.gecko_id !== null || p.symbol !== null;
/** The snapshot's own record of "no token yet": neither field is set. */
export const isPreToken = (p) => !hasToken(p);

/** TVL band of a protocol, by whole dollars. */
export function bandOf(tvl) {
  if (!(tvl > 0)) return '<25M';
  if (tvl >= 2_000_000_000) return '>=2B';
  if (tvl >= 500_000_000) return '500M-2B';
  if (tvl >= 100_000_000) return '100-500M';
  if (tvl >= 25_000_000) return '25-100M';
  return '<25M';
}

// Products of another protocol are not "a token still to come": the watchlist rule the snapshot's own
// README states lists them, and the same list keeps them out of the comparable pool.
const EXCLUDED = new Set(['Bridge', 'Cross Chain Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX', 'Staking Pool']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_NAME = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/i;

/** A pre-token candidate: no token recorded, no market cap, not a wrapped/staked/versioned product. */
export function eligible(p) {
  return isPreToken(p) && p.mcap_usd === null && !EXCLUDED.has(p.category) && !DERIVATIVE_NAME.test(p.name) && !EXCHANGE_NAME.test(p.name) && !VERSIONED.test(p.name);
}

/** Days since the snapshot began tracking the protocol, or null when it says none. */
export function ageDays(p, asOf) {
  if (!p.listed_at) return null;
  const days = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) ? Math.max(0, Math.floor(days)) : null;
}

/** Linear-interpolated quantile of a numeric array; NaN-free and stable for n=1. */
export function quantile(xs, q) {
  const a = [...xs].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const k = Math.floor(i);
  return a[k] + (a[Math.ceil(i)] - a[k]) * (i - k);
}

/** The live-token comparables: a ticker, a positive market cap and a positive TVL, ratio in log space. */
export function comparablePool(protocols) {
  return protocols
    .filter((p) => hasToken(p) && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ ...p, ratio: p.mcap_usd / p.tvl_usd, log: Math.log(p.mcap_usd / p.tvl_usd) }))
    .sort((a, b) => order(a.slug, b.slug));
}

/** The empirical-Bayes weight of a group of n comparables: n never counts for more than n/(n+K). */
export const weightOf = (n) => n / (n + K);

/**
 * Empirical Bayes in log space. The prior is the whole pool's median log ratio; each level pulls the
 * estimate toward its own median with weight n/(n+K), so a one-comparable category moves the estimate
 * by a fifth at most, and the TVL band (never thinner than eight comparables here) does the rest.
 */
function pull(est, xs) {
  const n = xs.length;
  if (!n) return { ...est, n: 0 };
  const med = quantile(xs, 0.5);
  const lo = quantile(xs, 0.25);
  const hi = quantile(xs, 0.75);
  return {
    med: est.med + weightOf(n) * (med - est.med),
    q25: est.q25 + weightOf(n) * (lo - est.q25),
    q75: est.q75 + weightOf(n) * (hi - est.q75),
    n,
  };
}

/**
 * The pooled multiple of one protocol: global median, then its TVL band, then its category, then the
 * intersection of the two. `exclude` drops the protocol itself from the pool so a live token is never
 * its own comparable.
 */
export function pooledMultiple(p, pool) {
  const others = pool.filter((x) => x.slug !== p.slug);
  if (!others.length) throw new Error('No live-token comparables in this snapshot');
  const logs = others.map((x) => x.log);
  const band = bandOf(p.tvl_usd);
  const inBand = others.filter((x) => bandOf(x.tvl_usd) === band);
  const inCat = p.category === null ? [] : others.filter((x) => x.category === p.category);
  const inBoth = inCat.filter((x) => bandOf(x.tvl_usd) === band);
  let est = { med: quantile(logs, 0.5), q25: quantile(logs, 0.25), q75: quantile(logs, 0.75) };
  const bandStep = pull(est, inBand.map((x) => x.log));
  est = bandStep;
  const catStep = pull(est, inCat.map((x) => x.log));
  est = catStep;
  const bothStep = pull(est, inBoth.map((x) => x.log));
  est = bothStep;
  // Distinct comparables the estimate actually draws on: the union of the band and the category.
  const used = new Set([...inBand, ...inCat].map((x) => x.slug));
  return {
    center: Math.exp(est.med),
    q25: Math.exp(est.q25),
    q75: Math.exp(est.q75),
    n_cat: inCat.length,
    n_band: inBand.length,
    n_catband: inBoth.length,
    n_eff: used.size,
    n_global: others.length,
    peers: [...(inCat.length ? inCat : inBand)]
      .sort((a, b) => Math.abs(Math.log(a.tvl_usd / Math.max(p.tvl_usd, 1))) - Math.abs(Math.log(b.tvl_usd / Math.max(p.tvl_usd, 1))) || order(a.slug, b.slug))
      .slice(0, 5)
      .map((x) => ({ slug: x.slug, name: x.name, tvl: x.tvl_usd, mcap: x.mcap_usd, ratio: round(x.ratio) })),
  };
}

/** The ceiling: the CAP_QUANTILE quantile of the live-token ratio pool, read from this snapshot. */
export function ratioCeiling(pool) {
  return quantile(pool.map((x) => x.ratio), CAP_QUANTILE);
}

/** Growth pass-through: 35% of the seven-day TVL change, hard-clamped to +-40% before it is applied. */
export function growthFactor(change7d) {
  return 1 + 0.35 * clamp(change7d ?? 0, -40, 40) / 100;
}

/** How long the protocol has run without a token: 0.70 at zero days, 1.00 at three years. */
export function maturityFactor(age) {
  return age === null ? 0.78 : 0.70 + 0.30 * Math.min(age, 1095) / 1095;
}

/** Chain count is reach, not distribution: at most a 9% premium. */
export function diversityFactor(chains) {
  return 1 + 0.03 * Math.min(3, Math.max(0, new Set(chains).size - 1));
}

/**
 * One row's value: TVL x pooled multiple x growth x maturity x diversity, with the multiple held under
 * the snapshot's own ceiling. The interval maps the same factors over the peer quartiles, so it is a
 * statement about comparables, not a probability.
 */
export function valueOf(p, asOf, pool, ceiling) {
  const pooled = pooledMultiple(p, pool);
  const age = ageDays(p, asOf);
  const growth = growthFactor(p.change_7d);
  const maturity = maturityFactor(age);
  const diversity = diversityFactor(p.chains);
  const applied = (m) => Math.min(m, ceiling);
  const base = p.tvl_usd * growth * maturity * diversity;
  const value = Math.max(1, Math.round(base * applied(pooled.center)));
  const low = Math.max(1, Math.round(base * Math.min(pooled.q25, pooled.center)));
  const high = Math.max(value, Math.round(base * applied(Math.max(pooled.q75, pooled.center))));
  const missing = (age === null ? 1 : 0) + (p.change_7d === null ? 1 : 0) + (p.category === null ? 1 : 0) + (p.chains.length === 0 ? 1 : 0);
  const uncertainty = round(clamp((high - low) / (2 * value), 0.05, 0.95));
  const confidence = pooled.n_eff >= 40 && missing === 0 && uncertainty < 0.55 ? 'Tinggi' : pooled.n_eff >= 12 && missing <= 1 ? 'Sedang' : 'Rendah';
  return {
    age,
    growth: round(growth),
    maturity: round(maturity),
    diversity: round(diversity),
    missing,
    uncertainty,
    confidence,
    capped: pooled.center > ceiling,
    implied_value_usd: value,
    low_usd: low,
    high_usd: high,
    stats: {
      n: pooled.n_cat,
      n_cat: pooled.n_cat,
      n_band: pooled.n_band,
      n_catband: pooled.n_catband,
      n_eff: pooled.n_eff,
      n_global: pooled.n_global,
      band: bandOf(p.tvl_usd),
      multiple: round(applied(pooled.center), 3),
      multiple_raw: round(pooled.center, 3),
      q25: round(Math.min(pooled.q25, pooled.center), 3),
      q75: round(Math.max(pooled.q75, pooled.center), 3),
      peers: pooled.peers,
    },
  };
}

// ---------------------------------------------------------------- farm plans

const CHAIN_GAS = {
  Ethereum: { gas: '$2.50–9.00', bridge: 'Across atau Stargate', minutes: 14 },
  Base: { gas: '$0.02–0.09', bridge: 'resmi Base Bridge (7 hari keluar) atau Across (2 menit)', minutes: 8 },
  Arbitrum: { gas: '$0.03–0.15', bridge: 'Arbitrum Bridge resmi (10 menit) atau Across', minutes: 10 },
  Optimism: { gas: '$0.02–0.10', bridge: 'Optimism Bridge resmi atau Across', minutes: 9 },
  Polygon: { gas: '$0.01–0.06', bridge: 'Polygon PoS Bridge resmi', minutes: 11 },
  Solana: { gas: '<$0.01', bridge: 'Wormhole atau portal resmi Solana', minutes: 7 },
  BSC: { gas: '$0.05–0.25', bridge: 'Stargate atau jembatan resmi BNB Chain', minutes: 12 },
  Avalanche: { gas: '$0.04–0.20', bridge: 'Avalanche Bridge resmi', minutes: 10 },
};
const DEFAULT_GAS = { gas: '$0.05–0.60', bridge: 'jembatan resmi yang tercantum di dokumentasi protokol', minutes: 12 };

/** The chain a plan names: the protocol's largest well-known chain, else its first chain. */
export function primaryChain(p) {
  const known = p.chains.filter((c) => CHAIN_GAS[c]);
  return known[0] ?? p.chains[0] ?? 'chain yang dikonfirmasi di dokumentasi';
}

/** The capital ladder: a fixed share of TVL, rounded down to the ladder, never over $1,200. */
export function capitalFor(tvl) {
  const raw = tvl * 0.000_000_4;
  for (const step of [1_200, 800, 500, 250, 120]) if (raw >= step) return step;
  return 100;
}

function fuel(chain) {
  return CHAIN_GAS[chain] ?? DEFAULT_GAS;
}

/** The category's core action, in one sentence with its own numbers filled in at the call site. */
function coreAction(category, name, chain, capital) {
  const c = (category ?? '').toLowerCase();
  if (/curator|allocator/.test(c)) return `Setor $${capital} USDC ke vault ${name} di ${chain} yang asetnya sudah kamu pegang (USDC atau ETH), simpan share receipt-nya, dan jangan aktifkan leverage apa pun`;
  if (/lend|collateral|cdp/.test(c)) return `Supply $${capital} USDC ke pasar ${name} di ${chain} tanpa borrow, lalu cek utilization dan available liquidity pasar itu`;
  if (/dex|liquidity|amm/.test(c)) return `Swap $${capital} dari aset yang sudah kamu pegang lewat pool utama ${name} di ${chain} hanya bila spread <0,5%, lalu simpan hash-nya`;
  if (/yield|farm|basis|vault/.test(c)) return `Deposit $${capital} USDC ke strategi tanpa leverage ${name} di ${chain} setelah membaca aset dasar, fee, dan antrean keluarnya`;
  if (/derivative|perpetual|option|prediction/.test(c)) return `Buka posisi demo $0 di ${name} (${chain}) lebih dulu; bila tidak ada demo, cukup catat order book-nya tanpa transaksi`;
  if (/rwa|credit|insurance|payment|stable/.test(c)) return `Periksa syarat yurisdiksi, KYC, minimum, dan waktu redemption ${name} di ${chain}; jangan setor $${capital} bila syarat ritel tidak terpenuhi`;
  if (/restak|staking|anchor/.test(c)) return `Stake $${capital} dari aset staking yang sudah kamu pegang lewat ${name} di ${chain} dan simpan bukti receipt-nya`;
  if (/chain|index/.test(c)) return `Pakai $${capital} untuk satu interaksi publik dengan ${name} di ${chain}: bridge masuk, satu swap, lalu catat biaya totalnya`;
  return `Lakukan satu interaksi publik bernilai $${capital} dengan ${name} di ${chain} hanya bila dokumentasinya menyebut aksi pengguna dan cara keluarnya`;
}

/**
 * The plan: 7 steps, each with a cost in dollars and a duration in minutes, generated from the row's
 * own figures (chain, TVL, age, seven-day change) and never a slogan. `watchlist` only changes the
 * first step's wording: a watchlist protocol is one the house already tracks at the floor.
 */
export function farmPlan(p, asOf) {
  const chain = primaryChain(p);
  const f = fuel(chain);
  const capital = capitalFor(p.tvl_usd);
  const age = ageDays(p, asOf);
  const hold = age !== null && age < 180 ? 28 : 14;
  const tvl = p.tvl_usd >= 1e9 ? `$${(p.tvl_usd / 1e9).toFixed(2)} miliar` : `$${(p.tvl_usd / 1e6).toFixed(0)} juta`;
  const chg = p.change_7d === null ? 'tidak tercatat' : `${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}%`;
  const mode = capital >= 500 ? 'Uji bermodal' : capital >= 250 ? 'Uji kecil' : 'Riset murah';
  const steps = [
    `Verifikasi ${p.name} (${p.category ?? 'kategori tidak tercatat'}, ${chain}, TVL ${tvl}) lewat direktori DefiLlama dan dokumentasi resminya; snapshot ${asOf} mencatat gecko_id ${p.gecko_id === null ? 'null' : p.gecko_id} dan symbol ${p.symbol === null ? 'null' : p.symbol}, jadi status token belum terbukti. Biaya $0, waktu 12 menit.`,
    `Siapkan modal di ${chain}: bridge minimal $${capital} USDC lewat ${f.bridge}, fee jembatan sekitar $${(capital * 0.0005).toFixed(2)} (0,05%) ditambah gas ${f.gas} per transaksi. Perkiraan total biaya masuk $${(capital * 0.0005 + 0.6).toFixed(2)}, waktu ${f.minutes} menit.`,
    `${coreAction(p.category, p.name, chain, capital)}. Gas ${f.gas}, biaya transaksi keluar-masuk sekitar $${Math.max(0.05, 0.25).toFixed(2)} di ${chain}, waktu 6 menit.`,
    `Batasi risiko pada posisi ini: pokok maksimum $${capital}, satu approval per kontrak dengan allowance tepat $${capital} (bukan unlimited), dan hentikan penambahan bila TVL 7 hari turun lebih dari 20% dari angka ${chg} sekarang. Biaya approval ${f.gas}, waktu 5 menit.`,
    `Uji jalur keluar sekarang, bukan nanti: withdraw 10% dari posisi ($${Math.round(capital * 0.1)}) dan pastikan dana kembali utuh setelah fee. Gas ${f.gas}, waktu 7 menit; bila keluar butuh lockup lebih dari 7 hari, turunkan modal ke $${Math.round(capital / 4)}.`,
    `Tinjau ulang tiap 7 hari selama ${hold} hari: catat TVL, insiden keamanan, pengumuman insentif, dan perubahan syarat di ${chain}. Biaya cek $0 selama tidak ada transaksi, waktu 8 menit per minggu; durasi ${hold} hari adalah jadwal observasi, bukan syarat reward.`,
    `Simpan bukti: hash transaksi, screenshot posisi, dan tanggal masuk-keluar di satu berkas. Biaya $0, waktu 5 menit. Ekspektasi reward untuk ${p.name} saat ini $0 karena snapshot tidak memuat kampanye apa pun; seluruh biaya di atas adalah uang yang bisa hilang.`,
  ];
  return { chain, capital, hold, mode, gas: f.gas, steps };
}

// ---------------------------------------------------------------- the radar

function quantileSummary(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { min: v[0] ?? null, p25: quantile(v, 0.25), median: quantile(v, 0.5), p75: quantile(v, 0.75), max: v[v.length - 1] ?? null, n: v.length };
}

/**
 * The whole radar: two cohorts, ranked apart on the page and never merged into one ordering. The pre-token cohort is the watchlist
 * plus every protocol the snapshot records no token for; the trading cohort is every protocol whose
 * token already trades, valued by the same model so the page can show the model's own error on them.
 */
export function buildRadar(snapshot) {
  const protocols = snapshot.protocols;
  const watch = new Set(snapshot.watchlist);
  const pool = comparablePool(protocols);
  const ceiling = ratioCeiling(pool);
  const asOf = snapshot.as_of;

  const preToken = protocols
    .filter((p) => watch.has(p.slug) || eligible(p))
    .map((p) => {
      const v = valueOf(p, asOf, pool, ceiling);
      const plan = farmPlan(p, asOf);
      return { ...p, cohort: 'pre-token', token_status: 'no-token-recorded', watchlist: watch.has(p.slug), ...v, farm: { chain: plan.chain, capital: plan.capital, hold: plan.hold, mode: plan.mode, gas: plan.gas }, farm_steps: plan.steps };
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || order(a.slug, b.slug))
    .map((r, i) => ({ ...r, cohort_rank: i + 1 }));

  const trading = protocols
    .filter((p) => hasToken(p) && p.tvl_usd > 0)
    .map((p) => {
      const v = valueOf(p, asOf, pool, ceiling);
      const plan = farmPlan(p, asOf);
      const gap = p.mcap_usd > 0 ? round(Math.log(v.implied_value_usd / p.mcap_usd), 3) : null;
      return { ...p, cohort: 'trading', token_status: 'trading', watchlist: false, ...v, model_gap_log: gap, farm: { chain: plan.chain, capital: plan.capital, hold: plan.hold, mode: plan.mode, gas: plan.gas }, farm_steps: plan.steps };
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || order(a.slug, b.slug))
    .map((r, i) => ({ ...r, cohort_rank: i + 1 }));

  // The board's own rank is global and dense: 1..N once each over every row, by implied value, so
  // the gate's sorted_by_value holds. The page keeps the two cohorts apart and shows each row's
  // place inside its own cohort (cohort_rank); the global rank is the board's claim, not the page's order.
  const rows = [...preToken, ...trading]
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || order(a.slug, b.slug))
    .map((r, i) => ({ ...r, rank: i + 1 }));

  // The model's own error on the cohort whose value the market already prices; the page prints it
  // beside the error of pricing every token at the pool's median ratio, so the shrinkage earns its keep
  // or does not: a model no better than the median has no ranking to defend.
  const priced = trading.filter((r) => r.model_gap_log !== null).map((r) => Math.abs(r.model_gap_log));
  const poolMedianLog = quantile(pool.map((x) => x.log), 0.5) ?? 0;
  const baseline = trading
    .filter((r) => r.mcap_usd > 0)
    .map((r) => Math.abs(Math.log(r.mcap_usd / r.tvl_usd) - poolMedianLog));
  const medianError = quantile(priced, 0.5) ?? 0;
  const baselineError = quantile(baseline, 0.5) ?? 0;
  const calibration = {
    n: priced.length,
    median_abs_log_error: round(medianError, 3),
    baseline_median_abs_log_error: round(baselineError, 3),
    skill: round(baselineError > 0 ? 1 - medianError / baselineError : 0, 3),
    within_2x: priced.filter((x) => x <= Math.log(2)).length,
  };

  const stepLengths = [...preToken, ...trading].flatMap((r) => r.farm_steps.map((s) => s.trim().length));
  const farmStats = {
    steps_per_row: preToken.length ? preToken[0].farm_steps.length : 0,
    min: Math.min(...stepLengths),
    median: quantile(stepLengths, 0.5),
    max: Math.max(...stepLengths),
    under_120: stepLengths.filter((x) => x < 120).length,
  };

  const ratio = quantileSummary(preToken.map((r) => r.implied_value_usd / r.tvl_usd));
  return {
    version: MODEL,
    as_of: asOf,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    universe: protocols.length,
    watchlist: snapshot.watchlist,
    cohorts: { preToken, trading },
    rows,
    ceiling: round(ceiling, 3),
    ceiling_quantile: CAP_QUANTILE,
    k: K,
    comp_count: pool.length,
    pool_ratio: quantileSummary(pool.map((x) => x.ratio)),
    calibration,
    farm: farmStats,
    n_eff: quantileSummary(preToken.map((r) => r.stats.n_eff)),
    n_cat: quantileSummary(preToken.map((r) => r.stats.n_cat)),
    ratio,
    ratio_over_030: preToken.filter((r) => r.implied_value_usd / r.tvl_usd > 0.3).length,
    capped_rows: preToken.filter((r) => r.capped).length,
  };
}