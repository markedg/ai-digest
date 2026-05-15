#!/usr/bin/env node
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Missing YOUTUBE_API_KEY in .env (copy .env.example to .env and fill it in)');
  process.exit(1);
}

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const VIEW_THRESHOLD = Number(process.env.VIEW_THRESHOLD || 5000);
const MIN_DURATION_SECONDS = Number(process.env.MIN_DURATION_SECONDS || 180);
const OUTPUT_DIR = process.env.DIGEST_OUTPUT_DIR || join(ROOT, 'output');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const MAX_UPLOADS_PER_CHANNEL = 30;
const MAX_PER_QUERY = 25;

const args = new Set(process.argv.slice(2));
const FETCH_ONLY = args.has('--fetch-only');
const RESOLVE_ONLY = args.has('--resolve-channels');

// ----- YouTube API helpers -----

const BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${endpoint} ${res.status}: ${body}`);
  }
  return res.json();
}

async function resolveHandle(handle) {
  const clean = handle.startsWith('@') ? handle.slice(1) : handle;
  const data = await ytGet('channels', {
    forHandle: `@${clean}`,
    part: 'id,snippet,contentDetails',
  });
  const item = data.items?.[0];
  if (!item) throw new Error(`No channel found for handle ${handle}`);
  return {
    id: item.id,
    title: item.snippet.title,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

async function recentUploads(uploadsPlaylistId, limit = MAX_UPLOADS_PER_CHANNEL) {
  const data = await ytGet('playlistItems', {
    playlistId: uploadsPlaylistId,
    part: 'snippet,contentDetails',
    maxResults: String(Math.min(50, limit)),
  });
  return (data.items || []).map((item) => ({
    videoId: item.contentDetails.videoId,
    publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    source: 'channel',
  }));
}

async function searchByQuery(query, publishedAfter) {
  const data = await ytGet('search', {
    q: query,
    part: 'snippet',
    type: 'video',
    order: 'viewCount',
    publishedAfter,
    maxResults: String(MAX_PER_QUERY),
    relevanceLanguage: 'en',
  });
  return (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    publishedAt: item.snippet.publishedAt,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    source: `query:${query}`,
  }));
}

async function videosDetails(videoIds) {
  const out = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await ytGet('videos', {
      id: chunk.join(','),
      part: 'snippet,statistics,contentDetails,liveStreamingDetails',
    });
    for (const v of data.items || []) {
      out[v.id] = {
        videoId: v.id,
        title: v.snippet.title,
        description: v.snippet.description || '',
        channelId: v.snippet.channelId,
        channelTitle: v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        durationSeconds: parseIsoDuration(v.contentDetails.duration),
        views: Number(v.statistics.viewCount || 0),
        likes: Number(v.statistics.likeCount || 0),
        liveBroadcastContent: v.snippet.liveBroadcastContent,
        isLive: !!v.liveStreamingDetails && v.snippet.liveBroadcastContent === 'live',
      };
    }
  }
  return out;
}

function parseIsoDuration(iso) {
  // PT#H#M#S
  const m = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  const [, h, mm, ss] = m;
  return (Number(h || 0) * 3600) + (Number(mm || 0) * 60) + Number(ss || 0);
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtViews(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ----- Channel resolution + cache -----

async function loadChannels() {
  const file = join(ROOT, 'channels.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  let updated = false;
  for (const ch of data.channels) {
    if (!ch.id) {
      console.log(`Resolving ${ch.handle}...`);
      try {
        const info = await resolveHandle(ch.handle);
        ch.id = info.id;
        ch.title = info.title;
        ch.uploadsPlaylistId = info.uploadsPlaylistId;
        updated = true;
      } catch (e) {
        console.warn(`  ! failed: ${e.message}`);
      }
    }
  }
  if (updated) {
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
    console.log(`Updated ${file}`);
  }
  return data.channels.filter((c) => c.uploadsPlaylistId);
}

// ----- Fetch pipeline -----

async function fetchCandidates() {
  const channels = await loadChannels();
  if (RESOLVE_ONLY) {
    console.log('Channel resolution complete.');
    process.exit(0);
  }

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const publishedAfter = cutoff.toISOString();

  const seen = new Map(); // videoId -> seed object (first source wins)

  console.log(`Fetching last ${WINDOW_DAYS} days from ${channels.length} channels...`);
  for (const ch of channels) {
    try {
      const items = await recentUploads(ch.uploadsPlaylistId);
      for (const it of items) {
        if (new Date(it.publishedAt) < cutoff) continue;
        if (!seen.has(it.videoId)) seen.set(it.videoId, it);
      }
    } catch (e) {
      console.warn(`  ! ${ch.handle}: ${e.message}`);
    }
  }
  console.log(`  ${seen.size} candidates after channel pull`);

  const queries = JSON.parse(await readFile(join(ROOT, 'search-queries.json'), 'utf8')).queries;
  console.log(`Searching ${queries.length} keywords...`);
  for (const q of queries) {
    try {
      const items = await searchByQuery(q, publishedAfter);
      for (const it of items) {
        if (!seen.has(it.videoId)) seen.set(it.videoId, it);
      }
    } catch (e) {
      console.warn(`  ! "${q}": ${e.message}`);
    }
  }
  console.log(`  ${seen.size} candidates after keyword search`);

  console.log(`Hydrating video details...`);
  const details = await videosDetails([...seen.keys()]);

  const trustedChannelIds = new Set(channels.map((c) => c.id));
  const candidates = [];
  for (const [vid, seed] of seen) {
    const d = details[vid];
    if (!d) continue;
    if (d.isLive) continue;
    if (d.liveBroadcastContent === 'upcoming') continue;
    if (d.durationSeconds < MIN_DURATION_SECONDS) continue;
    // Keyword-search videos must clear the view threshold;
    // trusted-channel uploads bypass it (we trust the source).
    const fromTrusted = trustedChannelIds.has(d.channelId);
    if (!fromTrusted && d.views < VIEW_THRESHOLD) continue;
    candidates.push({ ...d, sourceTag: seed.source, fromTrusted });
  }
  console.log(`  ${candidates.length} candidates after filtering`);

  return candidates;
}

// ----- LLM filter via `claude -p` -----

const SCORING_SYSTEM_PROMPT = `You are a strict, discerning AI video relevance scorer.
You evaluate YouTube video metadata against a user's written interest spec and produce structured JSON scores.
Apply the spec literally. Penalize low signal density even for popular videos.
Output only the JSON specified by the schema — no preamble, no commentary outside fields.`;

const SCORING_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          videoId: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          verdict: { type: 'string', enum: ['pick', 'bench', 'skip'] },
          why: { type: 'string', maxLength: 200 },
        },
        required: ['videoId', 'score', 'verdict', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 40);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);

async function scoreWithClaude(candidates, spec) {
  if (candidates.length === 0) return [];

  // Shuffle so each batch has a representative mix of trusted/search candidates;
  // otherwise the LLM's "aim for 5-10% pick" calibration warps batches that happen
  // to be all-good or all-bad. (Original order is restored in the caller via videoId lookup.)
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);

  // Batch to stay well under Claude's 32k default output token limit:
  // ~200 tokens/score × 40 candidates ≈ 8k output per batch.
  const batches = [];
  for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
    batches.push(shuffled.slice(i, i + BATCH_SIZE));
  }
  console.log(`  scoring in ${batches.length} batches of up to ${BATCH_SIZE} (concurrency=${MAX_CONCURRENCY})`);

  const scoreBatch = async (batch, idx) => {
    const candidateBlock = batch.map((c) => {
      const desc = (c.description || '').slice(0, 220).replace(/\s+/g, ' ');
      return [
        `- videoId: ${c.videoId}`,
        `  channel: ${c.channelTitle}${c.fromTrusted ? ' [trusted]' : ''}`,
        `  title: ${c.title}`,
        `  duration: ${fmtDuration(c.durationSeconds)}  views: ${fmtViews(c.views)}  published: ${c.publishedAt.slice(0, 10)}`,
        `  description: ${desc}`,
      ].join('\n');
    }).join('\n\n');

    const userPrompt = `Score each video below against this interest spec.

# Interest spec

${spec}

# Scoring rules

- score 0-100. 90+ = must-watch for the reader. 70-89 = solid. 50-69 = marginal. <50 = skip.
- verdict: "pick" = top tier, surface prominently. "bench" = worth knowing about. "skip" = filter out.
- why: one terse sentence (under 200 chars) on why the score, in voice of "this video [does X / matters because Y]".
- Be strict. Hype, productivity-AI content, generic intro explainers, and clickbait should score low even with high views.
- Substantive technical content from official labs is welcome; pure keynote/marketing is not.
- Practical Claude Code / MCP / agent tooling content IS in scope even in tutorial form — the reader uses these daily.
- Aim for roughly 5-10% "pick", 10-20% "bench", remainder "skip" — be selective.

# Candidates (${batch.length} videos)

${candidateBlock}

Output JSON matching the schema. Score every videoId listed above; do not omit any.`;

    const t0 = Date.now();
    const result = await runClaudePrint(userPrompt, SCORING_SYSTEM_PROMPT, SCORING_SCHEMA);
    console.log(`    batch ${idx + 1}/${batches.length} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(result.scores || []).length} scores)`);
    return result.scores || [];
  };

  // Run with bounded concurrency.
  const results = new Array(batches.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= batches.length) return;
      results[i] = await scoreBatch(batches[i], i);
    }
  });
  await Promise.all(workers);
  return results.flat();
}

function runClaudePrint(prompt, systemPrompt, schema) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        '--tools', '',
        '--model', CLAUDE_MODEL,
        '--system-prompt', systemPrompt,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        // Claude --output-format json wraps everything; schema-validated output
        // lives in `structured_output`. Plain text lives in `result`.
        if (parsed && typeof parsed === 'object') {
          if (parsed.is_error) {
            return reject(new Error(`Claude reported error: ${parsed.api_error_status || 'unknown'}\nFull: ${stdout.slice(0, 500)}`));
          }
          if (parsed.structured_output) return resolve(parsed.structured_output);
          if (typeof parsed.result === 'string' && parsed.result.trim().startsWith('{')) {
            return resolve(JSON.parse(parsed.result));
          }
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Could not parse claude output as JSON: ${e.message}\nFirst 1000 chars:\n${stdout.slice(0, 1000)}`));
      }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ----- Render digest -----

function renderDigest({ picks, bench, skipped, totalConsidered, generatedAt }) {
  const date = generatedAt.toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# AI YouTube digest — ${date}`);
  lines.push('');
  lines.push(`*${totalConsidered} candidates considered. Window: last ${WINDOW_DAYS} days.*`);
  lines.push('');
  lines.push(`## Top picks (${picks.length})`);
  lines.push('');
  for (const v of picks) {
    lines.push(`### ${v.title}`);
    lines.push('');
    lines.push(`**${v.channelTitle}** · ${fmtDuration(v.durationSeconds)} · ${fmtViews(v.views)} views · ${v.publishedAt.slice(0, 10)}`);
    lines.push('');
    lines.push(`${v.score?.why || ''}`);
    lines.push('');
    lines.push(`https://youtube.com/watch?v=${v.videoId}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push(`## Bench (${bench.length})`);
  lines.push('');
  for (const v of bench) {
    lines.push(`- **${v.title}** — *${v.channelTitle}, ${fmtDuration(v.durationSeconds)}, ${fmtViews(v.views)} views*`);
    lines.push(`  ${v.score?.why || ''}`);
    lines.push(`  https://youtube.com/watch?v=${v.videoId}`);
  }
  lines.push('');
  lines.push('---');
  lines.push(`*Skipped: ${skipped} candidates. Generated ${generatedAt.toISOString()}.*`);
  return lines.join('\n');
}

// ----- Main -----

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const candidates = await fetchCandidates();
  const generatedAt = new Date();

  if (FETCH_ONLY) {
    const file = join(OUTPUT_DIR, `candidates-${generatedAt.toISOString().slice(0, 10)}.json`);
    await writeFile(file, JSON.stringify(candidates, null, 2));
    console.log(`Wrote ${candidates.length} candidates to ${file}`);
    return;
  }

  if (candidates.length === 0) {
    console.log('No candidates after filtering — nothing to score.');
    return;
  }

  const spec = await readFile(join(ROOT, 'interest-spec.md'), 'utf8');
  console.log(`Scoring ${candidates.length} candidates with Claude (${CLAUDE_MODEL})...`);
  const scores = await scoreWithClaude(candidates, spec);
  console.log(`  received ${scores.length} scores`);

  const byId = new Map(scores.map((s) => [s.videoId, s]));
  for (const c of candidates) c.score = byId.get(c.videoId) || { score: 0, verdict: 'skip', why: 'no score returned' };

  const ranked = candidates
    .filter((c) => c.score.verdict !== 'skip')
    .sort((a, b) => b.score.score - a.score.score);

  const picks = ranked.slice(0, 5);
  const bench = ranked.slice(5, 10);
  const skipped = candidates.length - picks.length - bench.length;

  const markdown = renderDigest({ picks, bench, skipped, totalConsidered: candidates.length, generatedAt });
  const outFile = join(OUTPUT_DIR, `ai-digest-${generatedAt.toISOString().slice(0, 10)}.md`);
  await writeFile(outFile, markdown);

  // Also save the full ranked data for debugging / inspection
  const dataFile = join(OUTPUT_DIR, `ai-digest-${generatedAt.toISOString().slice(0, 10)}.json`);
  await writeFile(dataFile, JSON.stringify({ picks, bench, all: ranked, skipped: candidates.filter(c => c.score.verdict === 'skip') }, null, 2));

  console.log(`\nDigest written to ${outFile}`);
  console.log(`Full data at      ${dataFile}`);

  // Auto-render the HTML browser as the last step.
  console.log(`Rendering HTML browser...`);
  await new Promise((resolve, reject) => {
    const proc = spawn('node', [join(ROOT, 'render-html.js'), dataFile], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`render-html exited ${code}`)));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
