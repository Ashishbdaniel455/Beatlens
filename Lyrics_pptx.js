/* ============================================================
   BeatLens — lyrics-pptx.js
   Exports selected song lyrics to a PowerPoint presentation.

   Features:
   · Pick songs from any/multiple playlists with checkboxes
   · 4 visual themes: Dark, Church, Concert, Minimal
   · Configurable lines per slide
   · Title slide per song with key/BPM metadata
   · Lyric slides chunked into readable sections
   · Section dividers between songs
   · Uses pptxgenjs (loaded via CDN in index.html)
   ============================================================ */
'use strict';

// ── Theme definitions ─────────────────────────────────────────
const PPTX_THEMES = {
  dark: {
    name:      'BeatLens Dark',
    bg:        '0a0a0f',
    titleBg:   '111118',
    accent:    '00f5c4',
    accentAlt: '7b5cff',
    text:      'e8e8f0',
    textDim:   '7070a0',
    lyricBg:   '111118',
    lyricText: 'e8e8f0',
    dividerBg: '1a1a26',
    font:      'Segoe UI',
    monoFont:  'Courier New',
  },
  church: {
    name:      'Church White',
    bg:        'FFFFFF',
    titleBg:   '1a3a5c',
    accent:    '1a3a5c',
    accentAlt: 'c8a84b',
    text:      'FFFFFF',
    textDim:   'b0c4d8',
    lyricBg:   'FFFFFF',
    lyricText: '1a1a2e',
    dividerBg: 'e8f0f8',
    font:      'Georgia',
    monoFont:  'Calibri',
  },
  concert: {
    name:      'Concert',
    bg:        '1a0533',
    titleBg:   '2d0660',
    accent:    'ff4eff',
    accentAlt: '00e5ff',
    text:      'FFFFFF',
    textDim:   'cc99ff',
    lyricBg:   '1a0533',
    lyricText: 'FFFFFF',
    dividerBg: '2d0660',
    font:      'Impact',
    monoFont:  'Arial',
  },
  minimal: {
    name:      'Minimal',
    bg:        'FAFAFA',
    titleBg:   '212121',
    accent:    '212121',
    accentAlt: '757575',
    text:      'FFFFFF',
    textDim:   'BDBDBD',
    lyricBg:   'FAFAFA',
    lyricText: '212121',
    dividerBg: 'F5F5F5',
    font:      'Calibri',
    monoFont:  'Consolas',
  },
};

// ── State ─────────────────────────────────────────────────────
let _pptxSelected = new Set();  // Set of song IDs selected for export
let _pptxFullData  = {};         // songId → full song object (with lyrics fetched)

// ═══════════════════════════════════════════════════════════════
// OPEN MODAL
// ═══════════════════════════════════════════════════════════════
async function openPptxExporter() {
  _pptxSelected.clear();
  _pptxFullData = {};

  document.getElementById('pptxModal').classList.remove('hidden');

  const listEl = document.getElementById('pptxPlaylistList');
  listEl.innerHTML = `<div style="font-family:var(--mono);font-size:.75rem;color:var(--text3);padding:20px 0">
    Loading playlists…</div>`;

  // Fetch all playlists with their songs
  try {
    const playlists = await api('GET', '/api/playlists');
    if (!playlists.length) {
      listEl.innerHTML = `<div style="font-family:var(--mono);font-size:.8rem;color:var(--text3);padding:20px 0">
        No playlists yet. Create some first!</div>`;
      return;
    }

    // Fetch full details (with songs) for each playlist
    const fullPlaylists = await Promise.all(
      playlists.map(pl => api('GET', '/api/playlists/' + pl.id))
    );

    renderPptxPlaylistList(fullPlaylists);
  } catch(e) {
    listEl.innerHTML = `<div style="color:var(--accent2);font-family:var(--mono);font-size:.78rem">
      Failed to load playlists: ${e.message}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// RENDER PLAYLIST / SONG CHECKBOXES
// ═══════════════════════════════════════════════════════════════
function renderPptxPlaylistList(playlists) {
  const listEl = document.getElementById('pptxPlaylistList');

  listEl.innerHTML = playlists.map((pl, pi) => {
    const songs = pl.songs || [];
    const songItems = songs.map(s => `
      <label class="pptx-song-row" style="display:flex;align-items:center;gap:10px;
        padding:9px 14px 9px 36px;cursor:pointer;border-bottom:1px solid var(--border);
        transition:.15s" onmouseenter="this.style.background='var(--surface3)'"
        onmouseleave="this.style.background='transparent'">
        <input type="checkbox" class="pptx-song-cb" data-id="${s.id}"
          data-name="${s.name.replace(/"/g,'&quot;')}"
          onchange="togglePptxSong(${s.id}, this.checked, ${JSON.stringify(s).replace(/</g,'&lt;')})"
          style="accent-color:var(--accent);width:15px;height:15px;cursor:pointer;flex-shrink:0"/>
        <div style="flex:1;min-width:0">
          <div style="font-size:.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(s.name)}
          </div>
          <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3);margin-top:2px">
            ${s.bpm ? s.bpm + ' BPM · ' : ''}${s.key ? s.key + ' ' + s.scale + ' · ' : ''}${fmt(s.duration)}
            ${s.lyrics ? ' · <span style="color:var(--accent)">has lyrics</span>' : ' · <span style="color:var(--accent2)">no lyrics</span>'}
          </div>
        </div>
        ${!s.lyrics ? '<span style="font-family:var(--mono);font-size:.6rem;color:var(--text3);white-space:nowrap">no lyrics</span>' : ''}
      </label>`).join('');

    const hasSongs = songs.length > 0;
    return `
      <div class="pptx-pl-block" style="background:var(--surface2);border:1px solid var(--border);
        border-radius:10px;margin-bottom:10px;overflow:hidden">
        <!-- Playlist header with select-all -->
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;
          background:var(--surface3);cursor:pointer"
          onclick="togglePptxPlaylist(${pi}, ${JSON.stringify(songs.map(s=>s.id))})">
          <input type="checkbox" id="pptx-pl-cb-${pi}" onclick="event.stopPropagation();togglePptxPlaylist(${pi}, ${JSON.stringify(songs.map(s=>s.id))})"
            style="accent-color:var(--accent3);width:15px;height:15px;cursor:pointer;flex-shrink:0"/>
          <div style="flex:1">
            <div style="font-weight:700;font-size:.88rem">🎶 ${esc(pl.name)}</div>
            <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3);margin-top:2px">
              ${songs.length} songs · click to select all
            </div>
          </div>
        </div>
        <!-- Songs -->
        ${hasSongs ? songItems : '<div style="padding:12px 14px;font-family:var(--mono);font-size:.75rem;color:var(--text3)">No songs in this playlist</div>'}
      </div>`;
  }).join('');

  updatePptxSummary();
}

// ── Toggle single song ────────────────────────────────────────
function togglePptxSong(id, checked, songData) {
  if (checked) {
    _pptxSelected.add(id);
    _pptxFullData[id] = songData;
  } else {
    _pptxSelected.delete(id);
    delete _pptxFullData[id];
  }
  updatePptxSummary();
}

// ── Toggle entire playlist ────────────────────────────────────
function togglePptxPlaylist(pi, songIds) {
  const cb       = document.getElementById('pptx-pl-cb-' + pi);
  const songCbs  = document.querySelectorAll(`.pptx-song-cb`);
  const allInPl  = songIds.every(id => _pptxSelected.has(id));
  const newState = !allInPl;

  cb.checked = newState;

  // Toggle all song checkboxes in this playlist
  songCbs.forEach(scb => {
    const id = parseInt(scb.dataset.id);
    if (songIds.includes(id)) {
      scb.checked = newState;
      if (newState) {
        _pptxSelected.add(id);
        // Store basic data — lyrics fetched at export time
        if (!_pptxFullData[id]) {
          _pptxFullData[id] = { id, name: scb.dataset.name };
        }
      } else {
        _pptxSelected.delete(id);
        delete _pptxFullData[id];
      }
    }
  });

  updatePptxSummary();
}

// ── Selection summary ─────────────────────────────────────────
function updatePptxSummary() {
  const sumEl  = document.getElementById('pptxSummary');
  const textEl = document.getElementById('pptxSummaryText');
  const genBtn = document.getElementById('pptxGenerateBtn');
  const n      = _pptxSelected.size;

  if (n === 0) {
    sumEl.style.display = 'none';
    if (genBtn) genBtn.disabled = true;
    return;
  }

  sumEl.style.display = 'block';
  if (genBtn) genBtn.disabled = false;

  const withLyrics    = [..._pptxSelected].filter(id => _pptxFullData[id]?.lyrics).length;
  const withoutLyrics = n - withLyrics;

  textEl.innerHTML =
    `<strong style="color:var(--accent)">${n} song${n!==1?'s':''} selected</strong>` +
    (withLyrics    ? ` · ${withLyrics} with lyrics`                            : '') +
    (withoutLyrics ? ` · <span style="color:var(--accent4)">${withoutLyrics} without lyrics (will show placeholder)</span>` : '');
}

// ═══════════════════════════════════════════════════════════════
// GENERATE PPTX
// ═══════════════════════════════════════════════════════════════
async function generatePptx() {
  if (_pptxSelected.size === 0) {
    if (typeof showToast === 'function') showToast('Select at least one song first', 'warn');
    return;
  }

  const btn = document.getElementById('pptxGenerateBtn');
  btn.disabled  = true;
  btn.textContent = '⏳ Generating…';

  const theme        = PPTX_THEMES[document.getElementById('pptxTheme').value] || PPTX_THEMES.dark;
  const linesPerSlide= parseInt(document.getElementById('pptxLinesPerSlide').value) || 8;
  const showTitle    = document.getElementById('pptxSongTitles').checked;
  const showMeta     = document.getElementById('pptxSongMeta').checked;

  try {
    // Fetch full song data (with lyrics) for all selected songs
    btn.textContent = '⏳ Fetching lyrics…';
    const songs = await fetchSelectedSongs();

    // Build the presentation
    btn.textContent = '⏳ Building slides…';
    const prs = await buildPresentation(songs, theme, linesPerSlide, showTitle, showMeta);

    // Download
    btn.textContent = '⏳ Saving file…';
    const filename = `BeatLens-Lyrics-${new Date().toISOString().slice(0,10)}.pptx`;
    await prs.writeFile({ fileName: filename });

    if (typeof showToast === 'function') {
      showToast(`✅ "${filename}" downloaded — ${songs.length} songs, ready to use!`, 'success');
    }
    closeModal('pptxModal');

  } catch(e) {
    console.error('PPTX generation failed:', e);
    if (typeof showToast === 'function') showToast('Export failed: ' + e.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '⬇️ Generate PowerPoint';
  }
}

// ── Fetch full lyrics for all selected songs ──────────────────
async function fetchSelectedSongs() {
  const songs = [];
  for (const id of _pptxSelected) {
    try {
      const song = await api('GET', '/api/songs/' + id);
      songs.push(song);
    } catch(e) {
      // Use cached basic data if fetch fails
      songs.push(_pptxFullData[id] || { id, name: 'Unknown', lyrics: '' });
    }
  }
  return songs;
}

// ═══════════════════════════════════════════════════════════════
// BUILD PRESENTATION
// ═══════════════════════════════════════════════════════════════
async function buildPresentation(songs, theme, linesPerSlide, showTitle, showMeta) {
  const prs    = new PptxGenJS();
  prs.layout   = 'LAYOUT_WIDE';   // 13.33" × 7.5"
  prs.author   = 'BeatLens';
  prs.title    = 'BeatLens Lyrics Export';
  prs.subject  = songs.map(s => s.name).join(', ');

  const W = 13.33, H = 7.5;

  // ── Cover slide ──────────────────────────────────────────────
  addCoverSlide(prs, songs, theme, W, H);

  // ── One section per song ─────────────────────────────────────
  songs.forEach((song, idx) => {
    // Section divider between songs (except before first)
    if (idx > 0) addDividerSlide(prs, song, idx + 1, songs.length, theme, W, H);

    // Song title slide
    if (showTitle) addSongTitleSlide(prs, song, theme, showMeta, W, H);

    // Lyric slides
    addLyricSlides(prs, song, theme, linesPerSlide, W, H);
  });

  return prs;
}

// ── Cover slide ───────────────────────────────────────────────
function addCoverSlide(prs, songs, theme, W, H) {
  const slide = prs.addSlide();
  slide.background = { color: theme.titleBg };

  // Big accent bar on left
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: 0.6, h: H,
    fill: { color: theme.accent },
  });

  // Title
  slide.addText('LYRICS', {
    x: 1.0, y: 1.8, w: W - 1.5, h: 1.4,
    fontSize: 72, fontFace: theme.font, bold: true,
    color: theme.text, align: 'left', charSpacing: 8,
  });

  slide.addText('PRESENTATION', {
    x: 1.0, y: 3.1, w: W - 1.5, h: 0.7,
    fontSize: 26, fontFace: theme.font, bold: false,
    color: theme.accentAlt, align: 'left', charSpacing: 6,
  });

  // Song list summary
  const summary = songs.slice(0, 8).map((s, i) => `${i + 1}. ${s.name}`).join('\n') +
    (songs.length > 8 ? `\n+ ${songs.length - 8} more…` : '');

  slide.addText(summary, {
    x: 1.0, y: 4.2, w: W - 1.5, h: 2.5,
    fontSize: 14, fontFace: theme.monoFont,
    color: theme.textDim, align: 'left', valign: 'top',
  });

  // Date bottom right
  slide.addText(new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }), {
    x: W - 4, y: H - 0.55, w: 3.5, h: 0.4,
    fontSize: 10, fontFace: theme.monoFont,
    color: theme.textDim, align: 'right',
  });

  // "Made with BeatLens"
  slide.addText('Made with BeatLens', {
    x: 0.8, y: H - 0.55, w: 4, h: 0.4,
    fontSize: 10, fontFace: theme.monoFont,
    color: theme.accent, align: 'left',
  });
}

// ── Section divider between songs ────────────────────────────
function addDividerSlide(prs, song, num, total, theme, W, H) {
  const slide = prs.addSlide();
  slide.background = { color: theme.dividerBg };

  // Accent bar top
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: W, h: 0.12,
    fill: { color: theme.accent },
  });
  // Accent bar bottom
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: H - 0.12, w: W, h: 0.12,
    fill: { color: theme.accentAlt },
  });

  slide.addText(`Song ${num} of ${total}`, {
    x: 0.5, y: 2.8, w: W - 1, h: 0.5,
    fontSize: 16, fontFace: theme.monoFont,
    color: theme.textDim, align: 'center',
  });
  slide.addText(song.name, {
    x: 0.5, y: 3.3, w: W - 1, h: 1.2,
    fontSize: 36, fontFace: theme.font, bold: true,
    color: theme.accentAlt, align: 'center',
  });
}

// ── Song title slide ──────────────────────────────────────────
function addSongTitleSlide(prs, song, theme, showMeta, W, H) {
  const slide = prs.addSlide();
  slide.background = { color: theme.titleBg };

  // Left accent bar
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: 0.5, h: H,
    fill: { color: theme.accent },
  });

  // Song name
  const nameSize = song.name.length > 30 ? 38 : song.name.length > 20 ? 46 : 56;
  slide.addText(song.name, {
    x: 1.0, y: 1.6, w: W - 1.5, h: 2.5,
    fontSize: nameSize, fontFace: theme.font, bold: true,
    color: theme.text, align: 'left', valign: 'middle',
  });

  // Metadata row
  if (showMeta) {
    const meta = [
      song.key   ? `Key: ${song.key} ${song.scale}` : null,
      song.bpm   ? `BPM: ${song.bpm}` : null,
      song.mood  ? `Mood: ${song.mood}` : null,
    ].filter(Boolean).join('   ·   ');

    if (meta) {
      slide.addText(meta, {
        x: 1.0, y: H - 1.5, w: W - 1.5, h: 0.5,
        fontSize: 14, fontFace: theme.monoFont,
        color: theme.accent, align: 'left',
      });
    }
  }

  // Chord chips
  if (song.chords && song.chords.length) {
    const chordText = song.chords.slice(0, 7).join('  ');
    slide.addText(chordText, {
      x: 1.0, y: H - 0.95, w: W - 1.5, h: 0.4,
      fontSize: 13, fontFace: theme.monoFont,
      color: theme.textDim, align: 'left',
    });
  }
}

// ── Lyric slides ──────────────────────────────────────────────
function addLyricSlides(prs, song, theme, linesPerSlide, W, H) {
  const rawLyrics = (song.lyrics || '').trim();

  if (!rawLyrics) {
    const slide = prs.addSlide();
    slide.background = { color: theme.lyricBg };
    addSlideFooter(prs, slide, song, theme, W, H);

    slide.addText('[ No lyrics saved for this song ]', {
      x: 1.0, y: H/2 - 0.5, w: W - 2, h: 1,
      fontSize: 20, fontFace: theme.font, italic: true,
      color: theme.textDim, align: 'center', valign: 'middle',
    });
    return;
  }

  const allLines = rawLyrics.split('\n');
  const chunks   = chunkLines(allLines, linesPerSlide);

  chunks.forEach((chunk, chunkIdx) => {
    const slide = prs.addSlide();
    slide.background = { color: theme.lyricBg };
    addSlideFooter(prs, slide, song, theme, W, H);

    if (chunks.length > 1) {
      slide.addText(`${chunkIdx + 1} / ${chunks.length}`, {
        x: W - 1.8, y: 0.18, w: 1.5, h: 0.3,
        fontSize: 9, fontFace: theme.monoFont,
        color: theme.textDim, align: 'right',
      });
    }

    const nonEmpty = chunk.filter(l => l.trim());
    if (!nonEmpty.length) return;

    const maxLen  = Math.max(...nonEmpty.map(l => l.length));
    let fontSize  = chunk.length <= 4 ? 36 : chunk.length <= 6 ? 30 : chunk.length <= 8 ? 26 : 22;
    if (maxLen > 50) fontSize = Math.max(18, fontSize - 4);
    if (maxLen > 70) fontSize = Math.max(16, fontSize - 3);

    const richText = [];
    chunk.forEach((line, li) => {
      const isBlank = !line.trim();
      richText.push({
        text:    isBlank ? ' ' : line,
        options: {
          fontSize,
          fontFace:      theme.font,
          color:         isBlank ? theme.textDim : theme.lyricText,
          bold:          false,
          breakLine:     li < chunk.length - 1,
          paraSpaceAfter: isBlank ? 2 : 0,
        },
      });
    });

    slide.addText(richText, {
      x: 0.8, y: 0.6,
      w: W - 1.6, h: H - 1.3,
      valign: 'middle', align: 'center',
    });
  });
}

// ── Footer on each lyric slide ────────────────────────────────
function addSlideFooter(prs, slide, song, theme, W, H) {
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: H - 0.42, w: W, h: 0.42,
    fill: { color: theme.titleBg },
  });
  slide.addText(song.name, {
    x: 0.3, y: H - 0.38, w: W - 0.6, h: 0.32,
    fontSize: 9, fontFace: theme.monoFont,
    color: theme.textDim, align: 'left', valign: 'middle',
  });
  if (song.key || song.bpm) {
    const meta = [
      song.key ? song.key + ' ' + song.scale : null,
      song.bpm ? song.bpm + ' BPM'           : null,
    ].filter(Boolean).join(' · ');
    slide.addText(meta, {
      x: W - 3, y: H - 0.38, w: 2.7, h: 0.32,
      fontSize: 9, fontFace: theme.monoFont,
      color: theme.accent, align: 'right', valign: 'middle',
    });
  }
}

// ── Chunk lines into slides ───────────────────────────────────
function chunkLines(lines, perSlide) {
  // Trim leading/trailing blank lines
  while (lines.length && !lines[0].trim())        lines.shift();
  while (lines.length && !lines[lines.length-1].trim()) lines.pop();

  if (!lines.length) return [];

  const chunks = [];
  let current  = [];

  lines.forEach(line => {
    current.push(line);

    // Natural break: blank line after perSlide non-blank lines
    const nonBlank = current.filter(l => l.trim()).length;
    if (nonBlank >= perSlide && !line.trim()) {
      // Trim trailing blank from chunk
      while (current.length && !current[current.length-1].trim()) current.pop();
      chunks.push([...current]);
      current = [];
    }
  });

  // Remaining lines — split into perSlide chunks if too long
  if (current.length) {
    const remaining = current.filter(l => l.trim());
    if (remaining.length <= perSlide) {
      if (current.length) chunks.push(current);
    } else {
      // Force split
      for (let i = 0; i < current.length; i += perSlide) {
        chunks.push(current.slice(i, i + perSlide));
      }
    }
  }

  return chunks.filter(c => c.some(l => l.trim()));
}

// ── Expose ────────────────────────────────────────────────────
Object.assign(window, {
  openPptxExporter,
  togglePptxSong,
  togglePptxPlaylist,
  generatePptx,
});