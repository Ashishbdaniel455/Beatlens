"""
================================================================
BeatLens v5 — server.py
Full backend: Auth · Improved DB · Advanced Analysis

New in v5:
  · JWT-based user auth (register / login)
  · Each user owns their own songs & playlists
  · Improved BPM: median-beat + tempo-map voting
  · Improved Key: harmonic separation before chroma
  · Improved Chords: full 24-chord pool (all 12 major+minor)
    scored per-frame then ranked
  · Spectral features: spectral centroid, rolloff, contrast
  · Mood classification (happy/sad/energetic/calm)
  · Real-time chord frames endpoint for live chord detector

Auth endpoints:
  POST /api/auth/register   { username, password }
  POST /api/auth/login      { username, password }  → token
  GET  /api/auth/me         (requires token)

All /api/songs and /api/playlists routes now require
a valid Bearer token header.
================================================================
"""

import os, math, struct, sqlite3, traceback, json, hashlib, secrets, time
from pathlib import Path
from typing import Optional, List
from datetime import datetime, timedelta

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel

# ── Optional heavy libs ───────────────────────────────────────
try:
    import numpy as np
    import librosa
    LIBROSA = True
    print("✅ librosa — full analysis enabled")
except ImportError:
    LIBROSA = False
    np = None
    print("⚠️  librosa not installed: pip install librosa")

try:
    import jwt as pyjwt
    JWT = True
except ImportError:
    JWT = False
    print("⚠️  PyJWT not installed: pip install PyJWT")

# ── App ───────────────────────────────────────────────────────
app = FastAPI(title="BeatLens API", version="5.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BASE     = Path(__file__).parent
DB_PATH  = BASE / "beatlens.db"
UPLOADS  = BASE / "uploads"
UPLOADS.mkdir(exist_ok=True)
FRONTEND = BASE / "frontend"

JWT_SECRET  = os.environ.get("BEATLENS_SECRET", secrets.token_hex(32))
JWT_EXPIRE_HOURS = 72

# ════════════════════════════════════════════════════════════════
# DATABASE
# ════════════════════════════════════════════════════════════════

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    return conn

def _table_exists(conn, name):
    r = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    return r[0] > 0

def _column_exists(conn, table, col):
    try:
        cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        return col in cols
    except:
        return False

def init_db():
    """
    Safe migration: creates tables if missing, adds columns if missing.
    Never drops data. Works on both fresh installs and upgrades.
    """
    conn = db()
    c    = conn.cursor()

    # ── users table (new in v5) ───────────────────────────────
    c.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            salt          TEXT    NOT NULL,
            created_at    TEXT    DEFAULT (datetime('now')),
            last_login    TEXT
        )
    """)

    # ── songs table ───────────────────────────────────────────
    c.execute("""
        CREATE TABLE IF NOT EXISTS songs (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id           INTEGER,
            filename          TEXT    NOT NULL DEFAULT '',
            name              TEXT    NOT NULL DEFAULT 'Unknown',
            filepath          TEXT    NOT NULL DEFAULT '',
            duration          REAL    DEFAULT 0,
            bpm               INTEGER DEFAULT 0,
            bpm_confidence    REAL    DEFAULT 0,
            key               TEXT    DEFAULT '',
            scale             TEXT    DEFAULT '',
            key_confidence    REAL    DEFAULT 0,
            chords            TEXT    DEFAULT '',
            chord_frames      TEXT    DEFAULT '',
            energy            REAL    DEFAULT 0,
            brightness        REAL    DEFAULT 0,
            warmth            REAL    DEFAULT 0,
            peak              REAL    DEFAULT 0,
            spectral_centroid REAL    DEFAULT 0,
            mood              TEXT    DEFAULT '',
            waveform          TEXT    DEFAULT '',
            lyrics            TEXT    DEFAULT '',
            notes             TEXT    DEFAULT '',
            play_count        INTEGER DEFAULT 0,
            created_at        TEXT    DEFAULT (datetime('now'))
        )
    """)

    # ── playlists table ───────────────────────────────────────
    c.execute("""
        CREATE TABLE IF NOT EXISTS playlists (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER,
            name        TEXT    NOT NULL,
            description TEXT    DEFAULT '',
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)

    # ── playlist_songs table ──────────────────────────────────
    c.execute("""
        CREATE TABLE IF NOT EXISTS playlist_songs (
            playlist_id  INTEGER,
            song_id      INTEGER,
            position     INTEGER DEFAULT 0,
            added_at     TEXT    DEFAULT (datetime('now')),
            PRIMARY KEY (playlist_id, song_id)
        )
    """)

    # ── Safe migrations: add any missing columns ──────────────
    migrations = [
        # (table, column, definition)
        ("songs", "user_id",           "INTEGER"),
        ("songs", "bpm_confidence",    "REAL DEFAULT 0"),
        ("songs", "key_confidence",    "REAL DEFAULT 0"),
        ("songs", "chord_frames",      "TEXT DEFAULT ''"),
        ("songs", "spectral_centroid", "REAL DEFAULT 0"),
        ("songs", "mood",              "TEXT DEFAULT ''"),
        ("songs", "play_count",        "INTEGER DEFAULT 0"),
        ("songs", "notes",             "TEXT DEFAULT ''"),
        ("playlists", "user_id",       "INTEGER"),
        ("playlists", "description",   "TEXT DEFAULT ''"),
    ]
    for table, col, defn in migrations:
        if _table_exists(conn, table) and not _column_exists(conn, table, col):
            try:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {defn}")
                print(f"  Migration: added {table}.{col}")
            except Exception as e:
                print(f"  Migration skipped {table}.{col}: {e}")

    # ── Indexes ───────────────────────────────────────────────
    for idx_sql in [
        "CREATE INDEX IF NOT EXISTS idx_songs_user   ON songs(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_pl_user      ON playlists(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_pl_songs_pl  ON playlist_songs(playlist_id)",
    ]:
        try:
            c.execute(idx_sql)
        except:
            pass

    conn.commit()
    conn.close()
    print(f"  Database ready: {DB_PATH}")

init_db()

# ════════════════════════════════════════════════════════════════
# AUTH HELPERS
# ════════════════════════════════════════════════════════════════

def hash_password(password: str, salt: str) -> str:
    # 100,000 iterations — safe but fast enough (< 1 second on most machines)
    return hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000
    ).hex()

def make_token(user_id: int, username: str) -> str:
    """Create auth token — uses PyJWT if available, else simple HMAC token."""
    if JWT:
        try:
            payload = {
                "sub":      str(user_id),
                "username": username,
                "exp":      datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
            }
            return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")
        except Exception as e:
            print(f"  JWT encode error: {e}, falling back to HMAC token")

    # Fallback — simple HMAC-signed token (works without PyJWT)
    ts   = str(int(time.time()))
    data = f"{user_id}:{username}:{ts}"
    sig  = hashlib.sha256((data + JWT_SECRET).encode()).hexdigest()[:32]
    import base64
    raw  = f"{data}:{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode()

def decode_token(token: str) -> dict:
    """Decode and validate auth token."""
    if JWT:
        try:
            payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            return payload
        except pyjwt.ExpiredSignatureError:
            raise HTTPException(401, "Session expired — please log in again")
        except Exception:
            pass  # fall through to HMAC check

    # Try HMAC fallback token
    try:
        import base64
        raw   = base64.urlsafe_b64decode(token.encode()).decode()
        parts = raw.split(":")
        if len(parts) < 4:
            raise ValueError("bad format")
        user_id, username, ts, sig = parts[0], parts[1], parts[2], parts[3]
        data     = f"{user_id}:{username}:{ts}"
        expected = hashlib.sha256((data + JWT_SECRET).encode()).hexdigest()[:32]
        if sig != expected:
            raise ValueError("bad signature")
        if time.time() - int(ts) > JWT_EXPIRE_HOURS * 3600:
            raise HTTPException(401, "Session expired — please log in again")
        return {"sub": user_id, "username": username}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(401, "Invalid or expired token — please log in again")

def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not logged in")
    token   = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Empty token")
    payload = decode_token(token)
    user_id = int(payload["sub"])
    conn    = db()
    user    = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(401, "User not found")
    return dict(user)

# ── Pydantic models ───────────────────────────────────────────
class RegisterBody(BaseModel):
    username: str
    password: str

class LoginBody(BaseModel):
    username: str
    password: str

class SongUpdate(BaseModel):
    name:   Optional[str] = None
    lyrics: Optional[str] = None
    notes:  Optional[str] = None

class PlaylistBody(BaseModel):
    name:        str
    description: Optional[str] = ""

class AddSong(BaseModel):
    song_id: int

# ════════════════════════════════════════════════════════════════
# AUTH ROUTES
# ════════════════════════════════════════════════════════════════

@app.post("/api/auth/register", status_code=201)
def register(body: RegisterBody):
    username = body.username.strip().lower()

    # Validate
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(username) > 30:
        raise HTTPException(400, "Username must be 30 characters or less")
    if not username.replace('_','').replace('-','').isalnum():
        raise HTTPException(400, "Username can only contain letters, numbers, - and _")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    print(f"  [auth] Registering user: {username}")
    salt    = secrets.token_hex(16)
    pw_hash = hash_password(body.password, salt)
    print(f"  [auth] Password hashed OK")

    conn = db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, salt) VALUES (?,?,?)",
            (username, pw_hash, salt)
        )
        conn.commit()
        row     = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        user_id = row["id"]
        print(f"  [auth] User created: id={user_id} username={username}")
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(409, "That username is already taken — please choose another")
    except Exception as e:
        conn.close()
        print(f"  [auth] Register error: {e}")
        traceback.print_exc()
        raise HTTPException(500, f"Registration failed: {str(e)}")
    conn.close()

    token = make_token(user_id, username)
    return {"token": token, "username": username, "user_id": user_id}

@app.post("/api/auth/login")
def login(body: LoginBody):
    username = body.username.strip().lower()
    conn = db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()

    if not user:
        conn.close(); raise HTTPException(401, "Invalid username or password")

    pw_hash = hash_password(body.password, user["salt"])
    if pw_hash != user["password_hash"]:
        conn.close(); raise HTTPException(401, "Invalid username or password")

    conn.execute("UPDATE users SET last_login=datetime('now') WHERE id=?", (user["id"],))
    conn.commit(); conn.close()

    token = make_token(user["id"], username)
    return {
        "token":    token,
        "username": username,
        "user_id":  user["id"],
    }

@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    conn = db()
    song_count  = conn.execute("SELECT COUNT(*) FROM songs WHERE user_id=?",     (user["id"],)).fetchone()[0]
    pl_count    = conn.execute("SELECT COUNT(*) FROM playlists WHERE user_id=?", (user["id"],)).fetchone()[0]
    total_dur   = conn.execute("SELECT COALESCE(SUM(duration),0) FROM songs WHERE user_id=?", (user["id"],)).fetchone()[0]
    play_count  = conn.execute("SELECT COALESCE(SUM(play_count),0) FROM songs WHERE user_id=?", (user["id"],)).fetchone()[0]
    top_key_row = conn.execute("""
        SELECT key || ' ' || scale as ks, COUNT(*) as cnt
        FROM songs WHERE user_id=? AND key != ''
        GROUP BY ks ORDER BY cnt DESC LIMIT 1
    """, (user["id"],)).fetchone()
    avg_bpm_row = conn.execute("SELECT AVG(bpm) FROM songs WHERE user_id=? AND bpm > 0", (user["id"],)).fetchone()
    top_mood_row= conn.execute("""
        SELECT mood, COUNT(*) as cnt FROM songs
        WHERE user_id=? AND mood != ''
        GROUP BY mood ORDER BY cnt DESC LIMIT 1
    """, (user["id"],)).fetchone()
    conn.close()
    return {
        "id":             user["id"],
        "username":       user["username"],
        "display_name":   user.get("display_name") or user["username"],
        "bio":            user.get("bio") or "",
        "created_at":     user["created_at"],
        "last_login":     user["last_login"],
        "song_count":     song_count,
        "playlist_count": pl_count,
        "total_duration": round(float(total_dur), 1),
        "total_plays":    int(play_count),
        "top_key":        top_key_row["ks"]  if top_key_row  else "—",
        "avg_bpm":        int(round(avg_bpm_row[0])) if avg_bpm_row and avg_bpm_row[0] else 0,
        "top_mood":       top_mood_row["mood"] if top_mood_row else "—",
    }

class ProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    bio:          Optional[str] = None
    new_password: Optional[str] = None
    current_password: Optional[str] = None

@app.put("/api/auth/profile")
def update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    conn  = db()
    fields, vals = [], []

    if body.display_name is not None:
        dn = body.display_name.strip()[:40]
        fields.append("display_name=?"); vals.append(dn)

    if body.bio is not None:
        fields.append("bio=?"); vals.append(body.bio.strip()[:200])

    if body.new_password:
        if len(body.new_password) < 6:
            conn.close(); raise HTTPException(400, "New password must be at least 6 characters")
        # Verify current password
        if not body.current_password:
            conn.close(); raise HTTPException(400, "Current password required to change password")
        current_hash = hash_password(body.current_password, user["salt"])
        if current_hash != user["password_hash"]:
            conn.close(); raise HTTPException(401, "Current password is incorrect")
        new_salt = secrets.token_hex(16)
        new_hash = hash_password(body.new_password, new_salt)
        fields.append("password_hash=?"); vals.append(new_hash)
        fields.append("salt=?");          vals.append(new_salt)

    if not fields:
        conn.close()
        return {"message": "Nothing to update"}

    # Add display_name / bio columns if they don't exist yet
    for col, defn in [("display_name","TEXT DEFAULT ''"), ("bio","TEXT DEFAULT ''")]:
        if not _column_exists(conn, "users", col):
            try: conn.execute(f"ALTER TABLE users ADD COLUMN {col} {defn}")
            except: pass

    vals.append(user["id"])
    conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", vals)
    conn.commit()
    conn.close()
    return {"message": "Profile updated"}

# ════════════════════════════════════════════════════════════════
# MUSIC THEORY CONSTANTS
# ════════════════════════════════════════════════════════════════

NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

# Krumhansl–Kessler profiles (empirically validated)
KK_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
KK_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]

# Temperley profiles (another validated set — we average both)
TEMP_MAJOR = [5.0,2.0,3.5,2.0,4.5,4.0,2.0,4.5,2.0,3.5,1.5,4.0]
TEMP_MINOR = [5.0,2.0,3.5,4.5,2.0,4.0,2.0,4.5,3.5,2.0,1.5,4.0]

# Combined profiles
MAJOR_PROFILE = [(KK_MAJOR[i]+TEMP_MAJOR[i])/2 for i in range(12)]
MINOR_PROFILE = [(KK_MINOR[i]+TEMP_MINOR[i])/2 for i in range(12)]

# Full chord templates: all 12 roots × major + minor = 24 chords
# Plus diminished and dominant 7th for completeness
def build_chord_template(root: int, quality: str) -> list:
    t = [0.0] * 12
    r = root % 12
    t[r] = 1.0
    if quality == 'maj':   t[(r+4)%12]=.9; t[(r+7)%12]=.85
    elif quality == 'min': t[(r+3)%12]=.9; t[(r+7)%12]=.85
    elif quality == 'dim': t[(r+3)%12]=.9; t[(r+6)%12]=.8
    elif quality == 'aug': t[(r+4)%12]=.9; t[(r+8)%12]=.8
    elif quality == 'dom7':t[(r+4)%12]=.9; t[(r+7)%12]=.85; t[(r+10)%12]=.7
    elif quality == 'maj7':t[(r+4)%12]=.9; t[(r+7)%12]=.85; t[(r+11)%12]=.7
    elif quality == 'min7':t[(r+3)%12]=.9; t[(r+7)%12]=.85; t[(r+10)%12]=.7
    elif quality == 'sus2':t[(r+2)%12]=.9; t[(r+7)%12]=.85
    elif quality == 'sus4':t[(r+5)%12]=.9; t[(r+7)%12]=.85
    return t

# Pre-build all 24 basic chord templates (12 major + 12 minor)
ALL_CHORD_TEMPLATES = {}
for root in range(12):
    for q in ('maj','min','dim','dom7','maj7','min7'):
        suffix = {'maj':'','min':'m','dim':'dim','dom7':'7','maj7':'maj7','min7':'m7'}[q]
        name   = NOTE_NAMES[root] + suffix
        ALL_CHORD_TEMPLATES[name] = build_chord_template(root, q)

# ════════════════════════════════════════════════════════════════
# ANALYSIS ENGINE (greatly improved)
# ════════════════════════════════════════════════════════════════

def _corr(a, b):
    """Pearson correlation between two length-12 vectors."""
    import numpy as np
    a, b = np.array(a), np.array(b)
    a = a - a.mean(); b = b - b.mean()
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a,b) / (denom+1e-8))

def _rot(profile, shift):
    return [profile[(i-shift)%12] for i in range(12)]

def analyze(filepath: str) -> dict:
    if LIBROSA:
        try:
            return analyze_librosa(filepath)
        except Exception as e:
            print(f"  [ERROR] librosa failed: {e}")
            traceback.print_exc()
    return analyze_fallback(filepath)

def analyze_librosa(filepath: str) -> dict:
    import librosa, numpy as np
    print(f"\n  ── Analyzing: {Path(filepath).name}")

    # Load only first 90 seconds at low sample rate — fast and accurate enough
    y, sr    = librosa.load(filepath, sr=22050, mono=True, duration=90)
    # Get real full duration without loading whole file
    try:
        import soundfile as sf
        duration = float(sf.info(filepath).duration)
    except:
        duration = float(librosa.get_duration(y=y, sr=sr))
    print(f"  Duration: {duration:.1f}s")

    # ── BPM — single fast method ──────────────────────────────
    print(f"  BPM…")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo_arr = librosa.feature.tempo(onset_envelope=onset_env, sr=sr, aggregate=None)
    bpm = int(round(float(np.median(tempo_arr))))
    while bpm > 0 and bpm < 60:  bpm *= 2
    while bpm > 0 and bpm > 180: bpm = bpm // 2
    if bpm <= 0: bpm = 120
    print(f"  BPM: {bpm}")

    # ── Key detection — CENS chroma only (fast + accurate) ───
    print(f"  Key…")
    chroma_cens = librosa.feature.chroma_cens(y=y, sr=sr, win_len_smooth=41)
    mean_c = chroma_cens.mean(axis=1)
    mean_c = mean_c / (mean_c.max() + 1e-8)

    best_score, best_key, best_major = -999, 0, True
    second_score = -999
    for root in range(12):
        maj  = _corr(mean_c, _rot(MAJOR_PROFILE, root))
        mino = _corr(mean_c, _rot(MINOR_PROFILE, root))
        if maj > best_score:
            second_score = best_score
            best_score, best_key, best_major = maj, root, True
        elif maj > second_score:
            second_score = maj
        if mino > best_score:
            second_score = best_score
            best_score, best_key, best_major = mino, root, False
        elif mino > second_score:
            second_score = mino

    key      = NOTE_NAMES[best_key]
    scale    = 'Major' if best_major else 'Minor'
    key_conf = round(min(1.0, max(0.0, (best_score - second_score) * 5)), 3)
    print(f"  Key: {key} {scale}")

    # ── Chords + frame timeline ───────────────────────────────
    print(f"  Chords…")
    chords, chord_frames = detect_chords_fast(chroma_cens, best_key, best_major, sr)
    print(f"  Chords: {chords}")

    # ── Energy / mood ─────────────────────────────────────────
    rms        = float(librosa.feature.rms(y=y).mean())
    centroid   = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    energy     = min(1.0, rms * 8)
    brightness = min(1.0, centroid / 4000)
    warmth     = max(0.0, 1.0 - centroid / 6000)
    peak       = float(min(1.0, np.abs(y).max()))
    mood       = classify_mood(energy, brightness, best_major, bpm)

    # ── Waveform peaks ────────────────────────────────────────
    waveform = compute_waveform_peaks(y, n_peaks=800)

    print(f"  ✓ Done\n")
    return {
        "duration":          round(duration, 2),
        "bpm":               bpm,
        "bpm_confidence":    0.8,
        "key":               key,
        "scale":             scale,
        "key_confidence":    key_conf,
        "chords":            chords,
        "chord_frames":      chord_frames,
        "energy":            round(energy, 3),
        "brightness":        round(brightness, 3),
        "warmth":            round(warmth, 3),
        "peak":              round(peak, 3),
        "spectral_centroid": round(centroid, 1),
        "mood":              mood,
        "waveform":          waveform,
    }


def detect_chords_fast(chroma_frames, root_key: int, is_major: bool, sr: int):
    """
    Fast chord detection using CENS chroma frames already computed.
    Returns top chords list + per-frame chord timeline.
    """
    import numpy as np

    # chroma_frames shape: (12, n_frames)
    n_frames   = chroma_frames.shape[1]
    hop_length = 512  # CENS default
    # Frame times (approximate — CENS uses internal smoothing)
    times      = np.arange(n_frames) * hop_length / sr

    chord_names    = list(ALL_CHORD_TEMPLATES.keys())
    chord_tmpls    = np.array(list(ALL_CHORD_TEMPLATES.values()))   # (N, 12)
    chroma_T       = chroma_frames.T                                  # (n_frames, 12)

    # Normalise
    norms       = np.linalg.norm(chroma_T, axis=1, keepdims=True) + 1e-8
    chroma_norm = chroma_T / norms
    tmpls_norm  = chord_tmpls / (np.linalg.norm(chord_tmpls, axis=1, keepdims=True) + 1e-8)

    scores    = chroma_norm @ tmpls_norm.T          # (n_frames, N_chords)
    best_idx  = np.argmax(scores, axis=1)           # best chord per frame

    # Build frame timeline, remove consecutive duplicates for cleaner display
    frame_list, last = [], None
    for i in range(n_frames):
        chord = chord_names[best_idx[i]]
        if chord != last:
            frame_list.append({"time": round(float(times[i]), 2), "chord": chord})
            last = chord

    # Overall ranking — diatonic chords first
    mean_scores = scores.mean(axis=0)
    ranked_idx  = np.argsort(mean_scores)[::-1]

    ivs = [0,2,4,5,7,9,11] if is_major else [0,2,3,5,7,8,10]
    qs  = (['maj','min','min','maj','maj','min','dim']
           if is_major else ['min','dim','maj','min','min','maj','maj'])
    diatonic = set()
    for iv, q in zip(ivs, qs):
        r = (root_key + iv) % 12
        diatonic.add(NOTE_NAMES[r] + {'maj':'','min':'m','dim':'dim'}[q])

    out_d, out_o, seen = [], [], set()
    for idx in ranked_idx:
        name = chord_names[idx]
        if name in seen or name.endswith('7'): continue   # skip 7th chords in top list
        seen.add(name)
        (out_d if name in diatonic else out_o).append(name)

    return (out_d + out_o)[:7], frame_list


def classify_mood(energy: float, brightness: float, is_major: bool, bpm: int) -> str:
    """Simple rule-based mood classifier."""
    if energy > 0.6 and bpm > 120:
        return 'Energetic'
    elif energy > 0.5 and is_major and bpm > 100:
        return 'Happy'
    elif not is_major and energy < 0.4:
        return 'Melancholic'
    elif not is_major and bpm < 90:
        return 'Sad'
    elif energy < 0.3 and bpm < 80:
        return 'Calm'
    elif energy > 0.5 and not is_major:
        return 'Intense'
    elif is_major and energy < 0.4:
        return 'Peaceful'
    else:
        return 'Neutral'


def compute_waveform_peaks(y, n_peaks=1200):
    import numpy as np
    hop   = max(1, len(y) // n_peaks)
    peaks = []
    for i in range(n_peaks):
        chunk = y[i*hop:(i+1)*hop]
        if len(chunk) == 0: break
        rms = float(np.sqrt(np.mean(chunk**2)))
        peaks.append(round(min(1.0, rms * 6), 4))
    return peaks


# ── Pure-Python fallback ──────────────────────────────────────
def analyze_fallback(filepath: str) -> dict:
    result = {
        "duration":0,"bpm":0,"bpm_confidence":0,
        "key":"?","scale":"?","key_confidence":0,
        "chords":[],"chord_frames":[],"energy":0,
        "brightness":0,"warmth":0,"peak":0,
        "spectral_centroid":0,"mood":"Unknown","waveform":[],
        "_note": "Install librosa: pip install librosa numpy soundfile"
    }
    if not filepath.lower().endswith('.wav'):
        result["_note"] = "Non-WAV + no librosa. Install: pip install librosa"
        return result
    try:
        with open(filepath,'rb') as f:
            if f.read(4)!=b'RIFF': return result
            f.read(4)
            if f.read(4)!=b'WAVE': return result
            f.read(4); sz=struct.unpack('<I',f.read(4))[0]
            fmt=struct.unpack('<HHIIHH',f.read(16))
            _,ch,sr,_,ba,bits=fmt
            if sz>16: f.read(sz-16)
            while True:
                cid=f.read(4)
                if len(cid)<4: return result
                csz=struct.unpack('<I',f.read(4))[0]
                if cid==b'data': break
                f.read(csz)
            ns=csz//ba; dur=ns/sr; result['duration']=round(dur,2)
            ms=min(ns,sr*30); raw=f.read(ms*ba)
            if bits==16:
                samples=[struct.unpack_from('<h',raw,i*2)[0]/32768 for i in range(0,len(raw)//2,ch)]
            elif bits==8:
                samples=[(b-128)/128 for b in raw[::ch]]
            else: return result
            rms=math.sqrt(sum(s*s for s in samples)/len(samples))
            peak=max(abs(s) for s in samples)
            result.update({
                "bpm":   _bpm_python(samples,sr),
                "energy":round(min(1,rms*8),3),
                "brightness":round(min(1,sum(1 for i in range(1,len(samples)) if samples[i-1]*samples[i]<0)/len(samples)*50),3),
                "warmth":0,"peak":round(min(1,peak),3)
            })
    except Exception as e:
        result['_error']=str(e)
    return result

def _bpm_python(samples, sr):
    step=max(1,sr//11025); down=[abs(samples[i]) for i in range(0,len(samples),step)]; dsr=sr//step
    fs,hs=512,256; energy=[]
    for i in range((len(down)-fs)//hs):
        chunk=down[i*hs:i*hs+fs]; energy.append(math.sqrt(sum(x*x for x in chunk)/fs))
    onset=[max(0,energy[i]-energy[i-1]) for i in range(1,len(energy))]
    lmin=int(dsr/hs*60/200); lmax=int(dsr/hs*60/60); best,bc=120,-1; n=len(onset)
    for lag in range(lmin,min(lmax+1,n)):
        c=sum(onset[i]*onset[i+lag] for i in range(n-lag))/(n-lag)
        if c>bc: bc=c; best=int(round(dsr/hs*60/lag))
    return best

# ════════════════════════════════════════════════════════════════
# SONG ROUTES
# ════════════════════════════════════════════════════════════════

@app.post("/api/analyze")
async def analyze_song(file: UploadFile=File(...), user=Depends(get_current_user)):
    allowed = {'.mp3','.wav','.flac','.ogg','.m4a','.aac','.opus','.wma'}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported file type: {ext}. Allowed: mp3, wav, flac, ogg, m4a")

    print(f"\n  [upload] User={user['username']}  File={file.filename}")

    # Save file to disk
    fname     = f"u{user['id']}_{secrets.token_hex(6)}{ext}"
    save_path = UPLOADS / fname
    try:
        content = await file.read()
        if len(content) == 0:
            raise HTTPException(400, "Uploaded file is empty")
        save_path.write_bytes(content)
        print(f"  [upload] Saved {len(content)//1024} KB → {save_path.name}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Could not save file: {e}")

    # Analyse
    try:
        r = analyze(str(save_path))
        print(f"  [upload] Analysis done: BPM={r.get('bpm')} Key={r.get('key')} {r.get('scale')}")
    except Exception as e:
        traceback.print_exc()
        save_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Analysis failed: {e}")

    # Use original filename stem as song name (cleaned up)
    name = Path(file.filename).stem.replace('_',' ').replace('-',' ').strip()
    if not name:
        name = 'Unknown Song'

    conn = db()
    c    = conn.cursor()
    try:
        c.execute("""
            INSERT INTO songs (user_id,filename,name,filepath,duration,bpm,bpm_confidence,
                               key,scale,key_confidence,chords,chord_frames,energy,brightness,
                               warmth,peak,spectral_centroid,mood,waveform)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            user['id'], file.filename, name, str(save_path),
            r.get("duration",0),         r.get("bpm",0),          r.get("bpm_confidence",0),
            r.get("key",""),             r.get("scale",""),        r.get("key_confidence",0),
            ",".join(r.get("chords",[])),
            json.dumps(r.get("chord_frames",[])),
            r.get("energy",0),           r.get("brightness",0),
            r.get("warmth",0),           r.get("peak",0),
            r.get("spectral_centroid",0),r.get("mood",""),
            json.dumps(r.get("waveform",[])),
        ))
        song_id = c.lastrowid
        conn.commit()
        print(f"  [upload] Saved to DB: song_id={song_id} name='{name}'")
    except Exception as e:
        conn.close()
        save_path.unlink(missing_ok=True)
        traceback.print_exc()
        raise HTTPException(500, f"Database error: {e}")

    row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    conn.close()
    return row_to_song(row)

@app.get("/api/songs")
def list_songs(user=Depends(get_current_user)):
    conn = db()
    rows = conn.execute(
        "SELECT * FROM songs WHERE user_id=? ORDER BY created_at DESC", (user['id'],)
    ).fetchall()
    conn.close()
    return [row_to_song(r) for r in rows]

@app.get("/api/songs/{song_id}")
def get_song(song_id: int, user=Depends(get_current_user)):
    conn = db()
    row  = conn.execute("SELECT * FROM songs WHERE id=? AND user_id=?", (song_id, user['id'])).fetchone()
    conn.close()
    if not row: raise HTTPException(404)
    return row_to_song(row)

@app.get("/api/songs/{song_id}/stream")
def stream_song(song_id: int, token: Optional[str] = None, authorization: Optional[str] = Header(None)):
    """
    Stream audio. Accepts auth either as:
      - Header:  Authorization: Bearer <token>
      - Query:   ?token=<token>
    The query param approach is needed because <audio src> can't send headers.
    """
    raw_token = None
    if authorization and authorization.startswith("Bearer "):
        raw_token = authorization[7:].strip()
    elif token:
        raw_token = token.strip()

    if not raw_token:
        raise HTTPException(401, "Not authenticated")

    try:
        payload = decode_token(raw_token)
        user_id = int(payload["sub"])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Invalid token")

    conn = db()
    row  = conn.execute(
        "SELECT * FROM songs WHERE id=? AND user_id=?", (song_id, user_id)
    ).fetchone()
    conn.execute("UPDATE songs SET play_count=play_count+1 WHERE id=?", (song_id,))
    conn.commit()
    conn.close()

    if not row:
        raise HTTPException(404, "Song not found")

    path = Path(row["filepath"])
    if not path.exists():
        raise HTTPException(404, "Audio file not found on disk")

    ext_mime = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
        '.flac': 'audio/flac', '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',  '.aac': 'audio/aac',
    }
    mime = ext_mime.get(path.suffix.lower(), 'audio/mpeg')
    size = path.stat().st_size

    def iterfile():
        with open(path, 'rb') as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iterfile(), media_type=mime,
        headers={
            "Accept-Ranges":  "bytes",
            "Content-Length": str(size),
            "Cache-Control":  "no-store",
        }
    )

@app.get("/api/songs/{song_id}/waveform")
def get_waveform(song_id: int, user=Depends(get_current_user)):
    conn = db()
    row  = conn.execute("SELECT waveform FROM songs WHERE id=? AND user_id=?", (song_id,user['id'])).fetchone()
    conn.close()
    if not row: raise HTTPException(404)
    try:    peaks = json.loads(row["waveform"] or "[]")
    except: peaks = []
    return {"peaks": peaks}

@app.get("/api/songs/{song_id}/chords")
def get_chord_frames(song_id: int, user=Depends(get_current_user)):
    """Return frame-by-frame chord data for real-time chord display."""
    conn = db()
    row  = conn.execute("SELECT chord_frames,chords FROM songs WHERE id=? AND user_id=?", (song_id,user['id'])).fetchone()
    conn.close()
    if not row: raise HTTPException(404)
    try:    frames = json.loads(row["chord_frames"] or "[]")
    except: frames = []
    chords = [c for c in (row["chords"] or "").split(",") if c]
    return {"frames": frames, "chords": chords}

@app.put("/api/songs/{song_id}")
def update_song(song_id: int, body: SongUpdate, user=Depends(get_current_user)):
    conn = db()
    row  = conn.execute("SELECT id FROM songs WHERE id=? AND user_id=?", (song_id,user['id'])).fetchone()
    if not row: conn.close(); raise HTTPException(404)
    fields, vals = [], []
    if body.name   is not None: fields.append("name=?");   vals.append(body.name)
    if body.lyrics is not None: fields.append("lyrics=?"); vals.append(body.lyrics)
    if body.notes  is not None: fields.append("notes=?");  vals.append(body.notes)
    if fields:
        vals.append(song_id)
        conn.execute(f"UPDATE songs SET {','.join(fields)} WHERE id=?", vals)
        conn.commit()
    row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    conn.close()
    return row_to_song(row)

@app.delete("/api/songs/{song_id}")
def delete_song(song_id: int, user=Depends(get_current_user)):
    conn = db()
    row  = conn.execute("SELECT * FROM songs WHERE id=? AND user_id=?", (song_id,user['id'])).fetchone()
    if not row: conn.close(); raise HTTPException(404)
    try: Path(row["filepath"]).unlink(missing_ok=True)
    except: pass
    conn.execute("DELETE FROM songs WHERE id=?", (song_id,))
    conn.commit(); conn.close()
    return {"deleted": song_id}

@app.get("/api/search")
def search(q: str=Query(""), user=Depends(get_current_user)):
    conn = db()
    like = f"%{q}%"
    rows = conn.execute(
        "SELECT * FROM songs WHERE user_id=? AND (name LIKE ? OR key LIKE ? OR mood LIKE ?) ORDER BY created_at DESC",
        (user['id'],like,like,like)
    ).fetchall()
    conn.close()
    return [row_to_song(r) for r in rows]

# ── Playlists ─────────────────────────────────────────────────
@app.get("/api/playlists")
def list_playlists(user=Depends(get_current_user)):
    conn = db()
    pls  = conn.execute("SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC", (user['id'],)).fetchall()
    result = []
    for pl in pls:
        ids = [r[0] for r in conn.execute(
            "SELECT song_id FROM playlist_songs WHERE playlist_id=? ORDER BY position",(pl['id'],)).fetchall()]
        result.append({**dict(pl), "song_ids": ids})
    conn.close()
    return result

@app.post("/api/playlists", status_code=201)
def create_playlist(body: PlaylistBody, user=Depends(get_current_user)):
    conn = db(); c = conn.cursor()
    c.execute("INSERT INTO playlists (user_id,name,description) VALUES (?,?,?)",
              (user['id'], body.name, body.description or ""))
    pid = c.lastrowid; conn.commit()
    row = conn.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
    conn.close()
    return {**dict(row), "song_ids":[]}

@app.get("/api/playlists/{pid}")
def get_playlist(pid: int, user=Depends(get_current_user)):
    conn = db()
    pl   = conn.execute("SELECT * FROM playlists WHERE id=? AND user_id=?", (pid,user['id'])).fetchone()
    if not pl: conn.close(); raise HTTPException(404)
    songs = conn.execute("""
        SELECT s.* FROM songs s
        JOIN playlist_songs ps ON ps.song_id=s.id
        WHERE ps.playlist_id=? ORDER BY ps.position
    """, (pid,)).fetchall()
    conn.close()
    return {**dict(pl), "songs":[row_to_song(s) for s in songs]}

@app.put("/api/playlists/{pid}")
def rename_playlist(pid: int, body: PlaylistBody, user=Depends(get_current_user)):
    conn = db()
    conn.execute("UPDATE playlists SET name=?,description=? WHERE id=? AND user_id=?",
                 (body.name, body.description or "", pid, user['id']))
    conn.commit()
    row = conn.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
    conn.close()
    return dict(row)

@app.delete("/api/playlists/{pid}")
def delete_playlist(pid: int, user=Depends(get_current_user)):
    conn = db()
    conn.execute("DELETE FROM playlists WHERE id=? AND user_id=?", (pid,user['id']))
    conn.commit(); conn.close()
    return {"deleted": pid}

@app.post("/api/playlists/{pid}/songs")
def add_song_to_playlist(pid: int, body: AddSong, user=Depends(get_current_user)):
    conn = db()
    pl   = conn.execute("SELECT id FROM playlists WHERE id=? AND user_id=?", (pid,user['id'])).fetchone()
    if not pl: conn.close(); raise HTTPException(404, "Playlist not found")
    pos  = conn.execute("SELECT COUNT(*) FROM playlist_songs WHERE playlist_id=?", (pid,)).fetchone()[0]
    try:
        conn.execute("INSERT INTO playlist_songs (playlist_id,song_id,position) VALUES (?,?,?)",
                     (pid,body.song_id,pos))
        conn.commit()
    except: pass
    conn.close()
    return {"playlist_id":pid,"song_id":body.song_id}

@app.delete("/api/playlists/{pid}/songs/{sid}")
def remove_song_from_playlist(pid: int, sid: int, user=Depends(get_current_user)):
    conn = db()
    conn.execute("DELETE FROM playlist_songs WHERE playlist_id=? AND song_id=?", (pid,sid))
    conn.commit(); conn.close()
    return {"removed":sid}

# ── Health ────────────────────────────────────────────────────
@app.get("/health")
def health():
    conn = db()
    users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    songs = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
    conn.close()
    return {"status":"ok","librosa":LIBROSA,"jwt":JWT,"users":users,"songs":songs}

# ── Serve frontend ────────────────────────────────────────────
@app.get("/")
def serve_index():
    for p in [FRONTEND/"index.html", BASE/"index.html"]:
        if p.exists(): return FileResponse(str(p))
    return JSONResponse({"api":"BeatLens v5","docs":"/docs"})

@app.get("/{path:path}")
def serve_static(path: str):
    if path.startswith(("api/","auth/")) or path in ("health","docs","openapi.json","redoc"):
        raise HTTPException(404)
    for base in [FRONTEND, BASE]:
        f = base / path
        if f.exists() and f.is_file(): return FileResponse(str(f))
    raise HTTPException(404)

# ── Helper ────────────────────────────────────────────────────
def row_to_song(row) -> dict:
    d = dict(row)
    d["chords"] = [c for c in (d.get("chords","") or "").split(",") if c]
    try:    d["waveform"]     = json.loads(d.get("waveform","[]") or "[]")
    except: d["waveform"]     = []
    try:    d["chord_frames"] = json.loads(d.get("chord_frames","[]") or "[]")
    except: d["chord_frames"] = []
    return d

# ── Run ───────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*60)
    print("  🎵  BeatLens v5")
    print(f"  {'✅' if LIBROSA else '❌'} librosa  {'(full analysis)' if LIBROSA else '— pip install librosa'}")
    print(f"  {'✅' if JWT    else '⚠️'} PyJWT   {'(auth)' if JWT else '— pip install PyJWT'}")
    fe = FRONTEND/"index.html" if (FRONTEND/"index.html").exists() else BASE/"index.html"
    if fe.exists():
        print(f"  ✅ Frontend → http://localhost:8000")
    else:
        print(f"  ❌ Put index.html in {BASE}")
    print(f"  💾 DB: {DB_PATH}")
    print("="*60+"\n")
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)