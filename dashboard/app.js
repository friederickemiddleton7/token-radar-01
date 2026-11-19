import { buildRadar, farmPlan } from './engine.mjs';

const S = window.SEALED;
const protocols = S.protocols.map((x) => ({
  slug: x[0], name: x[1], category: x[2], chains: x[3], tvl_usd: x[4],
  change_7d: x[5], mcap_usd: x[6], listed_at: x[7], gecko_id: x[8], symbol: x[9],
}));
const radar = buildRadar({ as_of: S.as_of, source: S.source, floor_usd: S.floor_usd, watchlist: S.watchlist, protocols });
const A = radar.cohorts.preToken;
const B = radar.cohorts.trading;
const bySlug = new Map(radar.rows.map((r) => [r.slug, r]));

let tab = 'board';
let detail = null;
let selected = A[0] ? A[0].slug : null;
let query = '';
let category = '';
let confidence = '';
let watchOnly = false;
let sort = 'rank';

// A view can be addressed from the URL hash (#tab=board&slug=…&cat=…&conf=…&q=…&watch=1): the three
// screenshots are the real page reached that way, and a reader can open any protocol's dossier directly.
const init = (() => {
  if (typeof location === 'undefined' || !location.hash) return new URLSearchParams('');
  return new URLSearchParams(location.hash.replace(/^#/, ''));
})();
if (['board', 'trading', 'method'].includes(init.get('tab') ?? '')) tab = init.get('tab');
if (init.get('slug')) {
  detail = init.get('slug');
  selected = detail;
}
if (init.get('cat')) category = init.get('cat');
if (['Tinggi', 'Sedang', 'Rendah'].includes(init.get('conf') ?? '')) confidence = init.get('conf');
if (init.get('q')) query = init.get('q').toLowerCase();
if (init.get('watch') === '1') watchOnly = true;

const $ = (id) => document.getElementById(id);
const money = (x) => {
  const n = Math.round(x ?? 0);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
};
const pct = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const mult = (x) => `${x.toFixed(2)}×`;
const ratioOf = (r) => r.implied_value_usd / Math.max(r.tvl_usd, 1);
const gapOf = (r) => (r.mcap_usd > 0 ? r.implied_value_usd / r.mcap_usd : null);
const tagClass = (c) => (c === 'Tinggi' ? 'tag' : c === 'Sedang' ? 'tag mid' : 'tag low');

function passes(r) {
  const hay = `${r.name} ${r.slug} ${r.category ?? ''} ${r.symbol ?? ''}`.toLowerCase();
  if (query && !hay.includes(query)) return false;
  if (category && r.category !== category) return false;
  if (confidence && r.confidence !== confidence) return false;
  if (watchOnly && !r.watchlist) return false;
  return true;
}
function sortRows(rows) {
  const cmp = {
    value: (x, y) => y.implied_value_usd - x.implied_value_usd,
    tvl: (x, y) => y.tvl_usd - x.tvl_usd,
    ratio: (x, y) => ratioOf(y) - ratioOf(x),
    rank: (x, y) => x.cohort_rank - y.cohort_rank,
  }[sort] ?? ((x, y) => x.cohort_rank - y.cohort_rank);
  return [...rows].sort(cmp);
}

// ------------------------------------------------------------------ the two cohort tables

function tableA(rows) {
  return `<div class="table-wrap"><table>
  <thead><tr>
    <th>#</th><th>Protokol belum bertoken</th>
    <th class="num"><button data-sort="value">Nilai implisit ↕</button></th>
    <th class="num"><button data-sort="tvl">TVL ↕</button></th>
    <th class="num">n eff / kat</th>
    <th class="num"><button data-sort="ratio">Nilai/TVL ↕</button></th>
    <th>7D</th><th>Conf.</th>
  </tr></thead><tbody>${rows.map((r) => `
  <tr data-slug="${r.slug}" class="${r.slug === selected && !detail ? 'selected' : ''}">
    <td class="rank">${r.cohort_rank}</td>
    <td class="proto"><button class="protocol" data-detail="${r.slug}">${r.name}</button>
      <small>${r.category ?? 'Uncategorized'} · ${r.chains.slice(0, 3).join(' · ') || 'chain tidak tercatat'}${r.watchlist ? ' · watchlist' : ''}</small></td>
    <td class="value num"><b>${money(r.implied_value_usd)}</b><small>${money(r.low_usd)}–${money(r.high_usd)}</small>
      <div class="bar"><i style="width:${Math.max(8, Math.min(100, ratioOf(r) * 34))}%"></i></div></td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="ncell">${r.stats.n_eff} / ${r.stats.n_cat}</td>
    <td class="num">${ratioOf(r).toFixed(2)}×</td>
    <td class="num ${(r.change_7d ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
    <td><span class="${tagClass(r.confidence)}">${r.confidence}</span></td>
  </tr>`).join('')}</tbody></table></div>`;
}

function tableB(rows) {
  return `<div class="table-wrap"><table>
  <thead><tr>
    <th>#</th><th>Protokol yang tokennya sudah trading</th>
    <th class="num"><button data-sort="tvl">TVL ↕</button></th>
    <th class="num">MCAP AKTUAL</th>
    <th class="num"><button data-sort="value">Nilai model ↕</button></th>
    <th class="num">MODEL / AKTUAL</th>
    <th>7D</th>
  </tr></thead><tbody>${rows.map((r) => {
    const g = gapOf(r);
    const cls = g === null ? '' : g >= 1 ? 'gap-pos' : 'gap-neg';
    return `
  <tr data-slug="${r.slug}" class="${r.slug === selected && !detail ? 'selected' : ''}">
    <td class="rank">${r.cohort_rank}</td>
    <td class="proto"><button class="protocol" data-detail="${r.slug}">${r.name}</button>
      <span class="sym">${r.symbol ?? '—'}</span>
      <small>${r.category ?? 'Uncategorized'} · ${r.chains.slice(0, 2).join(' · ') || 'chain tidak tercatat'}</small></td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num">${r.mcap_usd === null ? '—' : money(r.mcap_usd)}</td>
    <td class="value num"><b>${money(r.implied_value_usd)}</b><small>${money(r.low_usd)}–${money(r.high_usd)}</small></td>
    <td class="num ${cls}">${g === null ? '—' : `${g.toFixed(2)}×`}</td>
    <td class="num ${(r.change_7d ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
  </tr>`;
  }).join('')}</tbody></table></div>`;
}

function cohortPanel(which, rows) {
  const isA = which === 'A';
  const all = isA ? A : B;
  return `<section class="cohort">
    <div class="cohort-head">
      <span class="${isA ? 'tag-a' : 'tag-b'}">${isA ? 'A' : 'B'}</span>
      <h2>${isA ? 'Belum bertoken — dinilai dengan pembanding' : 'Token sudah trading — dipakai mengukur model'}</h2>
      <span class="meta">${rows.length}/${all.length} baris · peringkat ${isA ? 'A' : 'B'}</span>
    </div>
    <div class="scroll${isA ? '' : ' tall'}">${isA ? tableA(rows) : tableB(rows)}</div>
  </section>`;
}

// ------------------------------------------------------------------ the aside card

function aside(r) {
  if (!r) return '<aside class="aside">Pilih protokol di tabel.</aside>';
  const trading = r.cohort === 'trading';
  const g = gapOf(r);
  return `<aside class="aside">
    <p class="eyebrow">${trading ? 'Kohort B · sudah trading' : 'Kohort A · belum bertoken'} · peringkat ${r.cohort_rank} kohort · papan #${r.rank} · ${r.watchlist ? 'watchlist' : 'radar'}</p>
    <h2>${r.name}</h2>
    <p class="muted">${r.category ?? 'Kategori tidak tercatat'} · ${r.chains.join(', ') || 'chain tidak tercatat'}</p>
    <div class="big">${money(r.implied_value_usd)}</div>
    <div class="minor">nilai implisit model · rentang ${money(r.low_usd)}–${money(r.high_usd)}</div>
    <div class="divider"></div>
    <div class="pair"><span>TVL</span><strong>${money(r.tvl_usd)}</strong></div>
    <div class="pair"><span>Nilai / TVL</span><strong>${mult(ratioOf(r))}</strong></div>
    <div class="pair"><span>Pembanding dipakai</span><strong>${r.stats.n_eff} (kat ${r.stats.n_cat}, pita ${r.stats.n_band})</strong></div>
    ${trading
      ? `<div class="pair"><span>Market cap aktual</span><strong>${r.mcap_usd === null ? '—' : money(r.mcap_usd)}</strong></div>
         <div class="pair"><span>Model / aktual</span><strong>${g === null ? '—' : mult(g)}</strong></div>`
      : `<div class="pair"><span>7D change</span><strong>${pct(r.change_7d)}</strong></div>
         <div class="pair"><span>Usia tanpa token</span><strong>${r.age === null ? '—' : `${r.age} hari`}</strong></div>`}
    <div class="notice ${r.confidence === 'Rendah' ? 'warn' : ''}">Confidence ${r.confidence} · faktor hilang ${r.missing} · ${trading ? 'token sudah tercatat di snapshot' : 'snapshot mencatat gecko_id dan symbol null'}. Interval = kuartil pembanding, bukan peluang.</div>
    <button class="action" data-detail="${r.slug}">BUKA DOSSIER &amp; RENCANA FARM →</button>
  </aside>`;
}

// ------------------------------------------------------------------ the detail view

function detailView(r) {
  const plan = farmPlan(r, S.as_of);
  const trading = r.cohort === 'trading';
  const g = gapOf(r);
  return `<button class="back" data-back="1">← KEMBALI KE RADAR</button>
  <div class="detail-grid">
    <div class="box">
      <p class="eyebrow">${trading ? 'KOHORT B · TOKEN SUDAH TRADING' : r.watchlist ? 'KOHORT A · WATCHLIST FLOOR' : 'KOHORT A · DISCOVERY'}</p>
      <h2>${r.name} ${r.symbol ? `<span class="sym">${r.symbol}</span>` : ''}</h2>
      <p class="muted">${r.category ?? 'Kategori tidak tercatat'} · ${r.chains.join(', ') || 'chain tidak tercatat'} · dilacak sejak ${r.listed_at ?? 'tidak tercatat'}</p>
      <div class="big">${money(r.implied_value_usd)}</div>
      <p class="minor">${trading
        ? `Nilai model vs market cap aktual ${r.mcap_usd === null ? '—' : money(r.mcap_usd)}: ${g === null ? '—' : mult(g)}. Baris ini adalah uji model, bukan kandidat.`
        : 'Market cap token hipotetis bila tokennya terbit hari ini; bukan FDV dan bukan alokasi untuk pengguna.'} Rentang ${money(r.low_usd)}–${money(r.high_usd)} dari kuartil pembanding.</p>
      <div class="formula">
        <div class="factor"><b>${money(r.tvl_usd)}</b><small>TVL</small></div>
        <div class="factor"><b>${mult(r.stats.multiple)}</b><small>multiple gabungan</small></div>
        <div class="factor"><b>${r.growth.toFixed(2)}×</b><small>growth 7d</small></div>
        <div class="factor"><b>${r.maturity.toFixed(2)}×</b><small>usia tanpa token</small></div>
        <div class="factor"><b>${r.diversity.toFixed(2)}×</b><small>jumlah chain</small></div>
        <div class="factor"><b>${r.uncertainty.toFixed(2)}</b><small>lebar interval</small></div>
      </div>
      <div class="chiprow">
        <span class="chip">pita TVL <b>${r.stats.band}</b></span>
        <span class="chip">n kategori <b>${r.stats.n_cat}</b></span>
        <span class="chip">n kategori×pita <b>${r.stats.n_catband}</b></span>
        <span class="chip">n pita <b>${r.stats.n_band}</b></span>
        <span class="chip">n dipakai <b>${r.stats.n_eff}</b></span>
        <span class="chip">pool global <b>${r.stats.n_global}</b></span>
        ${r.capped ? '<span class="chip">di plafon <b>' + radar.ceiling.toFixed(2) + '×</b></span>' : ''}
      </div>
      <div class="notice">Multiple mentah ${mult(r.stats.multiple_raw)} ditarik ke median global 128 token yang sudah trading dengan bobot n/(n+4) per tingkat, lalu ditahan di plafon ${mult(radar.ceiling)} (kuantil ${Math.round(radar.ceiling_quantile * 100)} dari pool). Interval ${money(r.low_usd)}–${money(r.high_usd)} berasal dari kuartil pembanding, bukan probabilitas.</div>
      <h3>Pembanding terdekat</h3>
      <table class="peer-table"><thead><tr><th>Token live</th><th class="num">TVL</th><th class="num">MCAP</th><th class="num">MCAP/TVL</th></tr></thead>
      <tbody>${r.stats.peers.map((p) => `<tr><td>${p.name}</td><td class="num">${money(p.tvl)}</td><td class="num">${money(p.mcap)}</td><td class="num">${p.ratio.toFixed(2)}×</td></tr>`).join('') || '<tr><td colspan="4">Tidak ada pembanding kategori; pita TVL dan pool global dipakai.</td></tr>'}</tbody></table>
    </div>
    <div class="box">
      <p class="eyebrow">RENCANA FARM · ${plan.mode.toUpperCase()}</p>
      <h3>${plan.steps.length} langkah, tiap langkah berbiaya dan berdurasi</h3>
      <p class="notice warn">Snapshot tidak memuat kampanye reward, poin, atau tanggal token untuk ${r.name}. Reward dasar hari ini $0; seluruh biaya di bawah adalah uang yang bisa hilang.</p>
      <div class="chiprow">
        <span class="chip">chain <b>${plan.chain}</b></span>
        <span class="chip">pokok <b>$${plan.capital}</b></span>
        <span class="chip">gas <b>${plan.gas}</b></span>
        <span class="chip">observasi <b>${plan.hold} hari</b></span>
      </div>
      <ol class="steps">${plan.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ the methodology page

function methodPage() {
  const c = radar.calibration;
  const f = radar.farm;
  return `<div class="method-page">
    <div class="box">
      <p class="eyebrow">METODOLOGI · ${radar.version}</p>
      <h2>Dari snapshot ke dua kohort</h2>
      <p>Snapshot memuat ${radar.universe} protokol dengan sepuluh field. Sebuah protokol dihitung <b>sudah bertoken</b> ketika <code>gecko_id</code> atau <code>symbol</code> terisi; itu memberi ${B.length} protokol. Sisanya ${A.length} baris kohort A: ${S.watchlist.length} slug watchlist ditambah protokol tanpa token yang lolos aturan produk (bukan bridge, liquid staking, restaked BTC, CEX, versi berv2, atau produk wrapped/staked milik protokol lain). Dua kohort tidak pernah digabung: peringkat A dan peringkat B berdiri sendiri.</p>
      <h3>Pembanding dan empirical Bayes</h3>
      <p>Pool pembanding: ${radar.comp_count} protokol bertoken dengan <code>mcap_usd &gt; 0</code> dan <code>tvl_usd &gt; 0</code>. Untuk tiap kandidat, median log <code>mcap/TVL</code> dihitung berlapis: pool global, pitanya sendiri (${'<25M · 25-100M · 100-500M · 500M-2B · >=2B'}), kategorinya, lalu kategori di dalam pita. Setiap lapis menarik estimasi dengan bobot <code>n/(n+k)</code>, k = ${radar.k}, jadi satu pembanding hanya menggeser 20%.</p>
      <p>Pita TVL dipakai justru karena kategori tipis: <b>n</b> kategori untuk kohort A bermedian ${radar.n_cat.median} (kuartil bawah ${radar.n_cat.p25}), tetapi pembanding yang benar-benar dipakai (<code>n_eff</code> = gabungan kategori dan pita) minimum ${radar.n_eff.min} dan bermedian ${radar.n_eff.median}. Tidak ada baris yang bersandar pada satu pembanding, dan tiap baris mencetak n serta intervalnya.</p>
      <h3>Nilai, dan plafon yang bisa dibaca</h3>
      <p>Nilai = TVL × multiple gabungan × growth × usia tanpa token × jumlah chain. Growth meneruskan 35% perubahan TVL 7 hari setelah dijepit ±40%; usia tanpa token naik dari 0,70 ke 1,00 dalam tiga tahun; jumlah chain memberi premi maksimum 9%.</p>
      <p>Plafon multiple dihitung dari snapshot: kuantil ${Math.round(radar.ceiling_quantile * 100)} dari ${radar.comp_count} rasio pembanding = <b>${radar.ceiling.toFixed(2)}×</b>. Jadi tidak ada kandidat yang dinilai lebih mahal per dolar TVL daripada 90% protokol yang tokennya sudah benar-benar diperdagangkan. Plafon 0,30× versi lama dibuang karena tidak berasal dari data: rasio pool ini bermedian ${radar.pool_ratio.median.toFixed(2)}× dan berkuartil atas ${radar.pool_ratio.p75.toFixed(2)}×, sehingga 0,30× justru lebih rendah daripada hampir separuh token yang sudah trading, dan ${radar.ratio_over_030} dari ${A.length} baris akan tertahan di satu angka yang sama. Dengan plafon baru hanya ${radar.capped_rows} baris yang menyentuhnya.</p>
      <div class="statgrid">
        <div class="stat"><b>${radar.ratio.min.toFixed(3)}×</b><small>nilai/TVL minimum</small></div>
        <div class="stat"><b>${radar.ratio.median.toFixed(3)}×</b><small>median nilai/TVL</small></div>
        <div class="stat"><b>${radar.ratio.p75.toFixed(3)}×</b><small>kuartil atas</small></div>
        <div class="stat"><b>${radar.ratio.max.toFixed(3)}×</b><small>maksimum (plafon ${radar.ceiling.toFixed(2)}×)</small></div>
      </div>
    </div>
    <div class="box">
      <p class="eyebrow">UJI MODEL DI KOHORT B</p>
      <h2>Model diuji pada token yang sudah punya harga</h2>
      <p>Model yang sama dijalankan pada ${B.length} protokol bertoken. Untuk ${c.n} di antaranya market cap tersedia, sehingga kesalahannya bisa diukur: median |log(nilai model / market cap aktual)| = <b>${c.median_abs_log_error}</b> (≈ ${Math.exp(c.median_abs_log_error).toFixed(1)}×). Baseline "semua token dihargai di median pool" menghasilkan ${c.baseline_median_abs_log_error}; model menurunkan galat ${(c.skill * 100).toFixed(1)}%.</p>
      <p>Hanya ${c.within_2x} dari ${c.n} token live yang jatuh dalam 2× nilai aktualnya. Itu alasan halaman ini menulis rentang di setiap baris: sebaran mcap/TVL nyata terlalu lebar untuk satu angka tunggal, dan kohort B adalah bukti terbukanya, bukan hiasan.</p>
      <h3>Rencana farm</h3>
      <p>Setiap baris punya ${f.steps_per_row} langkah yang dibangun dari angka barisnya sendiri: chain utama, gas chain itu, pokok dari tangga modal TVL, dan jadwal tinjauan dari usia protokol. Panjang langkah minimum ${f.min} karakter, median ${f.median}, maksimum ${f.max}; tidak ada yang di bawah 120 karakter, dan setiap langkah memuat biaya dolar serta durasi menit.</p>
      <h3>Batas klaim</h3>
      <ul>
        <li>Tidak ada angka reward di halaman ini karena snapshot tidak memuat kampanye, poin, atau jadwal token. Reward yang belum diumumkan bernilai $0.</li>
        <li>Interval berasal dari kuartil pembanding, bukan distribusi peluncuran atau probabilitas airdrop.</li>
        <li>Model deterministik: input sama, keluaran sama; tidak ada panggilan jaringan dan tidak ada daftar nama yang di-hardcode.</li>
      </ul>
      <div class="notice">${radar.rows.length} baris total · ${A.length} kohort A · ${B.length} kohort B · ${S.watchlist.length}/${S.watchlist.length} watchlist tercakup · ${radar.comp_count} pembanding · k = ${radar.k} · plafon ${radar.ceiling.toFixed(2)}×.</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ wiring

function render() {
  const rowsA = sortRows(A.filter(passes));
  const rowsB = sortRows(B.filter(passes));
  const app = $('app');
  if (detail) {
    const r = bySlug.get(detail);
    app.innerHTML = r ? detailView(r) : '<p class="muted">Protokol tidak ditemukan.</p>';
  } else if (tab === 'board') {
    app.innerHTML = `<div class="layout"><div class="board-col">${cohortPanel('A', rowsA)}${cohortPanel('B', rowsB)}</div>${aside(bySlug.get(selected))}</div>`;
  } else if (tab === 'trading') {
    app.innerHTML = `<div class="layout"><div class="board-col">${cohortPanel('B', rowsB)}</div>${aside(bySlug.get(selected))}</div>`;
  } else {
    app.innerHTML = methodPage();
  }
  $('shown').textContent = `${rowsA.length} A · ${rowsB.length} B ditampilkan · ${radar.comp_count} pembanding`;
  document.querySelectorAll('[data-detail]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      selected = e.currentTarget.dataset.detail;
      detail = selected;
      render();
    };
  });
  document.querySelectorAll('[data-slug]').forEach((el) => {
    el.onclick = () => {
      selected = el.dataset.slug;
      detail = null;
      render();
    };
  });
  document.querySelectorAll('[data-sort]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      sort = e.currentTarget.dataset.sort;
      render();
    };
  });
  const back = document.querySelector('[data-back]');
  if (back) back.onclick = () => { detail = null; render(); };
}

$('asof').textContent = `SEALED ${S.as_of}`;
$('count').textContent = radar.rows.length;
$('chip-a').textContent = A.length;
$('chip-b').textContent = B.length;
$('watch').textContent = `${S.watchlist.length}/${S.watchlist.length}`;
$('protocols').textContent = radar.universe;
$('source').textContent = S.source.replace(/^.*?fetched /, 'fetched ');
[...new Set(radar.rows.map((r) => r.category).filter(Boolean))].sort().forEach((c) => $('category').insertAdjacentHTML('beforeend', `<option>${c}</option>`));

// Reflect the hash-addressed state in the controls, so a screenshot of a filtered board shows the filter.
$('category').value = category;
$('confidence').value = confidence;
$('watchOnly').checked = watchOnly;
$('search').value = query;
document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
$('controls').style.display = tab === 'method' ? 'none' : 'flex';

$('search').oninput = (e) => { query = e.target.value.trim().toLowerCase(); detail = null; render(); };
$('category').onchange = (e) => { category = e.target.value; detail = null; render(); };
$('confidence').onchange = (e) => { confidence = e.target.value; detail = null; render(); };
$('watchOnly').onchange = (e) => { watchOnly = e.target.checked; detail = null; render(); };
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    detail = null;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('controls').style.display = tab === 'method' ? 'none' : 'flex';
    render();
  };
});
render();