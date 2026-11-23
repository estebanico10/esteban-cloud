'use strict';

function getIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141d2e"/>
      <stop offset="100%" stop-color="#090d14"/>
    </linearGradient>
    <linearGradient id="cloud" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#67e8f9"/>
      <stop offset="52%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)" stroke="#38bdf8" stroke-opacity="0.45" stroke-width="5"/>
  <path d="M74 176h104c21 0 38-16.5 38-37 0-19.2-14.6-35-33.5-36.8C176.2 77.6 154.5 60 128.5 60c-27.5 0-50.2 20-54.8 46.2C54.6 109.6 40 126.1 40 146c0 16.6 13.4 30 34 30z" fill="url(#cloud)"/>
  <g fill="none" stroke="#0b0f18" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
    <path d="M96 122h56"/><path d="M138 108l14 14-14 14"/>
    <path d="M160 148h-56"/><path d="M118 134l-14 14 14 14"/>
  </g>
</svg>`;
}

function getManifestJson(nodeName) {
  return JSON.stringify({
    name: `Esteban Cloud · ${nodeName || 'Nodo'}`,
    short_name: 'Esteban Cloud',
    description: 'Nube personal bidireccional cifrada — Hecho por Esteban Nicola',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable'
      }
    ]
  }, null, 2);
}

function getServiceWorkerJs() {
  return `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;
}

function getMobileHtml(nodeName) {
  const safeNode = String(nodeName || 'Esteban Cloud').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0b0e14" />
  <title>Esteban Cloud · ${safeNode}</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <style>
    :root {
      --bg: #0b0e14;
      --panel: #131822;
      --panel-2: #192130;
      --border: rgba(148,163,184,0.16);
      --text: #eef2f7;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-2: #2563eb;
      --danger: #f87171;
      --ok: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(circle at top right, rgba(37,99,235,0.18), transparent 45%), var(--bg);
      color: var(--text); min-height: 100vh; display: flex; flex-direction: column;
    }
    header {
      position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px; background: rgba(11,14,20,0.88); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
    .brand img { width: 28px; height: 28px; border-radius: 8px; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: rgba(56,189,248,0.14); color: var(--accent); border: 1px solid rgba(56,189,248,0.28); }
    main { flex: 1; width: 100%; max-width: 920px; margin: 0 auto; padding: 16px; }
    .card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 18px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.3);
    }
    h1, h2, h3 { margin: 0 0 10px; }
    p { margin: 0 0 12px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 6px; font-weight: 600; }
    input[type="password"], input[type="text"], textarea {
      width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: #0d121b; color: var(--text); font-size: 14px; font-family: inherit;
    }
    textarea { min-height: 82px; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--panel-2); color: var(--text); font-size: 13px; font-weight: 600;
      cursor: pointer; text-decoration: none;
    }
    .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border: none; color: #06101c; }
    .btn-danger { background: rgba(248,113,113,0.12); border-color: rgba(248,113,113,0.35); color: var(--danger); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .shares-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
    .share-card {
      padding: 16px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel-2);
      cursor: pointer; transition: transform .12s ease, border-color .12s ease;
    }
    .share-card:hover { border-color: var(--accent); transform: translateY(-1px); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 13px; color: var(--muted); }
    .crumbs button { background: none; border: none; color: var(--accent); cursor: pointer; padding: 2px 4px; font-weight: 600; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .item {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 11px 12px; border-radius: 12px; background: var(--panel-2); border: 1px solid transparent;
    }
    .item:hover { border-color: var(--border); }
    .item-main { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; cursor: pointer; }
    .item-name { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-meta { font-size: 11px; color: var(--muted); }
    .error { background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.35); color: #fecaca; padding: 10px 12px; border-radius: 10px; font-size: 13px; margin: 10px 0; }
    .ok { background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.35); color: #a7f3d0; padding: 10px 12px; border-radius: 10px; font-size: 13px; margin: 10px 0; }
    .preview-box { margin-top: 14px; padding: 12px; border-radius: 12px; background: #090d14; border: 1px solid var(--border); text-align: center; }
    .preview-box img, .preview-box video { max-width: 100%; max-height: 62vh; border-radius: 8px; }
    footer { padding: 14px 16px; text-align: center; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
    footer a { color: var(--accent); text-decoration: none; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <img src="/icon.svg" alt="" />
      <span>Esteban Cloud</span>
      <span class="badge">${safeNode}</span>
    </div>
    <button id="btnLogout" class="btn hidden" onclick="logout()">Cerrar sesión</button>
  </header>

  <main>
    <section id="loginView" class="card">
      <h2>Desbloquear con llave encriptada</h2>
      <p>Carga tu archivo <code>.ecloudkey</code> desde tu celular o pendrive USB-OTG (o pega el texto de la llave) e ingresa tu frase de paso.</p>
      <div id="loginMsg"></div>
      <label for="keyFile">Archivo .ecloudkey</label>
      <input id="keyFile" type="file" accept=".ecloudkey,.json,.txt" />
      <label for="keyText">O pegar llave encriptada (ECLOUD1:... o JSON)</label>
      <textarea id="keyText" placeholder="ECLOUD1:..."></textarea>
      <label for="passphrase">Frase de paso</label>
      <input id="passphrase" type="password" autocomplete="current-password" placeholder="Tu frase de paso secreta" />
      <div class="row" style="margin-top:14px">
        <button id="btnUnlock" class="btn btn-primary" onclick="unlock()">Desbloquear acceso</button>
      </div>
    </section>

    <section id="appView" class="hidden">
      <div id="sharesView" class="card">
        <div class="toolbar">
          <div>
            <h2>Carpetas disponibles</h2>
            <p id="sessionInfo" style="margin:0"></p>
          </div>
        </div>
        <div id="sharesGrid" class="shares-grid"></div>
      </div>

      <div id="browserView" class="card hidden">
        <div class="toolbar">
          <div class="crumbs" id="crumbs"></div>
          <div class="row">
            <button class="btn" onclick="refreshDir()">Actualizar</button>
            <label id="uploadLabel" class="btn btn-primary hidden" style="margin:0;cursor:pointer">
              Subir archivo
              <input id="uploadInput" type="file" multiple style="display:none" onchange="uploadFiles(this.files)" />
            </label>
            <button id="btnMkdir" class="btn hidden" onclick="createFolder()">+ Carpeta</button>
          </div>
        </div>
        <div id="browserMsg"></div>
        <div id="previewBox" class="preview-box hidden"></div>
        <div id="fileList" class="list"></div>
      </div>
    </section>
  </main>

  <footer>
    Hecho por Esteban Nicola · <a href="https://estebanico.com" target="_blank" rel="noopener noreferrer">estebanico.com</a>
  </footer>

  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    let state = { shares: [], currentShare: null, currentPath: '', keyMeta: null };

    document.getElementById('keyFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      document.getElementById('keyText').value = await file.text();
    });

    function showMsg(id, text, type) {
      const el = document.getElementById(id);
      if (!text) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="' + (type || 'error') + '">' + escapeHtml(text) + '</div>';
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function fmtSize(n) {
      if (n == null) return '';
      const u = ['B','KB','MB','GB','TB'];
      let i = 0, v = Number(n);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
    }

    async function api(url, opts) {
      const res = await fetch(url, opts);
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : await res.text();
      if (!res.ok) throw new Error((data && data.error) || 'Error HTTP ' + res.status);
      return data;
    }

    async function tryExistingSession() {
      try {
        const data = await api('/api/shares');
        state.shares = data.shares || [];
        state.keyMeta = data.key || null;
        renderLoggedIn();
      } catch {
        // Not logged in yet
      }
    }

    async function unlock() {
      const bundle = document.getElementById('keyText').value.trim();
      const passphrase = document.getElementById('passphrase').value;
      if (!bundle || !passphrase) {
        showMsg('loginMsg', 'Carga tu archivo .ecloudkey (o pega la llave) y escribe tu frase de paso.');
        return;
      }
      const btn = document.getElementById('btnUnlock');
      btn.disabled = true;
      showMsg('loginMsg', 'Verificando llave encriptada...', 'ok');
      try {
        const data = await api('/api/auth/unlock-bundle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle, passphrase })
        });
        state.shares = data.shares || [];
        state.keyMeta = data.key || null;
        document.getElementById('passphrase').value = '';
        showMsg('loginMsg', '');
        renderLoggedIn();
      } catch (err) {
        showMsg('loginMsg', err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    }

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state = { shares: [], currentShare: null, currentPath: '', keyMeta: null };
      document.getElementById('loginView').classList.remove('hidden');
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('btnLogout').classList.add('hidden');
    }

    function renderLoggedIn() {
      document.getElementById('loginView').classList.add('hidden');
      document.getElementById('appView').classList.remove('hidden');
      document.getElementById('btnLogout').classList.remove('hidden');
      document.getElementById('sharesView').classList.remove('hidden');
      document.getElementById('browserView').classList.add('hidden');
      const info = state.keyMeta ? ('Llave: ' + state.keyMeta.label + ' (' + (state.keyMeta.permissions === 'rw' ? 'Lectura y escritura' : 'Solo lectura') + ')') : '';
      document.getElementById('sessionInfo').textContent = info;
      const grid = document.getElementById('sharesGrid');
      if (!state.shares.length) {
        grid.innerHTML = '<p>No hay carpetas compartidas habilitadas para esta llave.</p>';
        return;
      }
      grid.innerHTML = state.shares.map((s) => (
        '<div class="share-card" onclick="openShare(\\'' + escapeHtml(s.id) + '\\')">' +
          '<div style="font-weight:700;font-size:15px;margin-bottom:6px">📁 ' + escapeHtml(s.name) + '</div>' +
          '<div class="item-meta">' + (s.effectiveMode === 'rw' ? 'Lectura y escritura' : 'Solo lectura') + '</div>' +
        '</div>'
      )).join('');
    }

    function openShare(shareId) {
      state.currentShare = state.shares.find((s) => s.id === shareId) || null;
      state.currentPath = '';
      if (!state.currentShare) return;
      document.getElementById('sharesView').classList.add('hidden');
      document.getElementById('browserView').classList.remove('hidden');
      const canWrite = state.currentShare.effectiveMode === 'rw';
      document.getElementById('uploadLabel').classList.toggle('hidden', !canWrite);
      document.getElementById('btnMkdir').classList.toggle('hidden', !canWrite);
      refreshDir();
    }

    function renderCrumbs() {
      const parts = state.currentPath ? state.currentPath.split('/').filter(Boolean) : [];
      let html = '<button onclick="renderLoggedIn()">Inicio</button> / <button onclick="goPath(\\'\\')">' + escapeHtml(state.currentShare.name) + '</button>';
      let acc = '';
      for (const p of parts) {
        acc = acc ? (acc + '/' + p) : p;
        const target = acc;
        html += ' / <button onclick="goPath(\\'' + escapeHtml(target) + '\\')">' + escapeHtml(p) + '</button>';
      }
      document.getElementById('crumbs').innerHTML = html;
    }

    function goPath(p) {
      state.currentPath = p;
      document.getElementById('previewBox').classList.add('hidden');
      refreshDir();
    }

    async function refreshDir() {
      renderCrumbs();
      showMsg('browserMsg', '');
      const list = document.getElementById('fileList');
      list.innerHTML = '<p>Cargando...</p>';
      try {
        const q = '?share=' + encodeURIComponent(state.currentShare.id) + '&path=' + encodeURIComponent(state.currentPath);
        const data = await api('/api/files' + q);
        if (!data.items.length) {
          list.innerHTML = '<p>Esta carpeta está vacía.</p>';
          return;
        }
        const canWrite = state.currentShare.effectiveMode === 'rw';
        list.innerHTML = data.items.map((it) => {
          const full = state.currentPath ? (state.currentPath + '/' + it.name) : it.name;
          const dl = '/api/download?share=' + encodeURIComponent(state.currentShare.id) + '&path=' + encodeURIComponent(full);
          const action = it.isDirectory
            ? 'goPath(\\'' + escapeHtml(full).replace(/'/g, "\\\\'") + '\\')'
            : 'previewFile(\\'' + escapeHtml(full).replace(/'/g, "\\\\'") + '\\', \\'' + escapeHtml(it.name).replace(/'/g, "\\\\'") + '\\')';
          return '<div class="item">' +
            '<div class="item-main" onclick="' + action + '">' +
              '<span>' + (it.isDirectory ? '📁' : '📄') + '</span>' +
              '<div style="min-width:0"><div class="item-name">' + escapeHtml(it.name) + '</div>' +
              '<div class="item-meta">' + (it.isDirectory ? 'Carpeta' : fmtSize(it.size)) + '</div></div>' +
            '</div>' +
            '<div class="row">' +
              (!it.isDirectory ? '<a class="btn" href="' + dl + '">Descargar</a>' : '') +
              (canWrite ? '<button class="btn btn-danger" onclick="deleteItem(\\'' + escapeHtml(full).replace(/'/g, "\\\\'") + '\\')">Borrar</button>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        showMsg('browserMsg', err.message, 'error');
        list.innerHTML = '';
      }
    }

    function previewFile(fullPath, name) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      const url = '/api/download?inline=1&share=' + encodeURIComponent(state.currentShare.id) + '&path=' + encodeURIComponent(fullPath);
      const box = document.getElementById('previewBox');
      if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
        box.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(name) + '" />';
        box.classList.remove('hidden');
      } else if (['mp4','webm','mov','m4v'].includes(ext)) {
        box.innerHTML = '<video controls playsinline src="' + url + '"></video>';
        box.classList.remove('hidden');
      } else if (['mp3','wav','ogg','m4a'].includes(ext)) {
        box.innerHTML = '<audio controls src="' + url + '" style="width:100%"></audio>';
        box.classList.remove('hidden');
      } else {
        window.open(url, '_blank');
      }
    }

    async function uploadFiles(files) {
      if (!files || !files.length) return;
      for (const file of files) {
        showMsg('browserMsg', 'Subiendo ' + file.name + '...', 'ok');
        const url = '/api/upload?share=' + encodeURIComponent(state.currentShare.id) +
          '&path=' + encodeURIComponent(state.currentPath) +
          '&name=' + encodeURIComponent(file.name);
        try {
          await api(url, { method: 'POST', body: file });
        } catch (err) {
          showMsg('browserMsg', 'Error al subir ' + file.name + ': ' + err.message, 'error');
          return;
        }
      }
      document.getElementById('uploadInput').value = '';
      showMsg('browserMsg', 'Subida completada.', 'ok');
      refreshDir();
    }

    async function createFolder() {
      const name = prompt('Nombre de la nueva carpeta:');
      if (!name || !name.trim()) return;
      try {
        await api('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ share: state.currentShare.id, path: state.currentPath, name: name.trim() })
        });
        refreshDir();
      } catch (err) {
        showMsg('browserMsg', err.message, 'error');
      }
    }

    async function deleteItem(fullPath) {
      if (!confirm('¿Eliminar "' + fullPath + '"?')) return;
      try {
        await api('/api/file?share=' + encodeURIComponent(state.currentShare.id) + '&path=' + encodeURIComponent(fullPath), {
          method: 'DELETE'
        });
        refreshDir();
      } catch (err) {
        showMsg('browserMsg', err.message, 'error');
      }
    }

    tryExistingSession();
  </script>
</body>
</html>`;
}

module.exports = {
  getIconSvg,
  getManifestJson,
  getServiceWorkerJs,
  getMobileHtml
};
