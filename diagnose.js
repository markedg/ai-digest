#!/usr/bin/env node
// One-shot diagnostic: check a specific video + dump full upload history for @claude
import 'dotenv/config';
import { readFile } from 'node:fs/promises';

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) { console.error('No YOUTUBE_API_KEY'); process.exit(1); }
const BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${await res.text()}`);
  return res.json();
}

// 1. Look up the specific video Mark linked.
const VIDEO_ID = 'RtywqDFBYnQ';
console.log(`=== Video ${VIDEO_ID} ===`);
const v = await ytGet('videos', { id: VIDEO_ID, part: 'snippet,statistics,contentDetails' });
const item = v.items?.[0];
if (item) {
  console.log(`Title:     ${item.snippet.title}`);
  console.log(`Channel:   ${item.snippet.channelTitle} (${item.snippet.channelId})`);
  console.log(`Published: ${item.snippet.publishedAt}`);
  console.log(`Duration:  ${item.contentDetails.duration}`);
  console.log(`Views:     ${item.statistics.viewCount}`);
}

// 2. Pull the @claude uploads playlist with high limit to see everything posted recently.
console.log('\n=== Full @claude upload list (last 7 days) ===');
const channels = JSON.parse(await readFile(new URL('./channels.json', import.meta.url), 'utf8')).channels;
const claudeChannel = channels.find((c) => c.handle === '@claude');
const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);

// Try BOTH the uploads playlist AND a channel-filtered search to compare coverage.
console.log('--- Via playlistItems (uploads playlist) ---');
const fromPlaylist = [];
let pageToken;
for (let page = 0; page < 5; page++) {
  const data = await ytGet('playlistItems', {
    playlistId: claudeChannel.uploadsPlaylistId,
    part: 'contentDetails,snippet',
    maxResults: '50',
    ...(pageToken ? { pageToken } : {}),
  });
  for (const it of data.items) {
    const pub = it.contentDetails.videoPublishedAt || it.snippet.publishedAt;
    if (new Date(pub) >= cutoff) {
      fromPlaylist.push({ videoId: it.contentDetails.videoId, publishedAt: pub, title: it.snippet.title });
    }
  }
  pageToken = data.nextPageToken;
  if (!pageToken) break;
}
console.log(`  ${fromPlaylist.length} videos within last 7 days`);

console.log('\n--- Via search.list channelId filter ---');
const fromSearch = [];
let sToken;
for (let page = 0; page < 4; page++) {
  const data = await ytGet('search', {
    channelId: claudeChannel.id,
    part: 'snippet',
    type: 'video',
    order: 'date',
    publishedAfter: cutoff.toISOString(),
    maxResults: '50',
    ...(sToken ? { pageToken: sToken } : {}),
  });
  for (const it of data.items) {
    fromSearch.push({
      videoId: it.id.videoId,
      publishedAt: it.snippet.publishedAt,
      title: it.snippet.title,
    });
  }
  sToken = data.nextPageToken;
  if (!sToken) break;
}
console.log(`  ${fromSearch.length} videos within last 7 days`);

// Compare the two sets
const playlistIds = new Set(fromPlaylist.map((v) => v.videoId));
const searchIds = new Set(fromSearch.map((v) => v.videoId));
const onlyInSearch = fromSearch.filter((v) => !playlistIds.has(v.videoId));
const onlyInPlaylist = fromPlaylist.filter((v) => !searchIds.has(v.videoId));

console.log(`\n--- Discrepancy ---`);
console.log(`  Only in search.list (missed by uploads playlist): ${onlyInSearch.length}`);
console.log(`  Only in playlist (missed by search): ${onlyInPlaylist.length}`);

if (onlyInSearch.length) {
  console.log('\nVideos that uploads-playlist missed:');
  onlyInSearch.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  for (const v of onlyInSearch) {
    console.log(`  ${v.publishedAt}  ${v.videoId}  ${v.title}`);
  }
}

// Specifically check if the Memory video is in either result set
console.log(`\n--- Specific check: Memory and dreaming video ---`);
console.log(`  In uploads-playlist results? ${playlistIds.has(VIDEO_ID) ? 'YES' : 'NO'}`);
console.log(`  In search.list results?     ${searchIds.has(VIDEO_ID) ? 'YES' : 'NO'}`);
