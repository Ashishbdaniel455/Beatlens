BeatLens v4 — Setup Guide
==========================

FOLDER STRUCTURE
─────────────────
BeatLens-v4/
├── server.py           ← Python backend
├── requirements.txt    ← Python libraries
├── index.html          ← Website (copy from frontend/)
├── style.css           ← Website styles
├── app.js              ← Website logic
├── beatlens.db         ← Database (auto-created)
└── uploads/            ← Audio files (auto-created)


QUICK START (3 steps)
──────────────────────

1. INSTALL PYTHON LIBRARIES
   Open a terminal in this folder and run:
   
   pip install -r requirements.txt

2. COPY FRONTEND FILES
   Copy index.html, style.css, app.js into THIS folder
   (same folder as server.py)

3. START THE SERVER
   python server.py
   
   Then open: http://localhost:8000


KEYBOARD SHORTCUTS
───────────────────
  Space         Play / Pause
  ←  →          Rewind / Forward 10 seconds
  Shift + ←/→   Previous / Next track
  ↑  ↓          Volume up / down
  L             Toggle loop
  S             Toggle shuffle
  M             Mute / Unmute
  1             Dashboard
  2             Player
  3             Library
  4             Playlists
  5             Analysis


FEATURES
─────────
  🎵  Spotify-style layout with sidebar navigation
  📊  Dashboard with stats, key distribution, BPM spread
  🎧  Full player with waveform, beat detector, loop region
  📚  Library with search, sort, analyse per song
  📂  Playlists — create, add songs, play all
  🔬  Deep analysis — circle of fifths, chords, energy
  🥁  Real-time beat detector with visualiser
  ⌨️  Full keyboard shortcuts
  💾  Everything stored permanently in SQLite database
  🔄  Audio streamed from server — no re-uploading needed


API ENDPOINTS
──────────────
  POST   /api/analyze              Upload + analyse song
  GET    /api/songs                All songs
  GET    /api/songs/{id}/stream    Stream audio
  GET    /api/songs/{id}/waveform  Waveform data
  GET    /api/search?q=            Search
  POST   /api/playlists            Create playlist
  GET    /api/playlists/{id}       Get playlist + songs
  POST   /api/playlists/{id}/songs Add song to playlist
  GET    /docs                     Interactive API docs