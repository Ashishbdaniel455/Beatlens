/* ============================================================
   BeatLens — app.js
   Complete frontend: player, playlists, analysis, beat detector
   ============================================================ */
'use strict';

// API defined in auth.js

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const S = {
  songs:        [],       // all songs from server
  playlists:    [],       // all playlists from server
  queue:        [],       // current playback queue (song ids)
  queueIdx:     -1,
  isPlaying:    false,
  isLooping:    false,
  isShuffling:  false,
  loopRegionOn: false,
  loopStart:    0,
  loopEnd:      30,
  favorites:    new Set(JSON.parse(localStorage.getItem('bl_favs')||'[]')),
  currentSong:  null,
  animFrame:    null,
  waveformPeaks: null,
  waveformW:    0,
  waveCtx:      null,
  // Beat detection
  audioCtx:     null,
  analyserNode: null,
  sourceNode:   null,
  beatHistory:  [],
  lastBeatTime: 0,
  liveBpm:      0,
  beatAnimFrame:null,
};

const audio = document.getElementById('audioPlayer');

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  setGreeting();
  setupDragDrop();
  setupKeyboard();
  await loadFromServer();
  updateUI();
});

function setGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  document.getElementById('timeGreeting').textContent = g;
}

// ═══════════════════════════════════════════════════════════════
// SERVER API
// ═══════════════════════════════════════════════════════════════
// api() defined in auth.js (with auth headers)

async function loadFromServer() {
  try {
    const [songs, playlists] = await Promise.all([
      api('GET', '/api/songs'),
      api('GET', '/api/playlists'),
    ]);
    S.songs     = songs;
    S.playlists = playlists;
  } catch(e) {
    toast('Could not connect to server. Is it running?', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════
function navigate(page, btn) {
  document.querySelectorAll('.sb-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('page-' + page)?.classList.add('active');
  if (page === 'library')   renderLibrary();
  if (page === 'playlists') renderPlaylists();
  if (page === 'dashboard') renderDashboard();
  if (page === 'analysis' && S.currentSong) renderAnalysis(S.currentSong);
}

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════
function setupDragDrop() {
  const fInput = document.getElementById('fileInput');
  const sbZone = document.getElementById('sbUploadZone');
  const libZone= document.getElementById('libDropZone');

  fInput.addEventListener('change', e => {
    Array.from(e.target.files).forEach(f => uploadFile(f));
    fInput.value = '';
  });

  [sbZone, libZone].forEach(zone => {
    zone.addEventListener('click', () => fInput.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      Array.from(e.dataTransfer.files)
        .filter(f => f.type.startsWith('audio/'))
        .forEach(f => uploadFile(f));
    });
  });
}

async function uploadFile(file) {
  showUploadOverlay(file.name, 10);
  const form  = new FormData();
  form.append('file', file);

  // Check allowed types client-side first
  const allowed = ['audio/mpeg','audio/wav','audio/flac','audio/ogg','audio/mp4',
                   'audio/aac','audio/opus','audio/x-wav','audio/x-flac'];
  const ext     = file.name.split('.').pop().toLowerCase();
  const okExts  = ['mp3','wav','flac','ogg','m4a','aac','opus','wma'];
  if (!okExts.includes(ext)) {
    toast(`"${ext}" is not a supported audio format`, 'error');
    hideUploadOverlay();
    return;
  }

  try {
    updateUploadOverlay('Uploading…', 30);

    // IMPORTANT: must include auth token for /api/analyze
    const token = localStorage.getItem('bl_token');
    if (!token) {
      window.location.href = 'login.html';
      return;
    }

    const res = await fetch(API + '/api/analyze', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body:    form,
    });

    updateUploadOverlay('Analysing BPM, key & chords…', 65);

    if (res.status === 401) {
      hideUploadOverlay();
      toast('Session expired — please log in again', 'error');
      setTimeout(() => { window.location.href = 'login.html'; }, 1500);
      return;
    }

    if (!res.ok) {
      let errMsg = 'Upload failed';
      try {
        const errData = await res.json();
        errMsg = errData.detail || errMsg;
      } catch { /* ignore */ }
      throw new Error(errMsg);
    }

    const song = await res.json();
    updateUploadOverlay('Saving to library…', 90);
    S.songs.unshift(song);
    updateUI();
    hideUploadOverlay();
    toast(`"${song.name}" added — ${song.bpm} BPM · ${song.key || '?'} ${song.scale || ''}`, 'success');

    // Auto-play if nothing currently playing
    if (!S.isPlaying) playSongById(song.id);

  } catch(e) {
    hideUploadOverlay();
    toast('Upload failed: ' + e.message, 'error');
    console.error('Upload error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// UPDATE ALL UI
// ═══════════════════════════════════════════════════════════════
function updateUI() {
  renderSidebarPlaylists();
  renderDashboard();
  renderLibrary();
  renderPlaylists();
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function renderDashboard() {
  const songs = S.songs;
  // Stats
  document.getElementById('statSongs').textContent = songs.length;
  document.getElementById('statPlaylists').textContent = S.playlists.length;
  const totalSec = songs.reduce((a,s) => a + (s.duration||0), 0);
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60);
  document.getElementById('statDuration').textContent = h ? h+'h '+m+'m' : m+'m';

  // Top key
  const keyCounts = {};
  songs.forEach(s => { if(s.key) keyCounts[s.key+' '+s.scale] = (keyCounts[s.key+' '+s.scale]||0)+1; });
  const topKey = Object.entries(keyCounts).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('statTopKey').textContent = topKey ? topKey[0].split(' ')[0] : '—';

  // Avg BPM
  const bpms = songs.filter(s=>s.bpm).map(s=>s.bpm);
  document.getElementById('statAvgBpm').textContent = bpms.length
    ? Math.round(bpms.reduce((a,b)=>a+b,0)/bpms.length)
    : '—';

  // Recent grid
  const rg = document.getElementById('recentGrid');
  if (!songs.length) { rg.innerHTML = '<div class="dash-empty">Upload some songs to get started!</div>'; }
  else {
    rg.innerHTML = songs.slice(0,8).map(s => `
      <div class="recent-card" onclick="playSongById(${s.id})">
        <div class="rc-play">▶</div>
        <div class="rc-icon">🎵</div>
        <div class="rc-name">${esc(s.name)}</div>
        <div class="rc-meta">${s.bpm||'?'} BPM · ${s.key||'?'} ${s.scale||''}</div>
      </div>`).join('');
  }

  // Key chart
  const kc = document.getElementById('keyChart');
  if (songs.length) {
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const counts = keys.map(k => songs.filter(s=>s.key===k).length);
    const max = Math.max(...counts,1);
    kc.innerHTML = keys.map((k,i) => `
      <div class="kc-bar-wrap" title="${k}: ${counts[i]} songs">
        <div class="kc-bar" style="height:${Math.max(4, counts[i]/max*100)}%"></div>
        <div class="kc-label">${k}</div>
      </div>`).join('');
  } else { kc.innerHTML = '<div class="dash-empty">No data yet</div>'; }

  // BPM histogram
  const bh = document.getElementById('bpmHistogram');
  if (bpms.length) {
    const buckets = Array(8).fill(0);
    bpms.forEach(b => { const i = Math.min(7, Math.floor((b-60)/20)); if(i>=0) buckets[i]++; });
    const bmax = Math.max(...buckets,1);
    bh.innerHTML = buckets.map((c,i) => `
      <div class="bh-bar" style="height:${Math.max(4,c/bmax*100)}%"
        title="${60+i*20}–${80+i*20} BPM: ${c} songs"></div>`).join('');
  } else { bh.innerHTML = '<div class="dash-empty">No data yet</div>'; }
}

// ═══════════════════════════════════════════════════════════════
// LIBRARY
// ═══════════════════════════════════════════════════════════════
let libFilter = '', libSortBy = 'date';

function renderLibrary() {
  const tbody = document.getElementById('songsTableBody');
  let songs = [...S.songs];

  if (libFilter) songs = songs.filter(s => s.name.toLowerCase().includes(libFilter.toLowerCase()) ||
    (s.key||'').toLowerCase().includes(libFilter.toLowerCase()));

  songs.sort((a,b) => {
    if (libSortBy==='name')     return (a.name||'').localeCompare(b.name||'');
    if (libSortBy==='bpm')      return (a.bpm||0)-(b.bpm||0);
    if (libSortBy==='key')      return (a.key||'').localeCompare(b.key||'');
    if (libSortBy==='duration') return (a.duration||0)-(b.duration||0);
    return 0; // date — already newest first
  });

  if (!songs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No songs found</td></tr>`;
    return;
  }

  tbody.innerHTML = songs.map((s, i) => {
    const isPlaying = S.currentSong?.id === s.id;
    return `
      <tr class="${isPlaying?'playing':''}" onclick="playSongById(${s.id})">
        <td class="td-num">${isPlaying ? '<span class="playing-indicator">♫</span>' : i+1}</td>
        <td class="td-name">${esc(s.name)}</td>
        <td class="td-bpm">${s.bpm||'—'}</td>
        <td class="td-key">${s.key||'—'} ${s.scale||''}</td>
        <td class="td-chords">${(s.chords||[]).slice(0,4).join(' ')}</td>
        <td class="td-dur">${fmt(s.duration)}</td>
        <td onclick="event.stopPropagation()">
          <div class="td-actions">
            <button class="tbl-btn" onclick="openAddToPlaylist(${s.id})">+ Playlist</button>
            <button class="tbl-btn" onclick="navigate('analysis',document.querySelector('[data-page=analysis]'));renderAnalysis(S.songs.find(x=>x.id===${s.id}))">Analyse</button>
            <button class="tbl-btn tbl-btn-del" onclick="deleteSong(${s.id})">🗑</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function filterLibrary(q)  { libFilter = q;  renderLibrary(); }
function sortLibrary(by)   { libSortBy = by; renderLibrary(); }

// ═══════════════════════════════════════════════════════════════
// PLAYLISTS PAGE
// ═══════════════════════════════════════════════════════════════
const PL_COLORS = ['#1db954','#ff4b6e','#7c4dff','#ffb300','#00bcd4','#ff6d00'];

function renderPlaylists() {
  const grid = document.getElementById('playlistsGrid');
  renderSidebarPlaylists();
  if (!S.playlists.length) {
    grid.innerHTML = '<div class="pg-empty">Create a playlist to organise your songs</div>';
    return;
  }
  grid.innerHTML = S.playlists.map((pl,i) => {
    const color = PL_COLORS[i % PL_COLORS.length];
    const songNames = (pl.song_ids||[]).slice(0,3)
      .map(id => S.songs.find(s=>s.id===id))
      .filter(Boolean)
      .map(s => `<div class="pl-card-song">🎵 ${esc(s.name)}</div>`)
      .join('');
    return `
      <div class="pl-card" onclick="openPlaylistDetail(${pl.id})">
        <div class="pl-card-color" style="background:${color}"></div>
        <div class="pl-card-icon">🎶</div>
        <div class="pl-card-name">${esc(pl.name)}</div>
        <div class="pl-card-meta">${(pl.song_ids||[]).length} songs · ${fmt(plDuration(pl))}</div>
        <div class="pl-card-songs">${songNames||'<div class="pl-card-song" style="color:var(--text3)">Empty playlist</div>'}</div>
        <div class="pl-card-btns">
          <button class="btn-sm" onclick="event.stopPropagation();playPlaylist(${pl.id})">▶ Play</button>
          <button class="btn-sm" onclick="event.stopPropagation();deletePlaylist(${pl.id})">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function renderSidebarPlaylists() {
  const list = document.getElementById('sbPlaylistList');
  if (!S.playlists.length) { list.innerHTML = '<div class="sb-pl-empty">No playlists yet</div>'; return; }
  list.innerHTML = S.playlists.map((pl,i) => `
    <div class="sb-pl-item" onclick="navigate('playlists',document.querySelector('[data-page=playlists]'));openPlaylistDetail(${pl.id})">
      <div class="sb-pl-dot" style="background:${PL_COLORS[i%PL_COLORS.length]}"></div>
      <span class="sb-pl-name">${esc(pl.name)}</span>
      <span class="sb-pl-count">${(pl.song_ids||[]).length}</span>
    </div>`).join('');
}

function plDuration(pl) {
  return (pl.song_ids||[]).reduce((a,id) => {
    const s = S.songs.find(x=>x.id===id); return a+(s?.duration||0);
  }, 0);
}

// ── Playlist CRUD ─────────────────────────────────────────────
let currentPlDetailId = null;

async function promptNewPlaylist() {
  openNameDialog('New Playlist', 'Playlist name…', async (name) => {
    try {
      const pl = await api('POST', '/api/playlists', { name });
      S.playlists.unshift({ ...pl, song_ids: [] });
      renderPlaylists();
      toast('"' + name + '" created', 'success');
    } catch(e) { toast('Failed to create playlist', 'error'); }
  });
}

async function deletePlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  try {
    await api('DELETE', '/api/playlists/' + id);
    S.playlists = S.playlists.filter(p=>p.id!==id);
    renderPlaylists();
    closeModal('plDetailModal');
    toast('Playlist deleted', 'warn');
  } catch(e) { toast('Delete failed', 'error'); }
}

async function openPlaylistDetail(id) {
  currentPlDetailId = id;
  const pl = S.playlists.find(p=>p.id===id);
  if (!pl) return;

  // Fetch full playlist with songs
  try {
    const full = await api('GET', '/api/playlists/' + id);
    const songs = full.songs || [];
    // Update local cache
    const idx = S.playlists.findIndex(p=>p.id===id);
    if (idx>=0) S.playlists[idx].song_ids = songs.map(s=>s.id);

    document.getElementById('plDetailName').textContent = pl.name;
    document.getElementById('plDetailMeta').textContent =
      songs.length + ' songs · ' + fmt(songs.reduce((a,s)=>a+s.duration,0));

    document.getElementById('plDetailBody').innerHTML = songs.length ? songs.map((s,i) => `
      <div class="pd-song" onclick="playSongById(${s.id})">
        <div class="pd-num">${i+1}</div>
        <div class="pd-info">
          <div class="pd-name">${esc(s.name)}</div>
          <div class="pd-meta">${s.bpm||'?'} BPM · ${s.key||'?'} ${s.scale||''} · ${fmt(s.duration)}</div>
        </div>
        <button class="pd-remove" onclick="event.stopPropagation();removeSongFromPlaylist(${id},${s.id})">✕</button>
      </div>`).join('')
    : '<p style="color:var(--text3);font-size:.85rem;padding:20px 0">No songs yet. Add songs from the Library!</p>';

    document.getElementById('plDetailModal').classList.remove('hidden');
  } catch(e) { toast('Could not load playlist', 'error'); }
}

async function removeSongFromPlaylist(plId, songId) {
  try {
    await api('DELETE', `/api/playlists/${plId}/songs/${songId}`);
    const pl = S.playlists.find(p=>p.id===plId);
    if (pl) pl.song_ids = (pl.song_ids||[]).filter(id=>id!==songId);
    openPlaylistDetail(plId); // refresh
    toast('Removed from playlist', 'warn');
  } catch(e) { toast('Failed to remove', 'error'); }
}

async function playPlaylist(id) {
  const pl = await api('GET', '/api/playlists/' + id);
  const songs = pl.songs || [];
  if (!songs.length) { toast('Playlist is empty', 'warn'); return; }
  S.queue = songs.map(s => s.id);
  S.queueIdx = 0;
  closeModal('plDetailModal');
  playSongById(S.queue[0]);
}

// ── Add to playlist modal ─────────────────────────────────────
let _addToPlSongId = null;

function openAddToPlaylist(songId) {
  _addToPlSongId = songId;
  const body = document.getElementById('addToPlBody');

  if (!S.playlists.length) {
    body.innerHTML = '<p style="color:var(--text3);font-size:.85rem">No playlists yet. Create one first!</p>';
  } else {
    body.innerHTML = S.playlists.map(pl => {
      const isIn = (pl.song_ids||[]).includes(songId);
      return `
        <div class="atp-item ${isIn?'added':''}" onclick="addSongToPlaylist(${pl.id},${songId},this)">
          <div class="atp-icon">🎶</div>
          <div class="atp-info">
            <div class="atp-name">${esc(pl.name)}</div>
            <div class="atp-meta">${(pl.song_ids||[]).length} songs</div>
          </div>
          ${isIn ? '<div class="atp-check">✓</div>' : ''}
        </div>`;
    }).join('');
  }
  document.getElementById('addToPlModal').classList.remove('hidden');
}

async function addSongToPlaylist(plId, songId, el) {
  if (el.classList.contains('added')) return;
  try {
    await api('POST', `/api/playlists/${plId}/songs`, { song_id: songId });
    el.classList.add('added');
    el.innerHTML += '<div class="atp-check">✓</div>';
    const pl = S.playlists.find(p=>p.id===plId);
    if (pl && !pl.song_ids) pl.song_ids = [];
    if (pl) pl.song_ids.push(songId);
    renderSidebarPlaylists();
    // Also update player page quick-add
    renderPlayerQuickAdd();
    toast('Added to "' + (pl?.name||'playlist') + '"', 'success');
  } catch(e) { toast('Failed to add', 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════════════════════════════
async function playSongById(id) {
  const song = S.songs.find(s=>s.id===id);
  if (!song) return;

  S.currentSong = song;

  // Build queue
  if (!S.queue.includes(id)) {
    S.queue    = S.songs.map(s=>s.id);
    S.queueIdx = S.queue.indexOf(id);
  } else {
    S.queueIdx = S.queue.indexOf(id);
  }

  // ── Audio playback ────────────────────────────────────────
  // <audio src> cannot send Authorization headers, so we pass
  // the token as a query param — the server accepts both.
  const token   = localStorage.getItem('bl_token') || '';
  const streamUrl = `${API}/api/songs/${id}/stream?token=${encodeURIComponent(token)}`;

  audio.src = streamUrl;
  audio.load();

  try {
    await audio.play();
    S.isPlaying = true;
  } catch(e) {
    // Autoplay blocked — user interaction needed, mark as playing
    // so the play button shows the right state
    S.isPlaying = false;
    console.warn('Autoplay blocked:', e.message);
  }

  updateNowPlayingBar(song);
  updatePlayerPage(song);
  updatePlayButtons();
  renderLibrary();

  drawWaveform(song);
  startBeatDetection();
  updateLyricsDisplay(song);

  if (document.getElementById('page-analysis').classList.contains('active')) {
    renderAnalysis(song);
  }

  navigate('player', document.querySelector('[data-page=player]'));
  cancelAnimationFrame(S.animFrame);
  S.animFrame = requestAnimationFrame(progressLoop);
}

function progressLoop() {
  if (!audio.duration) { S.animFrame = requestAnimationFrame(progressLoop); return; }
  const pct = audio.currentTime / audio.duration;

  // Seekbar + time
  document.getElementById('seekbarFill').style.width = (pct*100) + '%';
  document.getElementById('currentTime').textContent = fmt(audio.currentTime);
  document.getElementById('npbFill').style.width = (pct*100) + '%';
  document.getElementById('npbCurrent').textContent = fmt(audio.currentTime);

  // Loop region
  if (S.loopRegionOn && audio.currentTime >= S.loopEnd) {
    if (document.getElementById('countInToggle')?.checked) doCountIn();
    else audio.currentTime = S.loopStart;
  }

  // Waveform playhead
  if (S.waveformPeaks) redrawWaveform(pct, null);

  S.animFrame = requestAnimationFrame(progressLoop);
}

audio.addEventListener('ended', () => {
  if (S.isLooping) { audio.play(); return; }
  if (S.isShuffling) {
    S.queueIdx = Math.floor(Math.random() * S.queue.length);
  } else {
    S.queueIdx = (S.queueIdx + 1) % S.queue.length;
  }
  playSongById(S.queue[S.queueIdx]);
});

// ── Controls ──────────────────────────────────────────────────
function togglePlay() {
  if (!audio.src) return;
  if (S.isPlaying) { audio.pause(); S.isPlaying = false; }
  else             { audio.play();  S.isPlaying = true;  }
  updatePlayButtons();
}

function updatePlayButtons() {
  const icon = S.isPlaying ? '⏸' : '▶';
  document.getElementById('playBtn').textContent  = icon;
  document.getElementById('npbPlay').textContent  = icon;
}

function skipTrack(dir) {
  if (!S.queue.length) return;
  S.queueIdx = (S.queueIdx + dir + S.queue.length) % S.queue.length;
  playSongById(S.queue[S.queueIdx]);
}

function skipSeconds(s) {
  audio.currentTime = Math.max(0, Math.min(audio.duration||0, audio.currentTime + s));
}

function toggleLoop() {
  S.isLooping = !S.isLooping;
  document.getElementById('loopBtn').classList.toggle('active', S.isLooping);
  document.getElementById('npbLoop').classList.toggle('active', S.isLooping);
}

function toggleShuffle() {
  S.isShuffling = !S.isShuffling;
  document.getElementById('shuffleBtn').classList.toggle('active', S.isShuffling);
  document.getElementById('npbShuffle').classList.toggle('active', S.isShuffling);
}

function changeSpeed(v) {
  audio.playbackRate = parseFloat(v);
  document.getElementById('speedVal').textContent = parseFloat(v).toFixed(2) + '×';
}

function changeVolume(v) {
  audio.volume = parseFloat(v);
  document.getElementById('volVal').textContent = Math.round(v*100) + '%';
  document.getElementById('npbVol').value = v;
  document.getElementById('volSlider').value = v;
}

function seekClick(e) {
  if (!audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
}

function seekFromBar(e) {
  if (!audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
}

// Loop region
function toggleLoopRegion() {
  S.loopRegionOn = document.getElementById('loopRegionToggle').checked;
  if (S.loopRegionOn) {
    S.loopStart = parseFloat(document.getElementById('loopStart').value)||0;
    S.loopEnd   = parseFloat(document.getElementById('loopEnd').value)||30;
  }
}
function updateLoopRegion() {
  S.loopStart = parseFloat(document.getElementById('loopStart').value)||0;
  S.loopEnd   = parseFloat(document.getElementById('loopEnd').value)||30;
}
function setLoopFromCurrent() {
  const s = Math.max(0, audio.currentTime - 4);
  const e = Math.min(audio.duration||999, audio.currentTime + 16);
  document.getElementById('loopStart').value = Math.round(s);
  document.getElementById('loopEnd').value   = Math.round(e);
  S.loopStart = s; S.loopEnd = e;
  toast('Loop region set: ' + fmt(s) + ' → ' + fmt(e), 'success');
}

let countInActive = false;
function doCountIn() {
  if (countInActive) return;
  countInActive = true;
  audio.pause();
  const bpm   = S.currentSong?.bpm || 120;
  const delay = 60000 / bpm;
  let beat = 4;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:9999;pointer-events:none';
  overlay.innerHTML = '<div id="ciNum" style="font-size:8rem;font-weight:900;font-family:var(--mono);color:var(--accent4);animation:countBig .15s ease;text-shadow:0 0 40px var(--accent4)">4</div>';
  document.body.appendChild(overlay);

  const style = document.createElement('style');
  style.textContent = '@keyframes countBig{from{transform:scale(1.4);opacity:.6}to{transform:scale(1);opacity:1}}';
  document.head.appendChild(style);

  const tick = () => {
    playBeep(beat === 4);
    overlay.querySelector('#ciNum').textContent = beat;
    overlay.querySelector('#ciNum').style.animation='none';
    void overlay.querySelector('#ciNum').offsetWidth;
    overlay.querySelector('#ciNum').style.animation='countBig .15s ease';
    beat--;
    if (beat <= 0) {
      setTimeout(() => {
        overlay.remove(); style.remove();
        countInActive = false;
        audio.currentTime = S.loopStart;
        audio.play();
      }, delay);
    } else {
      setTimeout(tick, delay);
    }
  };
  setTimeout(tick, 0);
}

// Favourite
function toggleFavorite() {
  if (!S.currentSong) return;
  const id = S.currentSong.id;
  if (S.favorites.has(id)) S.favorites.delete(id);
  else S.favorites.add(id);
  localStorage.setItem('bl_favs', JSON.stringify([...S.favorites]));
  document.getElementById('npbHeart').classList.toggle('active', S.favorites.has(id));
}

// ═══════════════════════════════════════════════════════════════
// UPDATE NOW PLAYING UI
// ═══════════════════════════════════════════════════════════════
function updateNowPlayingBar(song) {
  document.getElementById('npbTitle').textContent = song.name;
  document.getElementById('npbMeta').textContent  = (song.bpm||'?') + ' BPM · ' + (song.key||'?') + ' ' + (song.scale||'');
  document.getElementById('npbKeyBadge').textContent = song.key ? song.key+' '+song.scale : '—';
  document.getElementById('npbBpmBadge').textContent = song.bpm ? song.bpm+' BPM' : '—';
  document.getElementById('totalTime').textContent   = fmt(song.duration);
  document.getElementById('npbTotal').textContent    = fmt(song.duration);
  document.getElementById('npbHeart').classList.toggle('active', S.favorites.has(song.id));
  updatePlayButtons();
}

function updatePlayerPage(song) {
  document.getElementById('ppTitle').textContent  = song.name;
  document.getElementById('ppKey').textContent    = song.key ? song.key+' '+song.scale : '—';
  document.getElementById('ppBpm').textContent    = song.bpm ? song.bpm+' BPM' : '—';
  document.getElementById('ppScale').textContent  = song.scale || '—';
  document.getElementById('totalTime').textContent= fmt(song.duration);
  renderPlayerQuickAdd();
}

function renderPlayerQuickAdd() {
  const song = S.currentSong; if (!song) return;
  const chips = document.getElementById('ppPlChips');
  const cont  = document.getElementById('ppPlAdd');
  if (!S.playlists.length) { cont.classList.add('hidden'); return; }
  cont.classList.remove('hidden');
  chips.innerHTML = S.playlists.map(pl => {
    const isIn = (pl.song_ids||[]).includes(song.id);
    return `<button class="pp-pl-chip ${isIn?'added':''}"
      onclick="addSongToPlaylist(${pl.id},${song.id},this)">
      ${isIn?'✓ ':''} ${esc(pl.name)}
    </button>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// WAVEFORM
// ═══════════════════════════════════════════════════════════════
async function drawWaveform(song) {
  const canvas = document.getElementById('waveformCanvas');
  const ctx    = canvas.getContext('2d');
  S.waveCtx    = ctx;

  // Fetch waveform data from server
  try {
    const data = await fetch(API + '/api/songs/' + song.id + '/waveform').then(r => r.json());
    const peaks = data.peaks || [];
    const W = canvas.offsetWidth;
    const H = 120;
    canvas.width  = W;
    canvas.height = H;
    S.waveformPeaks = peaks;
    S.waveformW     = W;
    redrawWaveform(0, null);
    setupWaveformEvents(canvas);
  } catch(e) {
    // Fallback: empty waveform
    console.warn('Waveform data unavailable');
  }
}

function redrawWaveform(playFrac, hoverFrac) {
  const peaks = S.waveformPeaks; if (!peaks?.length) return;
  const ctx = S.waveCtx;
  const W   = S.waveformW;
  const H   = 120;
  ctx.clearRect(0, 0, W, H);
  const N   = peaks.length;
  const px  = Math.round(playFrac * W);
  const hx  = hoverFrac !== null ? Math.round(hoverFrac * W) : null;

  for (let i = 0; i < W; i++) {
    const peakIdx = Math.floor(i / W * N);
    const p = peaks[peakIdx] || 0;
    const h = p * H * 0.9;
    const y = H/2 - h/2;
    const g = ctx.createLinearGradient(0,y,0,y+h);
    if (i < px) { g.addColorStop(0,'#1db954'); g.addColorStop(1,'#0a7a30'); }
    else         { g.addColorStop(0,'rgba(29,185,84,.22)'); g.addColorStop(1,'rgba(10,122,48,.12)'); }
    ctx.fillStyle = g;
    ctx.fillRect(i, y, 1, h||1);
  }

  // Loop region
  if (S.loopRegionOn && audio.duration) {
    const lx1 = S.loopStart / audio.duration * W;
    const lx2 = S.loopEnd   / audio.duration * W;
    ctx.fillStyle = 'rgba(124,77,255,.12)';
    ctx.fillRect(lx1, 0, lx2-lx1, H);
    ctx.strokeStyle = 'rgba(124,77,255,.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(lx1,0); ctx.lineTo(lx1,H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx2,0); ctx.lineTo(lx2,H); ctx.stroke();
  }

  // Hover line
  if (hx !== null) {
    ctx.save(); ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx,H); ctx.stroke(); ctx.restore();
  }

  // Playhead
  if (px > 0) {
    ctx.save();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.shadowColor='#1db954'; ctx.shadowBlur=10;
    ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,H); ctx.stroke();
    ctx.fillStyle='#1db954'; ctx.shadowBlur=0;
    ctx.beginPath(); ctx.moveTo(px-5,0); ctx.lineTo(px+5,0); ctx.lineTo(px,9); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(px-5,H); ctx.lineTo(px+5,H); ctx.lineTo(px,H-9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function setupWaveformEvents(canvas) {
  const tooltip = document.getElementById('waveTooltip');
  canvas.onmousemove = e => {
    const r    = canvas.getBoundingClientRect();
    const x    = e.clientX - r.left;
    const frac = Math.max(0, Math.min(1, x/canvas.width));
    tooltip.textContent  = fmt(frac * (audio.duration||0));
    tooltip.style.left   = x + 'px';
    tooltip.style.opacity= '1';
    redrawWaveform(audio.duration ? audio.currentTime/audio.duration : 0, frac);
  };
  canvas.onmouseleave = () => {
    tooltip.style.opacity = '0';
    redrawWaveform(audio.duration ? audio.currentTime/audio.duration : 0, null);
  };
  canvas.onclick = e => {
    if (!audio.duration) return;
    const r    = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX-r.left)/canvas.width));
    audio.currentTime = frac * audio.duration;
  };
}

// ═══════════════════════════════════════════════════════════════
// BEAT DETECTOR  (energetic rewrite)
// ═══════════════════════════════════════════════════════════════

let _bdCtx      = null;
let _bdAnalyser = null;
let _bdSource   = null;
let _bdFrame    = null;

// Beat tracking
const BEAT_TIMES  = [];
const ENERGY_BUF  = [];
const ENERGY_WIN  = 60;

// Cell sequencer state — lights up cells in order on beat
let _cellIdx    = 0;
let _beatCount  = 0;
let _lastLiveBpm= 0;

// Particle system for spectrum canvas
const PARTICLES = [];

function initBeatDetection() {
  if (_bdCtx) return;
  try {
    _bdCtx      = new AudioContext();
    _bdAnalyser = _bdCtx.createAnalyser();
    _bdAnalyser.fftSize                = 2048;
    _bdAnalyser.smoothingTimeConstant  = 0.8;
    _bdSource   = _bdCtx.createMediaElementSource(audio);
    _bdSource.connect(_bdAnalyser);
    _bdAnalyser.connect(_bdCtx.destination);
  } catch(e) { console.warn('Beat detection unavailable:', e); _bdCtx = null; }
}

function startBeatDetection() {
  cancelAnimationFrame(_bdFrame);
  initBeatDetection();
  if (!_bdCtx) return;
  if (_bdCtx.state === 'suspended') _bdCtx.resume();
  BEAT_TIMES.length = 0;
  ENERGY_BUF.length = 0;
  _cellIdx   = 0;
  _beatCount = 0;
  PARTICLES.length = 0;

  // Show server-detected BPM immediately
  const songBpm = S.currentSong?.bpm || 0;
  const numEl = document.getElementById('bdBpmNumber');
  if (numEl) numEl.textContent = songBpm || '—';
  const tmEl = document.getElementById('bdTempoLabel');
  if (tmEl) tmEl.textContent = songBpm ? tempoLabel(songBpm) : 'Tempo: —';

  runBeatDetection();
}

function stopBeatDetectionLoop() { cancelAnimationFrame(_bdFrame); }

function runBeatDetection() {
  if (!_bdAnalyser) return;

  const fftSize  = _bdAnalyser.frequencyBinCount;
  const freqData = new Uint8Array(fftSize);
  const timeData = new Float32Array(fftSize);
  _bdAnalyser.getByteFrequencyData(freqData);
  _bdAnalyser.getFloatTimeDomainData(timeData);

  // ── Sub-bass energy (kick drum range 20–150 Hz) ───────────
  const sr       = _bdCtx.sampleRate;
  const binW     = sr / (_bdAnalyser.fftSize);
  const lo       = Math.max(1, Math.round(20  / binW));
  const hi       = Math.min(fftSize-1, Math.round(150 / binW));

  let energy = 0;
  for (let i = lo; i <= hi; i++) energy += freqData[i] * freqData[i];
  energy = Math.sqrt(energy / (hi - lo + 1));

  // Overall RMS for energy display
  let rms = 0;
  for (let i = 0; i < timeData.length; i++) rms += timeData[i]*timeData[i];
  rms = Math.sqrt(rms / timeData.length);

  // ── Adaptive threshold ────────────────────────────────────
  ENERGY_BUF.push(energy);
  if (ENERGY_BUF.length > ENERGY_WIN) ENERGY_BUF.shift();
  const avg = ENERGY_BUF.reduce((a,b)=>a+b,0) / ENERGY_BUF.length;

  const now         = performance.now();
  const timeSince   = now - (BEAT_TIMES[BEAT_TIMES.length-1] || 0);
  const isBeat      = energy > avg * 1.32 && energy > 25 && timeSince > 240;

  if (isBeat) {
    BEAT_TIMES.push(now);
    if (BEAT_TIMES.length > 16) BEAT_TIMES.shift();
    _beatCount++;

    // Live BPM from median inter-beat interval
    if (BEAT_TIMES.length >= 4) {
      const intervals = [];
      for (let i = 1; i < BEAT_TIMES.length; i++)
        intervals.push(BEAT_TIMES[i] - BEAT_TIMES[i-1]);
      intervals.sort((a,b)=>a-b);
      const median = intervals[Math.floor(intervals.length/2)];
      if (median > 0) {
        const liveBpm = Math.round(60000 / median);
        if (liveBpm >= 40 && liveBpm <= 220) {
          _lastLiveBpm = liveBpm;
          const numEl = document.getElementById('bdBpmNumber');
          if (numEl) {
            numEl.textContent = liveBpm;
            numEl.classList.add('beat-pop');
            setTimeout(() => numEl.classList.remove('beat-pop'), 150);
          }
        }
      }
    }

    // Flash beat UI
    flashBeatUI();

    // Spawn particles on beat
    spawnParticles(energy / 255);
  }

  // Energy label
  const engPct = Math.round(Math.min(100, rms * 800));
  const engEl  = document.getElementById('bdEnergyLabel');
  if (engEl) engEl.textContent = 'Energy: ' + engPct + '%';

  // ── Draw visuals ──────────────────────────────────────────
  drawSpectrum(freqData, energy, avg, isBeat);
  drawOscilloscope(timeData, isBeat);

  _bdFrame = requestAnimationFrame(runBeatDetection);
}

// ── Beat flash UI ─────────────────────────────────────────────
let _cellTimer   = null;
let _detectorTimer = null;
function flashBeatUI() {
  const isDown = (_beatCount % 4 === 1);   // every 4th beat = downbeat

  // 8-cell strip: advance sequencer
  const cells = document.querySelectorAll('.bd-beat-cell');
  cells.forEach(c => c.classList.remove('lit','lit-down','half-lit'));

  // Light current cell
  if (cells[_cellIdx]) {
    cells[_cellIdx].classList.add(isDown ? 'lit-down' : 'lit');
  }
  // Dim previous two
  const prev1 = (_cellIdx - 1 + 8) % 8;
  const prev2 = (_cellIdx - 2 + 8) % 8;
  if (cells[prev1]) cells[prev1].classList.add('half-lit');
  if (cells[prev2]) cells[prev2].classList.remove('half-lit');

  clearTimeout(_cellTimer);
  _cellTimer = setTimeout(() => {
    if (cells[_cellIdx]) cells[_cellIdx].classList.remove('lit','lit-down');
  }, 160);

  _cellIdx = (_cellIdx + 1) % 8;

  // Pulse dot
  const dot = document.getElementById('bdPulseDot');
  if (dot) {
    dot.classList.add('on');
    setTimeout(() => dot.classList.remove('on'), 160);
  }

  // Detector card background flash
  const det = document.getElementById('beatDetector');
  if (det) {
    det.classList.add('beat-flash');
    clearTimeout(_detectorTimer);
    _detectorTimer = setTimeout(() => det.classList.remove('beat-flash'), 120);
  }

  // Beat ring on artwork
  const ring = document.getElementById('beatRing');
  if (ring) {
    ring.classList.add('beat');
    setTimeout(() => ring.classList.remove('beat'), 160);
  }

  // Artwork pulse
  const art = document.getElementById('ppArtwork');
  if (art) {
    art.style.transform = 'scale(1.028)';
    art.style.boxShadow = '0 0 40px rgba(0,245,196,.25), 0 20px 60px rgba(0,0,0,.6)';
    setTimeout(() => { art.style.transform = ''; art.style.boxShadow = ''; }, 100);
  }
}

// ── Particle system ───────────────────────────────────────────
function spawnParticles(intensity) {
  const canvas = document.getElementById('bdCanvas');
  if (!canvas) return;
  const W = canvas.width;
  const count = Math.floor(3 + intensity * 8);
  for (let i = 0; i < count; i++) {
    PARTICLES.push({
      x:     Math.random() * W,
      y:     canvas.height,
      vx:    (Math.random() - .5) * 3,
      vy:    -(2 + Math.random() * 4 * intensity),
      life:  1,
      decay: .03 + Math.random() * .04,
      size:  1.5 + Math.random() * 3 * intensity,
      hue:   Math.random() < .2 ? 'accent2' : 'accent',  // mostly teal, some pink
    });
  }
}

// ── Spectrum canvas ───────────────────────────────────────────
function drawSpectrum(freqData, energy, avg, isBeat) {
  const canvas = document.getElementById('bdCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.offsetWidth;
  const H   = canvas.height;
  canvas.width = W;

  // Dark background with subtle gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0d0d18');
  bg.addColorStop(1, '#111118');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const N  = 56;   // number of bars
  const bw = (W - N + 1) / N;

  for (let i = 0; i < N; i++) {
    // Log-spaced bins — more perceptually even
    const t      = i / N;
    const binIdx = Math.floor(Math.pow(freqData.length * .6, t));
    const raw    = freqData[Math.min(binIdx, freqData.length-1)] / 255;

    // Mirror the bar (top + bottom reflection)
    const barH   = Math.max(2, raw * H * .88);
    const x      = i * (bw + 1);

    // Gradient: teal top, purple mid, bright on beat
    const g = ctx.createLinearGradient(0, H/2 - barH/2, 0, H/2 + barH/2);
    if (isBeat && raw > .5) {
      g.addColorStop(0,   '#ffffff');
      g.addColorStop(0.15, '#00f5c4');
      g.addColorStop(0.6,  '#7b5cff');
      g.addColorStop(1,    '#ff4081');
    } else {
      g.addColorStop(0,   '#00f5c4');
      g.addColorStop(0.5, '#7b5cff');
      g.addColorStop(1,   'rgba(123,92,255,.2)');
    }

    // Glow on tall bars
    if (raw > .6) {
      ctx.shadowColor = isBeat ? '#00f5c4' : 'rgba(0,245,196,.5)';
      ctx.shadowBlur  = raw * 12;
    } else {
      ctx.shadowBlur  = 0;
    }

    ctx.fillStyle = g;

    // Symmetrical bar (top half + bottom half reflection)
    const cy = H / 2;
    ctx.fillRect(x, cy - barH/2, bw, barH/2);   // top half

    // Bottom reflection (faded)
    const refG = ctx.createLinearGradient(0, cy, 0, cy + barH * .4);
    refG.addColorStop(0,   'rgba(0,245,196,.25)');
    refG.addColorStop(1,   'rgba(0,245,196,0)');
    ctx.shadowBlur = 0;
    ctx.fillStyle  = refG;
    ctx.fillRect(x, cy, bw, barH * .4);
  }

  ctx.shadowBlur = 0;

  // Centre line
  ctx.strokeStyle = 'rgba(0,245,196,.12)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, H/2);
  ctx.lineTo(W, H/2);
  ctx.stroke();

  // Energy threshold line
  const thY = H/2 - (avg * 1.32 / 255 * H * .44);
  ctx.strokeStyle = 'rgba(255,64,129,.2)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, thY);
  ctx.lineTo(W, thY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw + update particles
  PARTICLES.forEach((p, idx) => {
    p.x   += p.vx;
    p.y   += p.vy;
    p.vy  *= .95;   // gravity
    p.life -= p.decay;

    if (p.life <= 0) { PARTICLES.splice(idx, 1); return; }

    const col = p.hue === 'accent2'
      ? `rgba(255,64,129,${p.life})`
      : `rgba(0,245,196,${p.life})`;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI*2);
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur  = p.size * 3;
    ctx.fill();
  });
  ctx.shadowBlur = 0;
}

// ── Oscilloscope ──────────────────────────────────────────────
function drawOscilloscope(timeData, isBeat) {
  const canvas = document.getElementById('bdOscCanvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const W    = canvas.offsetWidth;
  const H    = canvas.height;
  canvas.width = W;

  // Background
  ctx.fillStyle = '#111118';
  ctx.fillRect(0, 0, W, H);

  // Centre grid line
  ctx.strokeStyle = 'rgba(0,245,196,.06)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, H/2);
  ctx.lineTo(W, H/2);
  ctx.stroke();

  // Waveform
  const sliceW = W / timeData.length;
  ctx.beginPath();
  ctx.lineWidth   = 1.5;
  ctx.strokeStyle = isBeat ? 'rgba(0,245,196,.9)' : 'rgba(0,245,196,.55)';
  ctx.shadowColor = 'rgba(0,245,196,.4)';
  ctx.shadowBlur  = isBeat ? 8 : 3;

  for (let i = 0; i < timeData.length; i++) {
    const x = i * sliceW;
    const y = (timeData[i] * 0.8 + 1) / 2 * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ═══════════════════════════════════════════════════════════════
// ANALYSIS PAGE
// ═══════════════════════════════════════════════════════════════
function renderAnalysis(song) {
  if (!song) return;
  document.getElementById('analysisSubtitle').textContent = 'Analysis for: ' + song.name;

  document.getElementById('anBpm').textContent = song.bpm || '—';
  document.getElementById('anTempoLabel').textContent = song.bpm ? tempoLabel(song.bpm) : '—';

  document.getElementById('anKey').textContent = song.key ? song.key + ' ' + song.scale : '—';
  document.getElementById('anScaleDesc').textContent = song.key ? scaleDesc(song.key, song.scale) : '—';
  document.getElementById('anRelative').textContent  = song.key ? relativeKey(song.key, song.scale) : '';

  // Scale notes
  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const ri    = NOTES.indexOf(song.key);
  const steps = song.scale==='Major' ? [0,2,4,5,7,9,11] : [0,2,3,5,7,8,10];
  document.getElementById('anScaleNotes').innerHTML = ri>=0 ? steps.map((s,i) => {
    const n = NOTES[(ri+s)%12];
    return `<span class="an-note-chip ${i===0?'root':''}">${n}</span>`;
  }).join('') : '';

  // BPM bars
  if (song.bpm) {
    document.getElementById('anBpmBars').innerHTML =
      [65,85,55,90,70,80,60].map(h =>
        `<div class="bpm-bar-item" style="height:${h}%"></div>`).join('');
  }

  // Energy
  document.getElementById('energyMeters').innerHTML = [
    { label:'Energy',    val: song.energy||0,     color:'#ff4b6e' },
    { label:'Brightness',val: song.brightness||0,  color:'#ffb300' },
    { label:'Warmth',    val: song.warmth||0,       color:'#7c4dff' },
    { label:'Peak',      val: song.peak||0,         color:'#1db954' },
  ].map(m => `
    <div class="em-row">
      <span class="em-label">${m.label}</span>
      <div class="em-track"><div class="em-fill" style="width:${Math.round(m.val*100)}%;background:${m.color}"></div></div>
      <span class="em-val">${Math.round(m.val*100)}%</span>
    </div>`).join('');

  // Chords
  const NOTES2 = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  document.getElementById('anChordsGrid').innerHTML = (song.chords||[]).map((c,i) => {
    const isTonic = i===0 || (ri>=0 && c.startsWith(NOTES2[ri]));
    return `<span class="chord-chip ${isTonic?'tonic':''}" onclick="playChord('${c}')" title="Click to hear">${c}</span>`;
  }).join('') || '<span style="color:var(--text3);font-size:.85rem">No chords detected</span>';

  // Circle of fifths
  drawCircleOfFifths(song.key, song.chords||[]);
}

function drawCircleOfFifths(key, chords) {
  const canvas = document.getElementById('cofCanvas');
  const ctx    = canvas.getContext('2d');
  const W = 280, H = 280, cx = W/2, cy = H/2, r = 110, ri = 70;
  ctx.clearRect(0,0,W,H);

  const majorKeys = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'];
  const minorKeys = ['Am','Em','Bm','F#m','C#m','G#m','Ebm','Bbm','Fm','Cm','Gm','Dm'];

  majorKeys.forEach((k,i) => {
    const angle = (i/12)*Math.PI*2 - Math.PI/2;
    const isActive = k===key;
    const isChord  = chords.some(c=>c===k||c===k+'m');

    // Outer segment
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,angle,angle+(Math.PI*2/12));
    ctx.closePath();
    ctx.fillStyle = isActive ? '#1db954' : isChord ? 'rgba(29,185,84,.25)' : 'rgba(255,255,255,.06)';
    ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=1; ctx.stroke();

    // Label
    const lx = cx + (r+ri)/2 * Math.cos(angle + Math.PI/12);
    const ly = cy + (r+ri)/2 * Math.sin(angle + Math.PI/12);
    ctx.fillStyle = isActive ? '#000' : '#fff';
    ctx.font = isActive ? 'bold 13px Outfit' : '12px Outfit';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(k, lx, ly);

    // Inner (minor)
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,ri,angle,angle+(Math.PI*2/12));
    ctx.closePath();
    ctx.fillStyle='rgba(255,255,255,.04)'; ctx.fill();
    ctx.stroke();
    const mx = cx + ri*0.65 * Math.cos(angle + Math.PI/12);
    const my = cy + ri*0.65 * Math.sin(angle + Math.PI/12);
    ctx.fillStyle='rgba(255,255,255,.5)'; ctx.font='10px Outfit';
    ctx.fillText(minorKeys[i], mx, my);
  });

  // Center
  ctx.beginPath(); ctx.arc(cx,cy,26,0,Math.PI*2);
  ctx.fillStyle='var(--surface)'; ctx.fill();
  ctx.fillStyle='#fff'; ctx.font='bold 13px Outfit'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(key||'—', cx, cy);
}

// ═══════════════════════════════════════════════════════════════
// LYRICS
// ═══════════════════════════════════════════════════════════════

function updateLyricsDisplay(song) {
  const display = document.getElementById('lyricsDisplay');
  const editor  = document.getElementById('lyricsEditor');
  if (!display) return;

  const lyrics = song?.lyrics || '';
  if (lyrics.trim()) {
    display.innerHTML = `<pre class="lyrics-text">${esc(lyrics)}</pre>`;
  } else {
    display.innerHTML = '<p class="lyrics-placeholder">No lyrics yet — click Edit to add them</p>';
  }

  // Reset to display mode
  display.classList.remove('hidden');
  if (editor) { editor.value = lyrics; editor.classList.add('hidden'); }
  const footer = document.getElementById('lyricsEditFooter');
  if (footer) footer.classList.add('hidden');
  const editBtn = document.getElementById('lyricsEditBtn');
  if (editBtn) editBtn.textContent = '✏️ Edit';
}

function toggleLyricsEdit() {
  const display = document.getElementById('lyricsDisplay');
  const editor  = document.getElementById('lyricsEditor');
  const footer  = document.getElementById('lyricsEditFooter');
  const editBtn = document.getElementById('lyricsEditBtn');
  if (!editor) return;

  const isEditing = !editor.classList.contains('hidden');
  if (isEditing) {
    // Switch back to display
    cancelLyricsEdit();
  } else {
    // Switch to edit mode
    editor.value = S.currentSong?.lyrics || '';
    display.classList.add('hidden');
    editor.classList.remove('hidden');
    footer.classList.remove('hidden');
    editBtn.textContent = '👁 View';
    editor.focus();
    // Auto-resize on input
    editor.oninput = () => {
      editor.style.height = 'auto';
      editor.style.height = Math.max(120, editor.scrollHeight) + 'px';
    };
  }
}

function cancelLyricsEdit() {
  const display = document.getElementById('lyricsDisplay');
  const editor  = document.getElementById('lyricsEditor');
  const footer  = document.getElementById('lyricsEditFooter');
  const editBtn = document.getElementById('lyricsEditBtn');
  display.classList.remove('hidden');
  editor.classList.add('hidden');
  footer.classList.add('hidden');
  if (editBtn) editBtn.textContent = '✏️ Edit';
}

async function saveLyrics() {
  if (!S.currentSong) { toast('No song loaded', 'warn'); return; }
  const editor = document.getElementById('lyricsEditor');
  const lyrics = editor?.value?.trim() || '';

  try {
    await api('PUT', '/api/songs/' + S.currentSong.id, { lyrics });
    S.currentSong.lyrics = lyrics;
    // Also update in songs array
    const idx = S.songs.findIndex(s => s.id === S.currentSong.id);
    if (idx >= 0) S.songs[idx].lyrics = lyrics;

    updateLyricsDisplay(S.currentSong);
    toast('Lyrics saved ✓', 'success');
  } catch(e) {
    toast('Failed to save lyrics', 'error');
  }
}

let _lyricsScrollActive = false;
let _lyricsScrollTimer  = null;
function toggleLyricsScroll() {
  _lyricsScrollActive = !_lyricsScrollActive;
  const btn = document.getElementById('lyricsAutoScrollBtn');
  if (btn) btn.style.color = _lyricsScrollActive ? 'var(--accent)' : '';

  if (_lyricsScrollActive) {
    _lyricsScrollTimer = setInterval(() => {
      if (!_lyricsScrollActive || !audio.duration) return;
      const display = document.getElementById('lyricsDisplay');
      if (!display) return;
      const pct = audio.currentTime / audio.duration;
      const maxScroll = display.scrollHeight - display.clientHeight;
      display.scrollTop = pct * maxScroll;
    }, 1000);
  } else {
    clearInterval(_lyricsScrollTimer);
  }
}
async function deleteSong(id) {
  if (!confirm('Delete this song from the server?')) return;
  try {
    await api('DELETE', '/api/songs/' + id);
    S.songs = S.songs.filter(s=>s.id!==id);
    if (S.currentSong?.id === id) {
      audio.pause(); S.currentSong = null; S.isPlaying = false;
    }
    updateUI();
    toast('Song deleted', 'warn');
  } catch(e) { toast('Delete failed', 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════
function openNameDialog(title, placeholder, onOk) {
  document.getElementById('nameDialogTitle').textContent = title;
  const inp = document.getElementById('nameDialogInput');
  inp.placeholder = placeholder; inp.value = '';
  document.getElementById('nameDialog').classList.remove('hidden');
  setTimeout(() => inp.focus(), 50);
  const ok = document.getElementById('nameDialogOk');
  ok.onclick = () => { const v = inp.value.trim(); if(v){closeModal('nameDialog');onOk(v);} };
  inp.onkeydown = e => { if(e.key==='Enter'){const v=inp.value.trim();if(v){closeModal('nameDialog');onOk(v);}} };
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    switch(e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft':  e.preventDefault(); e.shiftKey ? skipTrack(-1) : skipSeconds(-10); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? skipTrack(1)  : skipSeconds(10);  break;
      case 'ArrowUp':    e.preventDefault(); changeVolume(Math.min(1, audio.volume+.05)); break;
      case 'ArrowDown':  e.preventDefault(); changeVolume(Math.max(0, audio.volume-.05)); break;
      case 'l': case 'L': toggleLoop();    break;
      case 's': case 'S': toggleShuffle(); break;
      case 'm': case 'M': changeVolume(audio.volume > 0 ? 0 : 1); break;
      case '1': navigate('dashboard', document.querySelector('[data-page=dashboard]')); break;
      case '2': navigate('player',    document.querySelector('[data-page=player]'));    break;
      case '3': navigate('library',   document.querySelector('[data-page=library]'));   break;
      case '4': navigate('playlists', document.querySelector('[data-page=playlists]')); break;
      case '5': navigate('analysis',  document.querySelector('[data-page=analysis]'));  break;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// UPLOAD OVERLAY
// ═══════════════════════════════════════════════════════════════
function showUploadOverlay(name, pct) {
  document.getElementById('uoTitle').textContent = 'Uploading "' + name + '"';
  document.getElementById('uoSub').textContent   = 'Hang tight…';
  document.getElementById('uoBar').style.width   = pct + '%';
  document.getElementById('uploadOverlay').classList.remove('hidden');
}
function updateUploadOverlay(msg, pct) {
  document.getElementById('uoSub').textContent = msg;
  document.getElementById('uoBar').style.width  = pct + '%';
}
function hideUploadOverlay() {
  document.getElementById('uploadOverlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
function toast(msg, type='success') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; setTimeout(()=>t.remove(),300); }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// SOUND HELPERS
// ═══════════════════════════════════════════════════════════════
let _ac = null;
function getAC() { if(!_ac||_ac.state==='closed') _ac=new AudioContext(); return _ac; }

function playBeep(isDown) {
  const ac=getAC(), o=ac.createOscillator(), g=ac.createGain();
  o.frequency.value=isDown?1400:1000; o.type='square';
  g.gain.setValueAtTime(.3,ac.currentTime);
  g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.07);
  o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+.07);
}

function playChord(name) {
  const NOTES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const root = NOTES.find(n=>name.startsWith(n));
  if (!root) return;
  const ri   = NOTES.indexOf(root);
  const isMin= name.endsWith('m')&&!name.endsWith('dim');
  const freqs= [
    midiF(60+ri),
    midiF(60+ri+(isMin?3:4)),
    midiF(60+ri+7),
  ];
  freqs.forEach((f,i)=>setTimeout(()=>playTone(f,1.2,.15),i*60));
}

function playTone(freq, dur=.4, vol=.2) {
  const ac=getAC(), o=ac.createOscillator(), g=ac.createGain();
  o.type='triangle'; o.frequency.value=freq;
  g.gain.setValueAtTime(vol,ac.currentTime);
  g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+dur);
  o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+dur);
}

function midiF(m) { return 440*Math.pow(2,(m-69)/12); }

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function fmt(s) {
  if (!s||isNaN(s)) return '0:00';
  return Math.floor(s/60)+':'+(Math.floor(s%60)+'').padStart(2,'0');
}
function esc(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function tempoLabel(bpm) {
  if (bpm<60)  return 'Largo';
  if (bpm<80)  return 'Andante — slow';
  if (bpm<100) return 'Moderato — medium';
  if (bpm<120) return 'Allegretto';
  if (bpm<140) return 'Allegro — fast';
  if (bpm<168) return 'Vivace — very fast';
  return 'Presto — extremely fast';
}

function scaleDesc(key, scale) {
  return scale==='Major'
    ? key+' Major — bright, uplifting, happy'
    : key+' Minor — emotional, dark, melancholic';
}

function relativeKey(key, scale) {
  const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const i=N.indexOf(key);
  if (scale==='Major') return 'Relative minor: '+N[(i+9)%12]+'m';
  return 'Relative major: '+N[(i+3)%12];
}

// ═══════════════════════════════════════════════════════════════
// EXPOSE globals
// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
  navigate, togglePlay, skipTrack, skipSeconds, toggleLoop, toggleShuffle,
  changeSpeed, changeVolume, seekClick, seekFromBar,
  toggleLoopRegion, updateLoopRegion, setLoopFromCurrent, toggleFavorite,
  filterLibrary, sortLibrary,
  promptNewPlaylist, deletePlaylist, openPlaylistDetail, playPlaylist,
  openAddToPlaylist, addSongToPlaylist, removeSongFromPlaylist,
  deleteSong, closeModal, renderAnalysis, playChord,
  toggleLyricsEdit, cancelLyricsEdit, saveLyrics, toggleLyricsScroll,
  S, fmt, esc,
});