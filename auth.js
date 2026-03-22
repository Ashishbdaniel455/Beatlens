/* ============================================================
   BeatLens v5 — auth.js
   · JWT auth (redirects to login if not logged in)
   · Patches api() to include Authorization header
   · Adds user menu to header
   · Real-time chord detector (live chroma analysis)
   · Shows chord frames from server analysis
   LOAD THIS BEFORE app.js in index.html
   ============================================================ */
'use strict';

const API = 'http://localhost:8000';
function esc(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Auto-detect API URL:
// · On Render / any cloud host  → same origin (no localhost)
// · Local dev                   → http://localhost:8000
const _isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _apiBase = _isLocal ? 'http://localhost:8000' : window.location.origin;
// Override API with the auto-detected value
// (auth.js loads before app.js so this will be the value both files use)
Object.defineProperty(window, 'API', {
  get: () => _apiBase,
  configurable: true,
});

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

function getToken()    { return localStorage.getItem('bl_token'); }
function getUsername() { return localStorage.getItem('bl_username') || 'User'; }

// Redirect to login if not authenticated
if (!getToken()) { window.location.href = 'login.html'; }

// Authenticated API helper — overwrites the one in app.js
async function api(method, path, body) {
  const token = getToken();
  const opts  = { method, headers: { 'Authorization': 'Bearer ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(API + path, opts);
  if (r.status === 401) { logout(); return; }
  if (!r.ok) { const e = await r.text(); throw new Error(e); }
  return r.json();
}

function logout() {
  localStorage.removeItem('bl_token');
  localStorage.removeItem('bl_username');
  localStorage.removeItem('bl_user_id');
  window.location.href = 'login.html';
}

// ── Inject user menu into sidebar ────────────────────────────
function injectUserMenu() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || document.getElementById('userMenu')) return;

  const menu = document.createElement('div');
  menu.id = 'userMenu';
  menu.style.cssText = `
    display:flex;align-items:center;gap:10px;padding:12px 14px;
    border-top:1px solid var(--border);margin-top:auto;flex-shrink:0;
    background:var(--bg2);cursor:pointer;transition:.2s;
  `;
  menu.onmouseenter = () => menu.style.background = 'var(--surface)';
  menu.onmouseleave = () => menu.style.background = 'var(--bg2)';
  menu.onclick      = openProfileModal;

  const letter = getUsername().charAt(0).toUpperCase();
  menu.innerHTML = `
    <div id="userAvatar" style="width:36px;height:36px;border-radius:50%;
      background:linear-gradient(135deg,var(--accent3),var(--accent2));
      display:flex;align-items:center;justify-content:center;
      font-family:var(--mono);font-size:.85rem;font-weight:700;
      color:#fff;flex-shrink:0;box-shadow:0 0 12px rgba(123,92,255,.3)">
      ${letter}
    </div>
    <div style="flex:1;min-width:0">
      <div id="userDisplayName" style="font-size:.82rem;font-weight:700;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${getUsername()}
      </div>
      <div style="font-family:var(--mono);font-size:.6rem;color:var(--accent);
        display:flex;align-items:center;gap:4px">
        <span style="width:5px;height:5px;border-radius:50%;background:var(--accent);display:inline-block"></span>
        View profile
      </div>
    </div>
    <div style="color:var(--text3);font-size:.7rem">›</div>
  `;
  sidebar.appendChild(menu);
}

// ═══════════════════════════════════════════════════════════════
// PROFILE MODAL
// ═══════════════════════════════════════════════════════════════

async function openProfileModal() {
  // Remove existing
  document.getElementById('profileModal')?.remove();

  // Show loading state
  const overlay = document.createElement('div');
  overlay.id = 'profileModal';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(10,10,15,.88);
    backdrop-filter:blur(10px);z-index:2000;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  overlay.onclick = e => { if(e.target===overlay) closeProfileModal(); };
  overlay.innerHTML = `
    <div style="width:52px;height:52px;border:3px solid var(--border);
      border-top-color:var(--accent);border-radius:50%;
      animation:spin .8s linear infinite;margin:auto"></div>
  `;
  document.body.appendChild(overlay);

  // Fetch profile data
  let profile = null;
  try {
    profile = await api('GET', '/api/auth/me');
  } catch(e) {
    overlay.remove();
    showToastMsg('Could not load profile', 'error');
    return;
  }

  const joined   = profile.created_at ? new Date(profile.created_at).toLocaleDateString('en-US', {month:'long',year:'numeric'}) : '—';
  const lastSeen = profile.last_login  ? timeAgoStr(profile.last_login) : 'Never';
  const totalMin = Math.floor((profile.total_duration||0) / 60);
  const totalH   = Math.floor(totalMin / 60);
  const durLabel = totalH > 0 ? `${totalH}h ${totalMin%60}m` : `${totalMin}m`;
  const letter   = (profile.display_name||profile.username).charAt(0).toUpperCase();

  overlay.innerHTML = `
  <div id="profileBox" style="
    background:var(--surface);border:1px solid var(--border);
    border-radius:20px;width:100%;max-width:520px;max-height:90vh;
    display:flex;flex-direction:column;
    box-shadow:0 32px 80px rgba(0,0,0,.6);
    animation:modalIn .22s cubic-bezier(.4,0,.2,1);overflow:hidden;
  ">

    <!-- Hero banner -->
    <div style="height:96px;background:linear-gradient(135deg,rgba(123,92,255,.4) 0%,rgba(0,245,196,.2) 100%);
      position:relative;flex-shrink:0">
      <button onclick="closeProfileModal()" style="
        position:absolute;top:12px;right:12px;
        background:rgba(10,10,15,.6);border:1px solid rgba(255,255,255,.1);
        color:#fff;width:28px;height:28px;border-radius:8px;
        cursor:pointer;font-size:.8rem;display:flex;align-items:center;justify-content:center;
        transition:.15s" onmouseover="this.style.background='rgba(255,64,129,.3)'"
        onmouseout="this.style.background='rgba(10,10,15,.6)'">✕</button>
    </div>

    <!-- Scrollable body -->
    <div style="overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:var(--border) transparent">

      <!-- Avatar + name row -->
      <div style="padding:0 24px 20px;position:relative">
        <div style="width:72px;height:72px;border-radius:50%;
          background:linear-gradient(135deg,var(--accent3),var(--accent2));
          display:flex;align-items:center;justify-content:center;
          font-family:var(--mono);font-size:1.6rem;font-weight:700;color:#fff;
          border:3px solid var(--surface);
          position:absolute;top:-36px;left:24px;
          box-shadow:0 0 24px rgba(123,92,255,.4)">
          ${letter}
        </div>
        <div style="padding-top:44px">
          <div style="font-size:1.25rem;font-weight:800;letter-spacing:-.3px" id="pdDisplayName">
            ${esc(profile.display_name || profile.username)}
          </div>
          <div style="font-family:var(--mono);font-size:.7rem;color:var(--text3);margin-top:2px">
            @${esc(profile.username)} · Joined ${joined}
          </div>
          <div style="font-family:var(--mono);font-size:.68rem;color:var(--text3);margin-top:3px" id="pdBio">
            ${esc(profile.bio || 'No bio yet')}
          </div>
        </div>
      </div>

      <!-- Stats row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
        background:var(--border);margin:0 24px 20px;border-radius:12px;overflow:hidden">
        ${[
          ['🎵', profile.song_count||0,    'Songs'],
          ['📂', profile.playlist_count||0,'Playlists'],
          ['⏱',  durLabel,                  'Listened'],
          ['▶',  profile.total_plays||0,   'Plays'],
        ].map(([icon,val,label]) => `
          <div style="background:var(--surface2);padding:14px 10px;text-align:center">
            <div style="font-size:1.1rem;margin-bottom:4px">${icon}</div>
            <div style="font-size:1rem;font-weight:800;font-family:var(--mono);color:var(--accent)">${val}</div>
            <div style="font-size:.6rem;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;font-family:var(--mono)">${label}</div>
          </div>`).join('')}
      </div>

      <!-- Taste stats -->
      <div style="margin:0 24px 20px;background:var(--surface2);border:1px solid var(--border);
        border-radius:12px;padding:14px 16px">
        <div style="font-family:var(--mono);font-size:.58rem;font-weight:700;letter-spacing:.12em;
          color:var(--text3);text-transform:uppercase;margin-bottom:10px">Music Taste</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          ${[
            ['🎹 Top Key',  profile.top_key||'—'],
            ['🥁 Avg BPM',  profile.avg_bpm ? profile.avg_bpm + ' BPM' : '—'],
            ['🎭 Top Mood', profile.top_mood||'—'],
            ['🕐 Last seen', lastSeen],
          ].map(([label,val])=>`
            <div>
              <div style="font-family:var(--mono);font-size:.6rem;color:var(--text3)">${label}</div>
              <div style="font-family:var(--mono);font-size:.8rem;font-weight:700;color:var(--text);margin-top:2px">${val}</div>
            </div>`).join('')}
        </div>
      </div>

      <!-- Tab switcher -->
      <div style="display:flex;gap:0;margin:0 24px 16px;background:var(--surface2);
        border:1px solid var(--border);border-radius:10px;padding:4px;gap:4px">
        <button class="ptab active" id="ptabEdit"    onclick="pTab('edit',this)"    style="${ptabStyle()}">Edit Profile</button>
        <button class="ptab"        id="ptabSecurity" onclick="pTab('security',this)" style="${ptabStyle()}">Security</button>
        <button class="ptab"        id="ptabDanger"   onclick="pTab('danger',this)"   style="${ptabStyle()}">Danger Zone</button>
      </div>

      <!-- Edit tab -->
      <div id="ptab-edit" style="padding:0 24px 24px">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="font-family:var(--mono);font-size:.62rem;color:var(--text3);
              text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px">
              Display Name
            </label>
            <input id="pdEditName" value="${esc(profile.display_name || '')}"
              placeholder="${esc(profile.username)}"
              style="${inputStyle()}" maxlength="40"
              oninput="this.style.borderColor='var(--accent)'"
              onblur="this.style.borderColor='var(--border)'"/>
          </div>
          <div>
            <label style="font-family:var(--mono);font-size:.62rem;color:var(--text3);
              text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px">
              Bio <span style="color:var(--text3);font-size:.58rem">(max 200 chars)</span>
            </label>
            <textarea id="pdEditBio" maxlength="200"
              placeholder="Tell people a bit about yourself…"
              style="${inputStyle()};height:80px;resize:none"
              oninput="document.getElementById('pdBioCount').textContent=(200-this.value.length)+' left';
                       this.style.borderColor='var(--accent)'"
              onblur="this.style.borderColor='var(--border)'">${esc(profile.bio||'')}</textarea>
            <div id="pdBioCount" style="font-family:var(--mono);font-size:.6rem;color:var(--text3);text-align:right;margin-top:3px">
              ${200-(profile.bio||'').length} left
            </div>
          </div>
          <div id="pdEditMsg" style="display:none"></div>
          <button onclick="saveProfile()" style="${btnPrimaryStyle()}">
            Save Changes
          </button>
        </div>
      </div>

      <!-- Security tab -->
      <div id="ptab-security" style="padding:0 24px 24px;display:none">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div style="background:var(--surface2);border:1px solid var(--border);
            border-radius:10px;padding:14px">
            <div style="font-family:var(--mono);font-size:.65rem;color:var(--text2);margin-bottom:12px">
              🔐 Change Password
            </div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <div>
                <label style="${labelStyle()}">Current Password</label>
                <div style="position:relative">
                  <input id="pdCurPw" type="password" placeholder="••••••••" style="${inputStyle()}"
                    oninput="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"/>
                  <button onclick="togglePwField('pdCurPw',this)" type="button" style="${pwToggleStyle()}">👁</button>
                </div>
              </div>
              <div>
                <label style="${labelStyle()}">New Password</label>
                <div style="position:relative">
                  <input id="pdNewPw" type="password" placeholder="min 6 characters" style="${inputStyle()}"
                    oninput="checkPwStrengthInline(this.value);this.style.borderColor='var(--accent)'"
                    onblur="this.style.borderColor='var(--border)'"/>
                  <button onclick="togglePwField('pdNewPw',this)" type="button" style="${pwToggleStyle()}">👁</button>
                </div>
                <div id="pdPwBar" style="height:3px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px">
                  <div id="pdPwFill" style="height:100%;width:0;border-radius:3px;transition:.3s"></div>
                </div>
                <div id="pdPwLabel" style="font-family:var(--mono);font-size:.6rem;color:var(--text3);margin-top:3px"></div>
              </div>
              <div>
                <label style="${labelStyle()}">Confirm New Password</label>
                <div style="position:relative">
                  <input id="pdConfPw" type="password" placeholder="repeat new password" style="${inputStyle()}"
                    oninput="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"/>
                  <button onclick="togglePwField('pdConfPw',this)" type="button" style="${pwToggleStyle()}">👁</button>
                </div>
              </div>
            </div>
          </div>
          <div id="pdSecMsg" style="display:none"></div>
          <button onclick="changePassword()" style="${btnPrimaryStyle()}">Update Password</button>

          <!-- Session info -->
          <div style="background:var(--surface2);border:1px solid var(--border);
            border-radius:10px;padding:14px">
            <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3);
              text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">Session</div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:.82rem;font-weight:600">Current session</div>
                <div style="font-family:var(--mono);font-size:.65rem;color:var(--text3)">
                  Active · Expires in 72 hours
                </div>
              </div>
              <button onclick="logout()" style="background:transparent;border:1px solid var(--accent2);
                color:var(--accent2);font-family:var(--mono);font-size:.7rem;
                padding:6px 14px;border-radius:7px;cursor:pointer;transition:.15s"
                onmouseover="this.style.background='rgba(255,64,129,.1)'"
                onmouseout="this.style.background='transparent'">
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Danger Zone tab -->
      <div id="ptab-danger" style="padding:0 24px 24px;display:none">
        <div style="background:rgba(255,64,129,.06);border:1px solid rgba(255,64,129,.3);
          border-radius:12px;padding:18px">
          <div style="font-size:.9rem;font-weight:700;color:var(--accent2);margin-bottom:6px">⚠️ Danger Zone</div>
          <div style="font-family:var(--mono);font-size:.72rem;color:var(--text2);margin-bottom:16px;line-height:1.7">
            These actions are <strong>permanent and irreversible</strong>. Please be certain before proceeding.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="background:var(--surface);border:1px solid var(--border);
              border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:.85rem;font-weight:600">Delete all songs</div>
                <div style="font-family:var(--mono);font-size:.65rem;color:var(--text3)">
                  Remove all ${profile.song_count} songs and their audio files
                </div>
              </div>
              <button onclick="confirmDeleteAllSongs()" style="background:transparent;
                border:1px solid var(--accent2);color:var(--accent2);font-family:var(--mono);
                font-size:.7rem;padding:6px 12px;border-radius:7px;cursor:pointer;white-space:nowrap;
                transition:.15s" onmouseover="this.style.background='rgba(255,64,129,.1)'"
                onmouseout="this.style.background='transparent'">Delete All</button>
            </div>
          </div>
        </div>
      </div>

    </div><!-- /scrollable body -->
  </div>
  `;

  // Inject CSS for tabs
  if (!document.getElementById('profileModalCSS')) {
    const s = document.createElement('style');
    s.id = 'profileModalCSS';
    s.textContent = `
      @keyframes modalIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
      @keyframes spin{to{transform:rotate(360deg)}}
      .ptab{flex:1;padding:8px;border:none;border-radius:7px;background:transparent;
        color:var(--text3);font-family:var(--mono);font-size:.7rem;font-weight:700;
        cursor:pointer;transition:.15s}
      .ptab.active{background:var(--surface);color:var(--accent)}
      .ptab:hover:not(.active){color:var(--text)}
    `;
    document.head.appendChild(s);
  }
}

// ── Profile helper style strings ──────────────────────────────
function ptabStyle() { return 'flex:1;padding:8px;border:none;border-radius:7px;background:transparent;color:var(--text3);font-family:var(--mono);font-size:.7rem;font-weight:700;cursor:pointer;transition:.15s'; }
function inputStyle() { return 'width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:.82rem;padding:10px 12px;border-radius:8px;outline:none;transition:border-color .15s'; }
function labelStyle() { return 'font-family:var(--mono);font-size:.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px'; }
function btnPrimaryStyle() { return 'background:var(--accent);color:#000;border:none;font-family:var(--font,Syne,sans-serif);font-size:.85rem;font-weight:800;padding:11px;border-radius:9px;cursor:pointer;transition:.15s;width:100%'; }
function pwToggleStyle() { return 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text3);cursor:pointer;font-size:.9rem;padding:4px'; }

// ── Tab switch ────────────────────────────────────────────────
function pTab(name, btn) {
  document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['edit','security','danger'].forEach(t => {
    const el = document.getElementById('ptab-' + t);
    if (el) el.style.display = t === name ? '' : 'none';
  });
}

function closeProfileModal() {
  const el = document.getElementById('profileModal');
  if (!el) return;
  const box = el.querySelector('#profileBox');
  if (box) { box.style.animation = 'none'; box.style.opacity = '0'; box.style.transform = 'scale(.95)'; box.style.transition = 'all .18s'; }
  setTimeout(() => el.remove(), 180);
}

// ── Password toggle inside modal ─────────────────────────────
function togglePwField(id, btn) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

// ── Password strength check (inline) ─────────────────────────
function checkPwStrengthInline(pw) {
  const fill  = document.getElementById('pdPwFill');
  const label = document.getElementById('pdPwLabel');
  if (!fill || !label) return;
  let score = 0;
  if (pw.length >= 6)  score++;
  if (pw.length >= 10) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    {pct:0,   color:'transparent', msg:''},
    {pct:20,  color:'#ff4081',     msg:'Very weak'},
    {pct:40,  color:'#ff9800',     msg:'Weak'},
    {pct:60,  color:'#ffb700',     msg:'Fair'},
    {pct:80,  color:'#7b5cff',     msg:'Strong'},
    {pct:100, color:'#00f5c4',     msg:'Very strong 💪'},
  ];
  const lv = levels[Math.min(score, 5)];
  fill.style.width = lv.pct + '%';
  fill.style.background = lv.color;
  label.textContent = pw.length ? lv.msg : '';
}

// ── Save profile (display name + bio) ────────────────────────
async function saveProfile() {
  const name = document.getElementById('pdEditName')?.value?.trim() || '';
  const bio  = document.getElementById('pdEditBio')?.value?.trim()  || '';
  const msg  = document.getElementById('pdEditMsg');

  try {
    await api('PUT', '/api/auth/profile', { display_name: name, bio });
    // Update sidebar display name
    const dn = document.getElementById('userDisplayName');
    if (dn) dn.textContent = name || getUsername();
    const pdName = document.getElementById('pdDisplayName');
    if (pdName) pdName.textContent = name || getUsername();
    const pdBio = document.getElementById('pdBio');
    if (pdBio) pdBio.textContent = bio || 'No bio yet';
    localStorage.setItem('bl_display_name', name);
    showProfileMsg('pdEditMsg', '✓ Profile saved!', true);
  } catch(e) {
    showProfileMsg('pdEditMsg', e.message || 'Save failed', false);
  }
}

// ── Change password ───────────────────────────────────────────
async function changePassword() {
  const cur   = document.getElementById('pdCurPw')?.value  || '';
  const nw    = document.getElementById('pdNewPw')?.value  || '';
  const conf  = document.getElementById('pdConfPw')?.value || '';

  if (!cur)  { showProfileMsg('pdSecMsg', 'Enter your current password', false); return; }
  if (!nw)   { showProfileMsg('pdSecMsg', 'Enter a new password', false);        return; }
  if (nw.length < 6) { showProfileMsg('pdSecMsg', 'New password must be 6+ characters', false); return; }
  if (nw !== conf)   { showProfileMsg('pdSecMsg', 'Passwords do not match', false);               return; }

  try {
    await api('PUT', '/api/auth/profile', { current_password: cur, new_password: nw });
    document.getElementById('pdCurPw').value  = '';
    document.getElementById('pdNewPw').value  = '';
    document.getElementById('pdConfPw').value = '';
    showProfileMsg('pdSecMsg', '✓ Password updated! Please log in again.', true);
    setTimeout(() => logout(), 2500);
  } catch(e) {
    showProfileMsg('pdSecMsg', e.message || 'Failed to update password', false);
  }
}

// ── Delete all songs ──────────────────────────────────────────
async function confirmDeleteAllSongs() {
  if (!confirm('Delete ALL your songs? This cannot be undone.')) return;
  if (!confirm('Are you really sure? All audio files will be permanently deleted.')) return;
  try {
    // Delete one by one
    if (typeof S !== 'undefined' && S.songs) {
      for (const song of [...S.songs]) {
        try { await api('DELETE', '/api/songs/' + song.id); } catch {}
      }
      S.songs = [];
      if (typeof updateUI === 'function') updateUI();
    }
    showToastMsg('All songs deleted', 'warn');
    closeProfileModal();
  } catch(e) {
    showToastMsg('Delete failed: ' + e.message, 'error');
  }
}

// ── Profile message helper ────────────────────────────────────
function showProfileMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display    = 'block';
  el.style.padding    = '10px 14px';
  el.style.borderRadius = '8px';
  el.style.fontFamily = 'var(--mono)';
  el.style.fontSize   = '.75rem';
  el.style.background = ok ? 'rgba(0,245,196,.1)' : 'rgba(255,64,129,.1)';
  el.style.border     = `1px solid ${ok ? 'var(--accent)' : 'var(--accent2)'}`;
  el.style.color      = ok ? 'var(--accent)' : 'var(--accent2)';
  el.textContent      = text;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Relative time helper ──────────────────────────────────────
function timeAgoStr(iso) {
  if (!iso) return 'Never';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7)  return d + ' days ago';
  if (d < 30) return Math.floor(d/7) + ' weeks ago';
  return Math.floor(d/30) + ' months ago';
}

function showToastMsg(msg, type='success') {
  if (typeof showToast === 'function') { showToast(msg, type); return; }
  console.log(type + ':', msg);
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(injectUserMenu, 100);
});

// ═══════════════════════════════════════════════════════════════
// REAL-TIME CHORD DETECTOR
// ═══════════════════════════════════════════════════════════════
//
// Two-track approach:
//   Track A — Server chord frames: pre-computed per-song chord
//             timeline, displayed as the song plays (most accurate)
//   Track B — Live browser chroma: Web Audio API chroma analysis
//             running in real time (shows what's playing RIGHT NOW)
//
// Both are shown together in the chord detector panel.

let _chordFrames    = [];    // server-computed [{time, chord}, …]
let _lastChordIdx   = -1;
let _liveChordAC    = null;
let _liveChordAn    = null;
let _liveChordSrc   = null;
let _liveChordFrame = null;
let _chordHistory   = [];    // smoothing buffer

// Chord templates for live detection (same as server)
const LIVE_NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const LIVE_TEMPLATES = {};
(function buildTemplates() {
  for (let root = 0; root < 12; root++) {
    const n = LIVE_NOTES[root];
    // Major
    const maj = new Float32Array(12);
    maj[root%12]=1; maj[(root+4)%12]=.85; maj[(root+7)%12]=.85;
    LIVE_TEMPLATES[n] = maj;
    // Minor
    const min = new Float32Array(12);
    min[root%12]=1; min[(root+3)%12]=.85; min[(root+7)%12]=.85;
    LIVE_TEMPLATES[n+'m'] = min;
    // Dominant 7
    const d7 = new Float32Array(12);
    d7[root%12]=1; d7[(root+4)%12]=.85; d7[(root+7)%12]=.85; d7[(root+10)%12]=.65;
    LIVE_TEMPLATES[n+'7'] = d7;
  }
})();

function chromaCorr(chroma, template) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<12;i++) { dot+=chroma[i]*template[i]; na+=chroma[i]*chroma[i]; nb+=template[i]*template[i]; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-8);
}

function detectLiveChord(freqData, sampleRate) {
  // Map FFT bins to 12 chroma bins
  const binWidth = sampleRate / (freqData.length * 2);
  const chroma   = new Float32Array(12).fill(0);

  for (let bin=1; bin<freqData.length; bin++) {
    const freq = bin * binWidth;
    if (freq < 65 || freq > 2000) continue;   // piano range
    const midi  = 69 + 12 * Math.log2(freq / 440);
    const pc    = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pc] += freqData[bin] / 255;
  }

  // Normalise
  const mx = Math.max(...chroma);
  if (mx < 0.01) return null;    // silence
  for (let i=0;i<12;i++) chroma[i] /= mx;

  // Score all templates
  let bestChord = null, bestScore = -1;
  for (const [name, tmpl] of Object.entries(LIVE_TEMPLATES)) {
    const s = chromaCorr(chroma, tmpl);
    if (s > bestScore) { bestScore = s; bestChord = name; }
  }

  // Confidence threshold — don't show uncertain results
  if (bestScore < 0.7) return null;
  return { chord: bestChord, confidence: bestScore, chroma };
}

// Smoothing: return most-common chord in last N frames
function smoothedChord(chord) {
  if (chord) _chordHistory.push(chord);
  if (_chordHistory.length > 8) _chordHistory.shift();
  if (!_chordHistory.length) return null;
  const counts = {};
  _chordHistory.forEach(c => { counts[c] = (counts[c]||0)+1; });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
}

function initLiveChordDetector() {
  if (_liveChordAC) return;   // already init
  try {
    const audio    = document.getElementById('audioPlayer');
    _liveChordAC   = new AudioContext();
    _liveChordAn   = _liveChordAC.createAnalyser();
    _liveChordAn.fftSize             = 4096;
    _liveChordAn.smoothingTimeConstant = 0.85;
    _liveChordSrc  = _liveChordAC.createMediaElementSource(audio);
    _liveChordSrc.connect(_liveChordAn);
    _liveChordAn.connect(_liveChordAC.destination);
  } catch(e) { console.warn('Live chord detector init failed:', e); }
}

async function loadChordFrames(songId) {
  _chordFrames  = [];
  _lastChordIdx = -1;
  _chordHistory = [];
  try {
    const data   = await api('GET', '/api/songs/' + songId + '/chords');
    _chordFrames = data.frames || [];
  } catch(e) { console.warn('Could not load chord frames:', e); }
}

function startChordDetection(songId) {
  cancelAnimationFrame(_liveChordFrame);
  initLiveChordDetector();
  loadChordFrames(songId);
  if (_liveChordAC?.state === 'suspended') _liveChordAC.resume();
  runChordDetection();
}

function runChordDetection() {
  if (!_liveChordAn) { _liveChordFrame = requestAnimationFrame(runChordDetection); return; }

  const audio   = document.getElementById('audioPlayer');
  const curTime = audio.currentTime;
  const fftData = new Uint8Array(_liveChordAn.frequencyBinCount);
  _liveChordAn.getByteFrequencyData(fftData);

  // ── Track A: server chord frames (timeline-based) ─────────
  let serverChord = null;
  if (_chordFrames.length) {
    // Find the last frame whose time ≤ currentTime
    let lo=0, hi=_chordFrames.length-1, idx=0;
    while (lo<=hi) {
      const mid=Math.floor((lo+hi)/2);
      if (_chordFrames[mid].time<=curTime) { idx=mid; lo=mid+1; } else hi=mid-1;
    }
    serverChord = _chordFrames[idx]?.chord || null;
  }

  // ── Track B: live browser chroma detection ────────────────
  const liveResult = detectLiveChord(fftData, _liveChordAC?.sampleRate || 44100);
  const liveChord  = smoothedChord(liveResult?.chord || null);

  // ── Update UI ─────────────────────────────────────────────
  updateChordUI(serverChord, liveChord, liveResult?.chroma);

  _liveChordFrame = requestAnimationFrame(runChordDetection);
}

function updateChordUI(serverChord, liveChord, chroma) {
  // Update the "now playing chord" display
  const nowEl = document.getElementById('chordNow');
  const liveEl= document.getElementById('chordLive');
  const confEl= document.getElementById('chordConf');
  const chromaEl = document.getElementById('chromaViz');

  if (nowEl && serverChord) {
    nowEl.textContent = serverChord;
    // Highlight matching chord in analysis page
    document.querySelectorAll('.chord-chip').forEach(el => {
      el.classList.toggle('chord-now-playing', el.textContent.trim() === serverChord);
    });
  }
  if (liveEl && liveChord) liveEl.textContent = liveChord;

  // Draw chroma wheel
  if (chromaEl && chroma) drawChromaWheel(chromaEl, chroma, serverChord);
}

function drawChromaWheel(canvas, chroma, currentChord) {
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width = canvas.offsetWidth || 160;
  const H    = canvas.height = 160;
  const cx   = W/2, cy=H/2, R=66, ri=30;

  ctx.clearRect(0,0,W,H);

  // Find root of current chord
  const root = currentChord
    ? LIVE_NOTES.findIndex(n => currentChord.startsWith(n) && (currentChord===n||!LIVE_NOTES.some(n2=>n2!==n&&currentChord.startsWith(n2)&&n2.length>n.length)))
    : -1;

  LIVE_NOTES.forEach((note, i) => {
    const angle  = (i/12)*Math.PI*2 - Math.PI/2;
    const angle2 = ((i+1)/12)*Math.PI*2 - Math.PI/2;
    const v      = chroma[i];
    const isRoot = (i === root);

    // Segment
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,R,angle,angle2);
    ctx.closePath();

    if (isRoot) {
      ctx.fillStyle = `rgba(0,245,196,${0.3+v*0.7})`;
    } else if (v > 0.5) {
      ctx.fillStyle = `rgba(123,92,255,${0.15+v*0.55})`;
    } else {
      ctx.fillStyle = `rgba(255,255,255,${0.03+v*0.12})`;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(42,42,61,.8)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Note label
    const mid  = (angle+angle2)/2;
    const lx   = cx+(R+ri)/2*Math.cos(mid);
    const ly   = cy+(R+ri)/2*Math.sin(mid);
    ctx.fillStyle = isRoot ? '#00f5c4' : v>0.4 ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.28)';
    ctx.font      = isRoot ? 'bold 11px Syne' : '10px Syne';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(note, lx, ly);
  });

  // Centre hole
  ctx.beginPath(); ctx.arc(cx,cy,ri-2,0,Math.PI*2);
  ctx.fillStyle='#0a0a0f'; ctx.fill();
  // Centre chord name
  if (currentChord) {
    ctx.fillStyle='#00f5c4'; ctx.font='bold 13px Syne';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(currentChord, cx, cy);
  }
}

// ═══════════════════════════════════════════════════════════════
// INJECT CHORD DETECTOR PANEL INTO PLAYER PAGE
// ═══════════════════════════════════════════════════════════════

function injectChordDetectorPanel() {
  if (document.getElementById('liveChordPanel')) return;
  const target = document.querySelector('.pp-right');
  if (!target) return;

  const panel = document.createElement('div');
  panel.id    = 'liveChordPanel';
  panel.style.cssText = `
    background:var(--bg);border:1px solid var(--border);
    border-radius:16px;padding:14px 16px;margin-bottom:14px;
    position:relative;overflow:hidden;
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:7px">
        <div id="chordDetDot" style="width:8px;height:8px;border-radius:50%;background:var(--accent3);
          transition:background .1s,box-shadow .1s"></div>
        <span style="font-family:var(--mono);font-size:.6rem;font-weight:700;letter-spacing:.14em;color:var(--text3);text-transform:uppercase">
          Live Chord Detector
        </span>
      </div>
      <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3)">Real-time · Per frame</div>
    </div>

    <div style="display:grid;grid-template-columns:160px 1fr;gap:14px;align-items:start">

      <!-- Chroma wheel -->
      <div>
        <canvas id="chromaViz" style="width:100%;height:160px;display:block;border-radius:10px"></canvas>
      </div>

      <!-- Right column -->
      <div style="display:flex;flex-direction:column;gap:10px">

        <!-- Current chord (server analysis) -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
          <div style="font-family:var(--mono);font-size:.58rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Now Playing</div>
          <div id="chordNow" style="font-size:2.2rem;font-weight:800;color:var(--accent);font-family:var(--mono);
            text-shadow:0 0 20px rgba(0,245,196,.4);letter-spacing:-.5px;line-height:1">—</div>
          <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3);margin-top:4px">from analysis</div>
        </div>

        <!-- Live browser detection -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
          <div style="font-family:var(--mono);font-size:.58rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Live Detection</div>
          <div id="chordLive" style="font-size:1.8rem;font-weight:800;color:var(--accent3);font-family:var(--mono);
            text-shadow:0 0 16px rgba(123,92,255,.4);line-height:1">—</div>
          <div style="font-family:var(--mono);font-size:.62rem;color:var(--text3);margin-top:4px">browser chroma</div>
        </div>

        <!-- Confidence bar -->
        <div id="chordConf" style="font-family:var(--mono);font-size:.65rem;color:var(--text3)"></div>

        <!-- Upcoming chords from frame timeline -->
        <div>
          <div style="font-family:var(--mono);font-size:.58rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Coming up</div>
          <div id="chordUpcoming" style="display:flex;flex-wrap:wrap;gap:5px"></div>
        </div>
      </div>
    </div>
  `;

  // Insert before beat detector
  const bd = document.getElementById('beatDetector');
  if (bd) target.insertBefore(panel, bd);
  else     target.prepend(panel);

  // Upcoming chords updater (runs with progress loop)
  setInterval(updateUpcomingChords, 500);
}

function updateUpcomingChords() {
  const el = document.getElementById('chordUpcoming');
  if (!el || !_chordFrames.length) return;
  const audio   = document.getElementById('audioPlayer');
  const cur     = audio?.currentTime || 0;

  // Find next 5 distinct chord changes
  const upcoming = [];
  let last = null;
  for (const f of _chordFrames) {
    if (f.time <= cur) continue;
    if (f.chord !== last) {
      upcoming.push(f);
      last = f.chord;
    }
    if (upcoming.length >= 5) break;
  }

  el.innerHTML = upcoming.map(f => `
    <span style="background:var(--surface2);border:1px solid var(--border);
      font-family:var(--mono);font-size:.65rem;color:var(--text2);
      padding:2px 8px;border-radius:10px;cursor:pointer"
      title="Jump to ${formatTime(f.time)}"
      onclick="document.getElementById('audioPlayer').currentTime=${f.time}">
      ${f.chord} <span style="color:var(--text3);font-size:.55rem">${formatTime(f.time)}</span>
    </span>`).join('') || '<span style="color:var(--text3);font-size:.72rem;font-family:var(--mono)">No upcoming changes</span>';
}

function formatTime(s) {
  if (!s||isNaN(s)) return '0:00';
  return Math.floor(s/60)+':'+(Math.floor(s%60)+'').padStart(2,'0');
}

// ═══════════════════════════════════════════════════════════════
// PATCH playSongById to trigger chord detector
// ═══════════════════════════════════════════════════════════════

window.addEventListener('load', () => {
  injectChordDetectorPanel();

  const _origPlay = window.playSongById;
  window.playSongById = async function(id) {
    await _origPlay(id);
    startChordDetection(id);

    // Update chordNow dot
    const dot = document.getElementById('chordDetDot');
    if (dot) {
      dot.style.background  = 'var(--accent)';
      dot.style.boxShadow   = '0 0 8px var(--accent)';
    }
  };
});

// ── Also inject additional CSS for chord-now-playing highlight ──
const style = document.createElement('style');
style.textContent = `
  .chord-chip.chord-now-playing {
    background: rgba(0,245,196,.15) !important;
    border-color: var(--accent) !important;
    color: var(--accent) !important;
    box-shadow: 0 0 12px rgba(0,245,196,.3);
    transform: scale(1.06);
  }
  #liveChordPanel { transition: border-color .15s; }
`;
document.head.appendChild(style);

// Expose
Object.assign(window, {
  logout, getToken, api, startChordDetection, loadChordFrames,
  openProfileModal, closeProfileModal, pTab,
  saveProfile, changePassword, confirmDeleteAllSongs,
  togglePwField, checkPwStrengthInline,
});