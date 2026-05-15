#!/usr/bin/env node
// Render a scrollable HTML report of all candidates from a digest JSON file.
// Usage: node render-html.js [path/to/digest.json] [--out path]
//        defaults to the most recent file in output/

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(ROOT, 'output');

const argv = process.argv.slice(2);
let inputFile;
let explicitOut;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') { explicitOut = argv[++i]; }
  else if (!inputFile) { inputFile = argv[i]; }
}

if (!inputFile) {
  const files = (await readdir(OUTPUT_DIR))
    .filter((f) => f.startsWith('ai-digest-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) {
    console.error('No ai-digest-*.json files in output/');
    process.exit(1);
  }
  inputFile = join(OUTPUT_DIR, files[0]);
}

const data = JSON.parse(await readFile(inputFile, 'utf8'));
const all = [...data.all, ...data.skipped].sort((a, b) => b.score.score - a.score.score);
const date = inputFile.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || 'unknown';

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmtDuration = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtViews = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const cardHTML = (c) => {
  const verdict = c.score.verdict;
  const verdictColor = { pick: '#10b981', bench: '#f59e0b', skip: '#94a3b8' }[verdict] || '#94a3b8';
  const description = (c.description || '').slice(0, 280);
  const publishedTs = new Date(c.publishedAt).getTime();
  // Embed minimal card data (base64-encoded JSON) so the Saved list can re-render
  // this card even after the video ages out of the candidate window. Base64 avoids
  // any HTML attribute escaping issues with quotes or special chars in titles.
  const cardData = {
    videoId: c.videoId,
    title: c.title,
    channelTitle: c.channelTitle,
    durationSeconds: c.durationSeconds,
    views: c.views,
    publishedAt: c.publishedAt,
    verdict,
    score: c.score.score,
    why: c.score.why || '',
    fromTrusted: !!c.fromTrusted,
  };
  const cardDataB64 = Buffer.from(JSON.stringify(cardData)).toString('base64');
  return `
<article class="card" data-verdict="${verdict}" data-trusted="${c.fromTrusted ? '1' : '0'}" data-score="${c.score.score}" data-views="${c.views}" data-date="${publishedTs}" data-channel="${escape(c.channelTitle)}" data-duration="${c.durationSeconds}" data-video-id="${c.videoId}" data-card="${cardDataB64}">
  <a class="thumb-link" href="https://youtube.com/watch?v=${c.videoId}" target="_blank" rel="noopener">
    <img class="thumb" src="https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg" loading="lazy" alt="">
    <div class="duration-overlay">${fmtDuration(c.durationSeconds)}</div>
  </a>
  <div class="card-body">
    <div class="badges">
      <span class="badge verdict" style="background:${verdictColor}">${verdict.toUpperCase()} ${c.score.score}</span>
      ${c.fromTrusted ? '<span class="badge trusted">SUBSCRIBED</span>' : ''}
    </div>
    <h3 class="title"><a href="https://youtube.com/watch?v=${c.videoId}" target="_blank" rel="noopener">${escape(c.title)}</a></h3>
    <div class="meta">
      <span class="channel">${escape(c.channelTitle)}</span> ·
      <span>${fmtViews(c.views)} views</span> ·
      <span>${c.publishedAt.slice(0, 10)}</span>
    </div>
    <div class="why">${escape(c.score.why || '')}</div>
    <details class="desc"><summary>description</summary><div class="desc-body">${escape(description)}${(c.description || '').length > 280 ? '…' : ''}</div></details>
    <div class="actions">
      <button class="action save-btn" data-action="save">★ Save</button>
      <button class="action hide-btn" data-action="hide">✕ Hide</button>
    </div>
  </div>
</article>`;
};

const counts = {
  pick: all.filter((c) => c.score.verdict === 'pick').length,
  bench: all.filter((c) => c.score.verdict === 'bench').length,
  skip: all.filter((c) => c.score.verdict === 'skip').length,
  trusted: all.filter((c) => c.fromTrusted).length,
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI digest — ${date}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AI digest">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiMwZjE3MmEiLz48cG9seWdvbiBwb2ludHM9IjIyLDE2IDIyLDQ4IDUwLDMyIiBmaWxsPSIjZjU5ZTBiIi8+PC9zdmc+">
<link rel="apple-touch-icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxODAgMTgwIj48cmVjdCB3aWR0aD0iMTgwIiBoZWlnaHQ9IjE4MCIgcng9IjQwIiBmaWxsPSIjMGYxNzJhIi8+PHBvbHlnb24gcG9pbnRzPSI2MCw0OCA2MCwxMzIgMTMyLDkwIiBmaWxsPSIjZjU5ZTBiIi8+PC9zdmc+">
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #0f172a; color: #e2e8f0;
    padding: 16px env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    padding-top: max(16px, env(safe-area-inset-top));
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .summary { color: #94a3b8; font-size: 13px; margin-bottom: 12px; }
  .toolbar {
    position: sticky; top: 0; background: rgba(15,23,42,0.95); backdrop-filter: blur(8px);
    padding: 10px 0; margin: 0 -16px 12px; padding-left: 16px; padding-right: 16px;
    border-bottom: 1px solid #1e293b; z-index: 10;
  }
  .toolbar-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .toolbar-row + .toolbar-row { margin-top: 8px; }
  .toolbar-label { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }
  .btn {
    background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
    padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
    min-height: 36px; touch-action: manipulation;
  }
  .btn.active { background: #3b82f6; border-color: #3b82f6; color: white; }
  .btn:active { transform: scale(0.97); }
  .btn.small { padding: 4px 10px; min-height: 28px; font-size: 12px; }
  .controls-line { margin-top: 8px; color: #94a3b8; font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  @media (max-width: 600px) {
    .grid { grid-template-columns: 1fr; gap: 12px; }
    body { padding-left: 12px; padding-right: 12px; }
    .toolbar { margin-left: -12px; margin-right: -12px; padding-left: 12px; padding-right: 12px; }
    h1 { font-size: 18px; }
  }
  .card { background: #1e293b; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; border: 1px solid #334155; transition: border-color 0.15s, opacity 0.15s; }
  .card[data-verdict="pick"] { border-color: #10b981; }
  .card[data-verdict="skip"] { opacity: 0.65; }
  .card.is-saved { border-color: #f59e0b; box-shadow: 0 0 0 1px #f59e0b; }
  .card.is-hidden-state { opacity: 0.5; border-color: #64748b; }
  .card a { color: inherit; text-decoration: none; }
  .thumb-link { position: relative; display: block; }
  .thumb { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; background: #0f172a; }
  .duration-overlay { position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.85); color: white; padding: 2px 7px; border-radius: 3px; font-size: 12px; font-weight: 500; }
  .card-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: white; letter-spacing: 0.4px; }
  .badge.trusted { background: #6366f1; }
  .badge.saved { background: #f59e0b; }
  .title { margin: 0; font-size: 15px; line-height: 1.35; font-weight: 600; }
  .title a:active { color: #93c5fd; }
  .meta { font-size: 12px; color: #94a3b8; line-height: 1.4; }
  .meta .channel { color: #cbd5e1; font-weight: 500; }
  .why { font-size: 13px; color: #cbd5e1; font-style: italic; padding: 8px 10px; background: #0f172a; border-radius: 6px; border-left: 3px solid #475569; line-height: 1.4; }
  .desc summary { cursor: pointer; color: #64748b; font-size: 12px; padding: 4px 0; }
  .desc-body { font-size: 12px; color: #94a3b8; margin-top: 6px; white-space: pre-wrap; line-height: 1.4; }
  .actions { margin-top: auto; padding-top: 10px; border-top: 1px solid #334155; display: flex; gap: 8px; flex-wrap: wrap; }
  .action {
    flex: 1; min-width: 80px; background: #0f172a; color: #cbd5e1; border: 1px solid #334155;
    padding: 8px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; min-height: 38px;
    touch-action: manipulation; font-weight: 500;
  }
  .action:active { transform: scale(0.97); }
  .action.save-btn.active { background: #f59e0b; border-color: #f59e0b; color: white; }
  .action.hide-btn.active { background: #64748b; border-color: #64748b; color: white; }
  .action.watched-btn { background: #0f172a; }
  .action.unsave-btn { background: #0f172a; }
  .empty-state { text-align: center; padding: 60px 20px; color: #64748b; font-size: 14px; grid-column: 1 / -1; }
</style>
</head>
<body>
<h1>AI YouTube digest — ${date}</h1>
<div class="summary">${all.length} candidates · LLM picked ${counts.pick} · bench ${counts.bench} · skipped ${counts.skip} · ${counts.trusted} from your subscribed channels</div>

<div class="toolbar">
  <div class="toolbar-row">
    <span class="toolbar-label">Filter</span>
    <button class="btn filter-btn active" data-filter="all">All</button>
    <button class="btn filter-btn" data-filter="pick">Picks</button>
    <button class="btn filter-btn" data-filter="bench">Bench</button>
    <button class="btn filter-btn" data-filter="skip">Skip</button>
    <button class="btn filter-btn" data-filter="trusted">Subscribed</button>
    <button class="btn filter-btn" data-filter="saved">★ Saved (<span id="saved-count">0</span>)</button>
  </div>
  <div class="toolbar-row">
    <span class="toolbar-label">Sort</span>
    <button class="btn sort-btn active" data-sort="score">Score</button>
    <button class="btn sort-btn" data-sort="views">Views</button>
    <button class="btn sort-btn" data-sort="date">Date</button>
    <button class="btn sort-btn" data-sort="duration">Duration</button>
    <button class="btn sort-btn" data-sort="channel">Channel</button>
  </div>
  <div class="controls-line">
    <label><input type="checkbox" id="show-hidden"> Show hidden (<span id="hidden-count">0</span>)</label>
    <button class="btn small" id="export-saved">Export saved</button>
    <button class="btn small" id="clear-hidden">Clear hidden</button>
  </div>
</div>

<div class="grid" id="grid">
${all.map(cardHTML).join('\n')}
</div>

<script>
const STATE_KEY = 'ai-digest-state-v2';

const loadState = () => {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { saved: {}, hidden: {} };
    const parsed = JSON.parse(raw);
    return { saved: parsed.saved || {}, hidden: parsed.hidden || {} };
  } catch { return { saved: {}, hidden: {} }; }
};
const saveState = (state) => localStorage.setItem(STATE_KEY, JSON.stringify(state));

const state = loadState();
const grid = document.getElementById('grid');

// Map of videoId -> DOM card (for today's candidates)
const cardsById = new Map();
document.querySelectorAll('.card').forEach((card) => {
  cardsById.set(card.dataset.videoId, card);
});

let currentFilter = 'all';
let currentSort = 'score';
let showHidden = false;

const fmtDuration = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return h + 'h' + String(m).padStart(2, '0') + 'm';
  return m + ':' + String(sec).padStart(2, '0');
};
const fmtViews = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
};

// Build a ghost card (for saved items that aren't in today's candidates).
const ghostCardHTML = (cardData) => {
  const verdictColor = { pick: '#10b981', bench: '#f59e0b', skip: '#94a3b8' }[cardData.verdict] || '#94a3b8';
  return \`
<article class="card ghost is-saved" data-verdict="\${cardData.verdict}" data-trusted="\${cardData.fromTrusted ? '1' : '0'}" data-score="\${cardData.score}" data-views="\${cardData.views}" data-date="\${new Date(cardData.publishedAt).getTime()}" data-channel="\${cardData.channelTitle.replace(/"/g, '&quot;')}" data-duration="\${cardData.durationSeconds}" data-video-id="\${cardData.videoId}" data-ghost="1">
  <a class="thumb-link" href="https://youtube.com/watch?v=\${cardData.videoId}" target="_blank" rel="noopener">
    <img class="thumb" src="https://i.ytimg.com/vi/\${cardData.videoId}/mqdefault.jpg" loading="lazy" alt="">
    <div class="duration-overlay">\${fmtDuration(cardData.durationSeconds)}</div>
  </a>
  <div class="card-body">
    <div class="badges">
      <span class="badge verdict" style="background:\${verdictColor}">\${cardData.verdict.toUpperCase()} \${cardData.score}</span>
      <span class="badge saved">SAVED</span>
      \${cardData.fromTrusted ? '<span class="badge trusted">SUBSCRIBED</span>' : ''}
    </div>
    <h3 class="title"><a href="https://youtube.com/watch?v=\${cardData.videoId}" target="_blank" rel="noopener">\${cardData.title.replace(/</g, '&lt;')}</a></h3>
    <div class="meta">
      <span class="channel">\${cardData.channelTitle.replace(/</g, '&lt;')}</span> ·
      <span>\${fmtViews(cardData.views)} views</span> ·
      <span>\${cardData.publishedAt.slice(0, 10)}</span>
    </div>
    <div class="why">\${(cardData.why || '').replace(/</g, '&lt;')}</div>
    <div class="actions">
      <button class="action watched-btn" data-action="watched">✓ Watched</button>
      <button class="action unsave-btn" data-action="unsave">Unsave</button>
    </div>
  </div>
</article>\`;
};

function applyStateToCard(card) {
  const id = card.dataset.videoId;
  card.classList.remove('is-saved', 'is-hidden-state');
  if (state.saved[id]) card.classList.add('is-saved');
  if (state.hidden[id]) card.classList.add('is-hidden-state');
  // Update button states
  const saveBtn = card.querySelector('.save-btn');
  const hideBtn = card.querySelector('.hide-btn');
  if (saveBtn) saveBtn.classList.toggle('active', !!state.saved[id]);
  if (hideBtn) hideBtn.classList.toggle('active', !!state.hidden[id]);
}

function updateCounts() {
  document.getElementById('saved-count').textContent = Object.keys(state.saved).length;
  document.getElementById('hidden-count').textContent = Object.keys(state.hidden).length;
}

function applyFilter() {
  // Wipe any ghost cards from previous Saved view
  document.querySelectorAll('.card.ghost').forEach((c) => c.remove());

  if (currentFilter === 'saved') {
    // Saved view: hide today's non-saved cards, show all saved (incl. ghosts)
    document.querySelectorAll('.card:not(.ghost)').forEach((card) => {
      card.style.display = state.saved[card.dataset.videoId] ? '' : 'none';
    });
    // Inject ghosts for saved items not in today's candidates
    for (const [id, cardData] of Object.entries(state.saved)) {
      if (!cardsById.has(id)) {
        const div = document.createElement('div');
        div.innerHTML = ghostCardHTML(cardData);
        const ghost = div.firstElementChild;
        grid.appendChild(ghost);
        attachActionHandlers(ghost);
      }
    }
    showEmptyIfNeeded();
    return;
  }

  // Default-flavor filters
  document.querySelectorAll('.card').forEach((card) => {
    const id = card.dataset.videoId;
    const isSaved = !!state.saved[id];
    const isHidden = !!state.hidden[id];
    // Hide saved (they live in Saved view) and hidden (unless toggle on)
    if (isSaved) { card.style.display = 'none'; return; }
    if (isHidden && !showHidden) { card.style.display = 'none'; return; }

    let show = false;
    if (currentFilter === 'all') show = true;
    else if (currentFilter === 'trusted') show = card.dataset.trusted === '1';
    else show = card.dataset.verdict === currentFilter;
    card.style.display = show ? '' : 'none';
  });
  showEmptyIfNeeded();
}

function showEmptyIfNeeded() {
  const empty = document.getElementById('empty-msg');
  if (empty) empty.remove();
  const visible = Array.from(document.querySelectorAll('.card')).some((c) => c.style.display !== 'none');
  if (!visible) {
    const div = document.createElement('div');
    div.id = 'empty-msg';
    div.className = 'empty-state';
    div.textContent = currentFilter === 'saved'
      ? 'No saved videos yet. Tap ★ Save on any card to add to this list.'
      : 'No cards match the current filter.';
    grid.appendChild(div);
  }
}

function attachActionHandlers(card) {
  card.querySelectorAll('.action').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = card.dataset.videoId;
      const isGhost = card.dataset.ghost === '1';

      if (action === 'save') {
        if (state.saved[id]) {
          delete state.saved[id];
        } else {
          // Decode embedded base64 JSON and store
          try {
            state.saved[id] = JSON.parse(atob(card.dataset.card));
            state.saved[id].addedAt = new Date().toISOString();
          } catch { return; }
          delete state.hidden[id]; // un-hide if it was hidden
        }
        saveState(state);
        applyStateToCard(card);
        updateCounts();
        applyFilter();
      } else if (action === 'hide') {
        if (state.hidden[id]) {
          delete state.hidden[id];
        } else {
          state.hidden[id] = 1;
          delete state.saved[id]; // un-save if it was saved
        }
        saveState(state);
        applyStateToCard(card);
        updateCounts();
        applyFilter();
      } else if (action === 'watched') {
        // Move from saved to hidden
        delete state.saved[id];
        state.hidden[id] = 1;
        saveState(state);
        updateCounts();
        if (isGhost) card.remove();
        else { applyStateToCard(card); applyFilter(); }
        applyFilter();
      } else if (action === 'unsave') {
        delete state.saved[id];
        saveState(state);
        updateCounts();
        if (isGhost) card.remove();
        else { applyStateToCard(card); applyFilter(); }
        applyFilter();
      }
    });
  });
}

// Init: attach handlers and apply state
cardsById.forEach((card) => {
  attachActionHandlers(card);
  applyStateToCard(card);
});
updateCounts();
applyFilter();

// Filter buttons
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    applyFilter();
  });
});

// Sort buttons
const sorters = {
  score:    (a, b) => Number(b.dataset.score) - Number(a.dataset.score),
  views:    (a, b) => Number(b.dataset.views) - Number(a.dataset.views),
  date:     (a, b) => Number(b.dataset.date) - Number(a.dataset.date),
  duration: (a, b) => Number(a.dataset.duration) - Number(b.dataset.duration),
  channel:  (a, b) => (a.dataset.channel || '').localeCompare(b.dataset.channel || ''),
};
document.querySelectorAll('.sort-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    const sorter = sorters[currentSort];
    if (!sorter) return;
    const cards = Array.from(grid.querySelectorAll('.card'));
    cards.sort(sorter).forEach((c) => grid.appendChild(c));
  });
});

// Show hidden toggle
document.getElementById('show-hidden').addEventListener('change', (e) => {
  showHidden = e.target.checked;
  applyFilter();
});

// Export saved
document.getElementById('export-saved').addEventListener('click', async () => {
  const items = Object.entries(state.saved)
    .sort(([, a], [, b]) => (b.addedAt || '').localeCompare(a.addedAt || ''))
    .map(([id, c]) => \`- \${c.channelTitle}: \${c.title} (https://youtube.com/watch?v=\${id})\`);
  const text = items.length ? items.join('\\n') : 'No saved videos yet.';
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('export-saved').textContent = 'Copied!';
  } catch {
    prompt('Copy this text:', text);
  }
  setTimeout(() => { document.getElementById('export-saved').textContent = 'Export saved'; }, 1500);
});

// Clear hidden (for un-doing accidental dismisses)
document.getElementById('clear-hidden').addEventListener('click', () => {
  const count = Object.keys(state.hidden).length;
  if (!count) return;
  if (!confirm(\`Clear all \${count} hidden videos? They'll reappear in the main list.\`)) return;
  state.hidden = {};
  saveState(state);
  updateCounts();
  document.querySelectorAll('.card').forEach(applyStateToCard);
  applyFilter();
});
</script>
</body>
</html>
`;

const outFile = explicitOut || inputFile.replace(/\.json$/, '.html');
await writeFile(outFile, html);
console.log(`Wrote ${outFile}`);

// Also publish to docs/ for GitHub Pages: index.html is today's digest;
// archive/ keeps a dated copy for history.
if (!explicitOut) {
  const { mkdir } = await import('node:fs/promises');
  const DOCS = join(ROOT, 'docs');
  const ARCHIVE = join(DOCS, 'archive');
  await mkdir(ARCHIVE, { recursive: true });
  await writeFile(join(DOCS, 'index.html'), html);
  await writeFile(join(ARCHIVE, `${date}.html`), html);
  console.log(`Published to docs/index.html and docs/archive/${date}.html`);
}
