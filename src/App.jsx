import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Cloud,
  FolderOpen,
  KeyRound,
  HardDrive,
  Wrench,
  Settings,
  Play,
  Square,
  Plus,
  Trash2,
  Copy,
  Usb,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Upload,
  Download,
  FolderPlus,
  ExternalLink,
  Smartphone,
  CheckCircle2,
  AlertCircle,
  Link2,
  Eye,
  EyeOff,
  Search,
  Pencil,
  Globe,
  Wifi,
  ArrowRight,
  Sparkles,
  Bookmark,
  Package,
  Activity,
  MessageSquare
} from 'lucide-react';
import MetricsView from './components/MetricsView.jsx';
import ChatView from './components/ChatView.jsx';

const api = window.estebanCloud;

function fmtSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function getPassStrength(pass) {
  if (!pass) return { score: 0, label: '', color: 'transparent' };
  let score = 0;
  if (pass.length >= 6) score += 25;
  if (pass.length >= 10) score += 25;
  if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score += 20;
  if (/\d/.test(pass)) score += 15;
  if (/[^A-Za-z0-9]/.test(pass)) score += 15;
  if (score < 45) return { score, label: 'Débil (añade más caracteres)', color: '#f87171' };
  if (score < 75) return { score, label: 'Buena', color: '#fbbf24' };
  return { score: 100, label: 'Fuerte (recomendada para pendrive)', color: '#34d399' };
}

function BrandEmblem() {
  return (
    <svg viewBox="0 0 256 256" width="40" height="40" aria-hidden="true">
      <defs>
        <linearGradient id="ecBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#162032" />
          <stop offset="100%" stopColor="#090d14" />
        </linearGradient>
        <linearGradient id="ecCloud" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#67e8f9" />
          <stop offset="52%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#ecBg)" stroke="#38bdf8" strokeOpacity="0.45" strokeWidth="6" />
      <path d="M74 176h104c21 0 38-16.5 38-37 0-19.2-14.6-35-33.5-36.8C176.2 77.6 154.5 60 128.5 60c-27.5 0-50.2 20-54.8 46.2C54.6 109.6 40 126.1 40 146c0 16.6 13.4 30 34 30z" fill="url(#ecCloud)" />
      <g fill="none" stroke="#0b0f18" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round">
        <path d="M96 121h56" />
        <path d="M138 107l14 14-14 14" />
        <path d="M160 149h-56" />
        <path d="M118 135l-14 14 14 14" />
      </g>
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [state, setState] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  // Key generator state
  const [keyLabel, setKeyLabel] = useState('Pendrive Principal');
  const [keyPass, setKeyPass] = useState('');
  const [keyPass2, setKeyPass2] = useState('');
  const [showKeyPass, setShowKeyPass] = useState(false);
  const [keyPerm, setKeyPerm] = useState('rw');
  const [keyAllShares, setKeyAllShares] = useState(true);
  const [selectedShareIds, setSelectedShareIds] = useState([]);
  const [generatedKey, setGeneratedKey] = useState(null);
  const [saveDirs, setSaveDirs] = useState([]);

  // Client connect state
  const [usbKeys, setUsbKeys] = useState([]);
  const [bundleText, setBundleText] = useState('');
  const [bundleFilePath, setBundleFilePath] = useState('');
  const [clientPass, setClientPass] = useState('');
  const [showClientPass, setShowClientPass] = useState(false);
  const [overrideUrl, setOverrideUrl] = useState('');
  const [showAdvancedClient, setShowAdvancedClient] = useState(false);
  const [draggingKey, setDraggingKey] = useState(false);
  const [driveLetter, setDriveLetter] = useState('Z:');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeRemoteShare, setActiveRemoteShare] = useState(null);
  const [remotePath, setRemotePath] = useState('');
  const [remoteItems, setRemoteItems] = useState([]);
  const [remoteSearch, setRemoteSearch] = useState('');

  // Dependencies state
  const [optOpenSsh, setOptOpenSsh] = useState(false);
  const [optDisableSleep, setOptDisableSleep] = useState(true);
  const [installLog, setInstallLog] = useState('');

  // Updates state
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateProgress, setUpdateProgress] = useState(null);
  const [unreadChats, setUnreadChats] = useState(0);

  // Pendrive Kit exporter state
  const [kitTargetDir, setKitTargetDir] = useState('');
  const [kitCustomInstaller, setKitCustomInstaller] = useState('');
  const [kitIncludeGeneratedKey, setKitIncludeGeneratedKey] = useState(true);
  const [kitCreateZip, setKitCreateZip] = useState(false);
  const [kitResult, setKitResult] = useState(null);

  const flash = useCallback((type, text) => setNotice({ type, text }), []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.getState();
      setState(next);
      if (typeof next.totalUnread === 'number') setUnreadChats(next.totalUnread);
      if (next.env?.usbDrives?.length && saveDirs.length === 0) {
        setSaveDirs(next.env.usbDrives.map((d) => d.root));
      }
      if (next.env?.usbDrives?.length && !kitTargetDir) {
        setKitTargetDir(next.env.usbDrives[0].root);
      }
    } catch (err) {
      flash('error', err.message || 'No se pudo cargar el estado.');
    }
  }, [flash, saveDirs.length, kitTargetDir]);

  useEffect(() => {
    refresh();
    if (!api) return;
    const unsubLog = api.onLog(() => {
      api.getState().then(setState).catch(() => {});
    });
    const unsubUpd = api.onUpdateProgress ? api.onUpdateProgress((p) => setUpdateProgress(p)) : null;
    const unsubAvail = api.onUpdateAvailable ? api.onUpdateAvailable((info) => setUpdateInfo(info)) : null;
    const unsubChat = api.onChatEvent ? api.onChatEvent((evt) => {
      if (evt && typeof evt.totalUnread === 'number') setUnreadChats(evt.totalUnread);
    }) : null;
    // Quietly check for updates on launch
    api.checkUpdates().then((info) => {
      if (info && info.status === 'update-available') setUpdateInfo(info);
    }).catch(() => {});
    return () => {
      unsubLog && unsubLog();
      unsubUpd && unsubUpd();
      unsubAvail && unsubAvail();
      unsubChat && unsubChat();
    };
  }, [refresh]);

  const filteredRemoteItems = useMemo(() => {
    const q = remoteSearch.trim().toLowerCase();
    if (!q) return remoteItems;
    return remoteItems.filter((it) => it.name.toLowerCase().includes(q));
  }, [remoteItems, remoteSearch]);

  if (!api) {
    return (
      <div style={{ padding: 32 }}>
        <h1>Esteban Cloud</h1>
        <p className="muted">Ejecuta esta aplicación dentro de Electron (<code>npm run dev</code> o instalador Windows).</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{ padding: 32 }}>
        <p className="muted">Cargando Esteban Cloud...</p>
      </div>
    );
  }

  const { config, server, env, urls, mounts, activeClientSessions, installerInfo, hostedUpdate } = state;
  const activeSession = activeClientSessions.find((s) => s.sessionId === activeSessionId) || activeClientSessions[0] || null;
  const depsReady = env.tailscale.installed && env.rclone.installed && env.winfsp.installed;
  const hasActiveKeys = config.keys.some((k) => !k.revoked);
  const strength = getPassStrength(keyPass);

  const toggleServer = async () => {
    setBusy(true);
    try {
      const next = server.running ? await api.stopServer() : await api.startServer();
      setState(next);
      flash('ok', next.server.running ? `Servidor activo en puerto ${next.server.port}.` : 'Servidor detenido.');
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAddShare = async () => {
    try {
      const folderPath = await api.pickShareFolder();
      if (!folderPath) return;
      const parts = folderPath.split(/[\\/]/).filter(Boolean);
      const name = parts[parts.length - 1] || 'Carpeta';
      const next = await api.addShare({ name, folderPath, mode: 'rw' });
      setState(next);
      flash('ok', `Carpeta "${name}" añadida para compartir.`);
    } catch (err) {
      flash('error', err.message);
    }
  };

  const handleGenerateKey = async (e) => {
    e.preventDefault();
    if (keyPass.length < 6) return flash('error', 'La frase de paso debe tener al menos 6 caracteres.');
    if (keyPass !== keyPass2) return flash('error', 'Las frases de paso no coinciden.');
    const shareIds = keyAllShares ? ['*'] : selectedShareIds;
    if (!keyAllShares && shareIds.length === 0) return flash('error', 'Selecciona al menos una carpeta.');

    setBusy(true);
    try {
      const res = await api.generateKey({ label: keyLabel, permissions: keyPerm, shareIds, passphrase: keyPass });
      setGeneratedKey(res);
      setState(res.state);
      setKeyPass('');
      setKeyPass2('');
      if (res.state.env.usbDrives.length > 0) {
        setSaveDirs(res.state.env.usbDrives.map((d) => d.root));
      }
      flash('ok', `Llave encriptada ${res.keyId} creada. Guárdala en tu pendrive o cópiala ahora.`);
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAddSaveDir = async () => {
    const dir = await api.pickSaveFolder();
    if (dir && !saveDirs.includes(dir)) setSaveDirs((prev) => [...prev, dir]);
  };

  const handleSaveKeyMultiple = async () => {
    if (!generatedKey) return;
    if (!saveDirs.length) return flash('error', 'Selecciona al menos una carpeta o pendrive destino.');
    const res = await api.saveKeyToLocations({
      fileName: generatedKey.suggestedFileName,
      bundleJson: generatedKey.bundleJson,
      directories: saveDirs
    });
    if (res.saved.length && !res.errors.length) {
      flash('ok', `Llave guardada en ${res.saved.length} ubicación(es): ${res.saved.join(' | ')}`);
    } else if (res.saved.length) {
      flash('error', `Guardada en ${res.saved.length}, pero falló en: ${res.errors.map((e) => e.dir).join(', ')}`);
    } else {
      flash('error', `No se pudo guardar: ${res.errors.map((e) => e.error).join('; ')}`);
    }
  };

  const handleScanUsb = async () => {
    const list = await api.scanUsbKeys();
    setUsbKeys(list);
    if (list.length === 0) {
      flash('info', 'No se encontraron archivos .ecloudkey en la raíz de los pendrives USB conectados.');
    } else {
      flash('ok', `Se detectaron ${list.length} llave(s) .ecloudkey en USB.`);
    }
  };

  const handlePickKeyFile = async () => {
    const res = await api.pickKeyFile();
    if (!res) return;
    setBundleFilePath(res.filePath);
    setBundleText(res.content);
    flash('ok', `Llave cargada: ${res.filePath}`);
  };

  const handleDropKeyFile = async (e) => {
    e.preventDefault();
    setDraggingKey(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    setBundleText(text);
    setBundleFilePath(file.path || file.name);
    flash('ok', `Llave cargada por arrastre: ${file.name}`);
  };

  const handleConnect = async (e) => {
    e.preventDefault();
    if (!bundleText && !bundleFilePath) return flash('error', 'Carga un archivo .ecloudkey (desde tu pendrive) o pega la llave.');
    if (!clientPass) return flash('error', 'Ingresa la frase de paso para desbloquear la llave.');
    setBusy(true);
    try {
      const res = await api.unlockAndConnect({
        bundleText,
        filePath: bundleFilePath,
        passphrase: clientPass,
        overrideBaseUrl: overrideUrl.trim() || undefined,
        saveBookmark: true
      });
      setState(res.state);
      setActiveSessionId(res.sessionId);
      setActiveRemoteShare(null);
      setRemotePath('');
      setRemoteItems([]);
      setRemoteSearch('');
      setClientPass('');
      flash('ok', `Conectado a ${res.session.nodeName} (${res.session.baseUrl}).`);
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const loadRemoteDir = async (sessionId, share, relPath) => {
    setBusy(true);
    try {
      const data = await api.listRemoteFiles({ sessionId, shareId: share.id, relPath });
      setActiveRemoteShare(share);
      setRemotePath(relPath);
      setRemoteItems(data.items || []);
      setRemoteSearch('');
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleMountDrive = async () => {
    if (!activeSession) return;
    setBusy(true);
    try {
      const res = await api.mountDrive({ sessionId: activeSession.sessionId, driveLetter });
      setState(res.state);
      flash('ok', `Unidad ${res.mounted.drive} montada. Ya puedes abrirla en el Explorador de Windows.`);
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleInstallDeps = async () => {
    setBusy(true);
    setInstallLog('Solicitando permisos de Administrador (UAC) y ejecutando PowerShell...');
    try {
      const res = await api.installDependencies({ installOpenSsh: optOpenSsh, disableSleep: optDisableSleep });
      setState(res.state);
      setInstallLog(res.log || res.error || 'Sin salida registrada.');
      if (res.ok) {
        flash('ok', 'Dependencias y firewall configurados correctamente.');
      } else {
        flash('error', 'El instalador terminó con advertencias o UAC fue cancelado. Revisa el registro.');
      }
    } catch (err) {
      setInstallLog(err.message);
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleExportKit = async () => {
    let dest = kitTargetDir;
    if (!dest) {
      dest = await api.pickSaveFolder();
      if (!dest) return;
      setKitTargetDir(dest);
    }
    setBusy(true);
    try {
      const res = await api.exportPendriveKit({
        targetDir: dest,
        installerPath: kitCustomInstaller || undefined,
        keyFileName: (kitIncludeGeneratedKey && generatedKey) ? generatedKey.suggestedFileName : undefined,
        keyBundleJson: (kitIncludeGeneratedKey && generatedKey) ? generatedKey.bundleJson : undefined,
        createZip: kitCreateZip
      });
      setKitResult(res);
      flash(
        'ok',
        `Kit Pendrive creado en ${res.kitDir}${res.zipPath ? ` y archivo único ${res.zipPath}` : ''}.`
      );
    } catch (err) {
      flash('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrandEmblem /></div>
          <div>
            <div className="brand-title">Esteban Cloud</div>
            <div className="brand-sub">{config.nodeName} · v{state.appVersion}</div>
          </div>
        </div>

        <nav className="nav" aria-label="Navegación principal">
          <div className="nav-section">General</div>
          <button className={`nav-btn ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
            <Cloud size={17} /> Panel y Red
          </button>
          <button className={`nav-btn ${tab === 'metrics' ? 'active' : ''}`} onClick={() => setTab('metrics')}>
            <Activity size={17} /> Métricas globales
          </button>
          <button className={`nav-btn ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
            <MessageSquare size={17} /> Mensajería
            {unreadChats > 0 && <span className="pill-count" style={{ background: 'rgba(56,189,248,0.28)', color: '#e0f2fe' }}>{unreadChats}</span>}
          </button>
          <button className={`nav-btn ${tab === 'deps' ? 'active' : ''}`} onClick={() => setTab('deps')}>
            <Wrench size={17} /> Instalador 1-clic
            {!depsReady && <span className="pill-count">!</span>}
          </button>

          <div className="nav-section">Bidireccional</div>
          <button className={`nav-btn ${tab === 'host' ? 'active' : ''}`} onClick={() => setTab('host')}>
            <FolderOpen size={17} /> Compartir (Host)
            <span className="pill-count">{config.shares.filter((s) => s.enabled).length}</span>
          </button>
          <button className={`nav-btn ${tab === 'keys' ? 'active' : ''}`} onClick={() => setTab('keys')}>
            <KeyRound size={17} /> Llaves y Pendrive
            <span className="pill-count">{config.keys.filter((k) => !k.revoked).length}</span>
          </button>
          <button className={`nav-btn ${tab === 'kit' ? 'active' : ''}`} onClick={() => setTab('kit')}>
            <Package size={17} /> Kit Pendrive
          </button>
          <button className={`nav-btn ${tab === 'client' ? 'active' : ''}`} onClick={() => setTab('client')}>
            <HardDrive size={17} /> Conectar (Cliente)
            <span className="pill-count">{mounts.length + activeClientSessions.length}</span>
          </button>

          <div className="nav-section">Sistema</div>
          <button className={`nav-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <Settings size={17} /> Ajustes y Acerca de
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-chip">
            <span className={`dot ${server.running ? 'ok' : 'danger'}`} />
            <span>{server.running ? `Servidor activo :${server.port}` : 'Servidor detenido'}</span>
          </div>
          <div className="status-chip">
            <span className={`dot ${env.tailscale.running ? 'ok' : 'warn'}`} />
            <span>{env.tailscale.running ? `Túnel ${env.tailscale.ip}` : 'Tailscale sin conectar'}</span>
          </div>
          <div className="credit">
            Hecho por Esteban Nicola ·{' '}
            <button type="button" onClick={() => api.openExternal('https://estebanico.com')}>
              estebanico.com
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {updateInfo?.status === 'update-available' && (
          <div className="banner ok">
            <div className="between">
              <span>
                <strong>Actualización disponible: v{updateInfo.latestVersion}</strong> ({updateInfo.sourceLabel})
              </span>
              <div className="row">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.downloadAndInstallUpdate(updateInfo);
                    } catch (err) {
                      setUpdateProgress(null);
                      flash('error', err.message);
                      setBusy(false);
                    }
                  }}
                >
                  <Download size={13} /> Actualizar ahora
                </button>
                <button className="btn btn-sm" onClick={() => setTab('settings')}>Detalles</button>
              </div>
            </div>
            {updateProgress && (
              <div style={{ marginTop: 8 }}>
                <div className="strength-bar">
                  <div className="strength-fill" style={{ width: `${updateProgress.percent || 0}%`, background: '#38bdf8' }} />
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {updateProgress.stage === 'installing'
                    ? 'Verificado SHA-256. Instalando y reiniciando Esteban Cloud...'
                    : `Descargando: ${updateProgress.percent || 0}% (${fmtSize(updateProgress.received)} / ${fmtSize(updateProgress.total)})`}
                </div>
              </div>
            )}
          </div>
        )}

        {notice && (
          <div className={`banner ${notice.type === 'error' ? 'error' : notice.type === 'ok' ? 'ok' : ''}`}>
            <div className="between">
              <span>{notice.text}</span>
              <button className="btn btn-sm" onClick={() => setNotice(null)}>Cerrar</button>
            </div>
          </div>
        )}

        {tab === 'dashboard' && (
          <>
            <div className="page-head">
              <div>
                <h1>Panel de Esteban Cloud</h1>
                <p>Tu nube personal bidireccional en malla: comparte tus carpetas y monta tus otros equipos desde casa, el trabajo o cualquier país.</p>
              </div>
              <div className="row">
                <button className="btn" onClick={() => setTab('kit')}>
                  <Package size={15} /> Pasar al Pendrive
                </button>
                <button className="btn" onClick={refresh} disabled={busy}>
                  <RefreshCw size={15} /> Actualizar
                </button>
                <button className={`btn ${server.running ? 'btn-danger' : 'btn-primary'}`} onClick={toggleServer} disabled={busy}>
                  {server.running ? <><Square size={15} /> Detener servidor</> : <><Play size={15} /> Iniciar servidor</>}
                </button>
              </div>
            </div>

            <div className="card hero-card">
              <div className="between">
                <h2><Sparkles size={17} color="#67e8f9" /> Puesta en marcha rápida (3 pasos)</h2>
                <span className="badge accent">
                  {[depsReady && env.tailscale.running, hasActiveKeys, config.shares.some((s) => s.enabled)].filter(Boolean).length}/3 listos
                </span>
              </div>
              <div className="grid-3">
                <div className={`step-card ${depsReady && env.tailscale.running ? 'done' : ''}`}>
                  <div className="between">
                    <strong>1. Túnel y motor (1 clic)</strong>
                    {depsReady && env.tailscale.running ? <CheckCircle2 size={16} color="#34d399" /> : <AlertCircle size={16} color="#fbbf24" />}
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {!depsReady
                      ? 'Instala Tailscale, rclone, WinFsp y Firewall en un clic.'
                      : env.tailscale.running
                        ? `Túnel global activo en ${env.tailscale.ip}.`
                        : 'Dependencias instaladas. Inicia sesión en Tailscale.'}
                  </p>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => (!depsReady ? setTab('deps') : api.launchTailscale())}
                  >
                    {!depsReady ? <>Ir al Instalador 1-clic <ArrowRight size={13} /></> : <>Abrir Tailscale <ExternalLink size={13} /></>}
                  </button>
                </div>

                <div className={`step-card ${hasActiveKeys ? 'done' : ''}`}>
                  <div className="between">
                    <strong>2. Llave para tu pendrive</strong>
                    {hasActiveKeys ? <CheckCircle2 size={16} color="#34d399" /> : <AlertCircle size={16} color="#fbbf24" />}
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {hasActiveKeys
                      ? `${config.keys.filter((k) => !k.revoked).length} llave(s) activa(s) y listas para desbloquear.`
                      : 'Genera tu archivo .ecloudkey cifrado y guárdalo en tu pendrive.'}
                  </p>
                  <button className="btn btn-sm" onClick={() => setTab('keys')}>
                    {hasActiveKeys ? 'Gestionar llaves' : 'Crear primera llave'} <ArrowRight size={13} />
                  </button>
                </div>

                <div className={`step-card ${mounts.length > 0 || activeClientSessions.length > 0 ? 'done' : ''}`}>
                  <div className="between">
                    <strong>3. Conectar PC o Android</strong>
                    {mounts.length > 0 ? <CheckCircle2 size={16} color="#34d399" /> : <ArrowRight size={16} color="#38bdf8" />}
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    Monta otro PC como disco <code>Z:</code> o escanea el QR abajo desde Android con Tailscale.
                  </p>
                  <button className="btn btn-sm" onClick={() => setTab('client')}>
                    Abrir Conectar (Cliente) <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid-4">
              <div className="card">
                <div className="kpi-head">
                  <span className="muted">Servidor local</span>
                  <div className={`icon-chip ${server.running ? 'ok' : 'warn'}`}><Cloud size={15} /></div>
                </div>
                <div className="stat-value">{server.running ? 'En línea' : 'Detenido'}</div>
                <span className={`badge ${server.running ? 'ok' : 'danger'}`}>TCP :{server.port || config.port}</span>
              </div>
              <div className="card">
                <div className="kpi-head">
                  <span className="muted">Túnel global (Tailscale)</span>
                  <div className={`icon-chip ${env.tailscale.running ? 'ok' : 'warn'}`}><Globe size={15} /></div>
                </div>
                <div className="stat-value mono">{env.tailscale.ip || 'Sin conectar'}</div>
                <span className={`badge ${env.tailscale.running ? 'ok' : 'warn'}`}>
                  {env.tailscale.running ? 'Accesible desde el mundo' : 'Requiere Tailscale'}
                </span>
              </div>
              <div className="card">
                <div className="kpi-head">
                  <span className="muted">Red local (LAN)</span>
                  <div className="icon-chip"><Wifi size={15} /></div>
                </div>
                <div className="stat-value mono">{env.lanIp || 'Sin IP'}</div>
                <span className="badge accent">{config.nodeName}</span>
              </div>
              <div className="card">
                <div className="kpi-head">
                  <span className="muted">Pendrives USB</span>
                  <div className="icon-chip"><Usb size={15} /></div>
                </div>
                <div className="stat-value">{env.usbDrives.length}</div>
                <span className="badge">{env.usbDrives.length ? env.usbDrives.map((u) => u.drive).join(', ') : 'Conecta tu USB'}</span>
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h2><Smartphone size={17} /> Acceso móvil Android / PWA (dentro del túnel)</h2>
                <p className="muted">
                  Abre la dirección en Chrome de tu celular (con Tailscale encendido fuera de casa, o Wi-Fi en casa), carga tu <code>.ecloudkey</code> y pulsa <strong>Agregar a pantalla de inicio</strong>.
                </p>
                {urls.tailscaleUrl ? (
                  <div className="qr-card">
                    {urls.tailscaleQr && <img src={urls.tailscaleQr} alt="QR Tailscale" />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span className="badge ok">Global · Tailscale</span>
                      <div className="mono" style={{ margin: '6px 0', wordBreak: 'break-all' }}>{urls.tailscaleUrl}</div>
                      <button className="btn btn-sm" onClick={() => { api.copyText(urls.tailscaleUrl); flash('ok', 'URL de Tailscale copiada.'); }}>
                        <Copy size={13} /> Copiar URL
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="banner">
                    Aún no detecto IP de Tailscale. Ve a <strong>Instalador 1-clic</strong> para habilitar el acceso desde fuera de tu casa.
                  </div>
                )}

                {urls.lanUrl && (
                  <div className="qr-card">
                    {urls.lanQr && <img src={urls.lanQr} alt="QR LAN" />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span className="badge accent">Red local · Wi-Fi</span>
                      <div className="mono" style={{ margin: '6px 0', wordBreak: 'break-all' }}>{urls.lanUrl}</div>
                      <button className="btn btn-sm" onClick={() => { api.copyText(urls.lanUrl); flash('ok', 'URL LAN copiada.'); }}>
                        <Copy size={13} /> Copiar URL
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <h2><Link2 size={17} /> Equipos en tu malla Tailscale y actividad</h2>
                {env.tailscale.peers?.length > 0 ? (
                  <div className="list">
                    {env.tailscale.peers.map((p, idx) => (
                      <div key={idx} className="list-item">
                        <div>
                          <div style={{ fontWeight: 600 }}>{p.hostName || p.dnsName}</div>
                          <div className="muted mono">{p.ip} · {p.os}</div>
                        </div>
                        <span className={`badge ${p.online ? 'ok' : ''}`}>{p.online ? 'En línea' : 'Apagado'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">Cuando inicies sesión en Tailscale en tus otros equipos y tu Android, aparecerán aquí automáticamente.</p>
                )}

                <h3 style={{ marginTop: 6 }}>Registro en vivo</h3>
                <div className="log-box">
                  {server.recentActivity?.length
                    ? server.recentActivity.map((a) => `[${a.ts.slice(11, 19)}] ${a.message}`).join('\n')
                    : 'Sin actividad registrada todavía.'}
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'metrics' && (
          <MetricsView api={api} flash={flash} />
        )}

        {tab === 'chat' && (
          <ChatView api={api} state={state} flash={flash} onUnreadChange={(n) => setUnreadChats(Number(n) || 0)} />
        )}

        {tab === 'host' && (
          <>
            <div className="page-head">
              <div>
                <h1>Carpetas compartidas (Modo Host)</h1>
                <p>Selecciona qué carpetas de este equipo expones por tu túnel cifrado y con qué permisos.</p>
              </div>
              <button className="btn btn-primary" onClick={handleAddShare}>
                <Plus size={16} /> Añadir carpeta
              </button>
            </div>

            <div className="card">
              <div className="list">
                {config.shares.length === 0 && (
                  <p className="muted">No hay carpetas agregadas todavía. Pulsa "Añadir carpeta" para comenzar.</p>
                )}
                {config.shares.map((s) => (
                  <div key={s.id} className="list-item">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row">
                        <strong>{s.name}</strong>
                        <span className={`badge ${s.enabled ? 'ok' : 'warn'}`}>{s.enabled ? 'Activa' : 'Pausada'}</span>
                        <span className={`badge ${s.mode === 'rw' ? 'accent' : ''}`}>
                          {s.mode === 'rw' ? 'Lectura y escritura' : 'Solo lectura'}
                        </span>
                      </div>
                      <div className="muted mono" style={{ marginTop: 4 }}>{s.path}</div>
                    </div>
                    <div className="row">
                      <button
                        className="btn btn-sm"
                        onClick={async () => setState(await api.updateShare(s.id, { mode: s.mode === 'rw' ? 'ro' : 'rw' }))}
                      >
                        Cambiar a {s.mode === 'rw' ? 'Solo lectura' : 'RW'}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={async () => setState(await api.updateShare(s.id, { enabled: !s.enabled }))}
                      >
                        {s.enabled ? 'Pausar' : 'Activar'}
                      </button>
                      <button className="btn btn-sm" onClick={() => api.openLocalFolder(s.path)}>Abrir</button>
                      <button
                        className="btn btn-sm btn-danger"
                        title="Quitar de compartidos"
                        onClick={async () => {
                          setState(await api.removeShare(s.id));
                          flash('ok', `Carpeta "${s.name}" quitada (tus archivos locales no se borran).`);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'keys' && (
          <>
            <div className="page-head">
              <div>
                <h1>Llaves encriptadas y Pendrive</h1>
                <p>Genera llaves cifradas (PBKDF2 + AES-256-GCM + Ed25519), guárdalas en uno o varios pendrives/carpetas o cópialas al portapapeles.</p>
              </div>
              <button className="btn" onClick={refresh}><RefreshCw size={15} /> Detectar USB</button>
            </div>

            <div className="grid-2">
              <form className="card" onSubmit={handleGenerateKey}>
                <h2><KeyRound size={17} /> Generar nueva llave encriptada</h2>
                <div className="field">
                  <label>Nombre identificador</label>
                  <input type="text" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} placeholder="Ej. Pendrive Esteban / Laptop Trabajo" />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Permisos</label>
                    <select value={keyPerm} onChange={(e) => setKeyPerm(e.target.value)}>
                      <option value="rw">Lectura y escritura completa (RW)</option>
                      <option value="ro">Solo lectura (RO)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Alcance de carpetas</label>
                    <select value={keyAllShares ? 'all' : 'custom'} onChange={(e) => setKeyAllShares(e.target.value === 'all')}>
                      <option value="all">Todas las carpetas activas</option>
                      <option value="custom">Elegir carpetas específicas</option>
                    </select>
                  </div>
                </div>

                {!keyAllShares && (
                  <div className="list">
                    {config.shares.map((s) => (
                      <label key={s.id} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={selectedShareIds.includes(s.id)}
                          onChange={(e) => setSelectedShareIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
                        />
                        <span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                )}

                <div className="grid-2">
                  <div className="field">
                    <label>Frase de paso (cifra la llave)</label>
                    <div className="input-wrap">
                      <input
                        type={showKeyPass ? 'text' : 'password'}
                        value={keyPass}
                        onChange={(e) => setKeyPass(e.target.value)}
                        placeholder="Mínimo 6 caracteres"
                      />
                      <button type="button" className="input-eye" onClick={() => setShowKeyPass((v) => !v)} aria-label="Mostrar u ocultar frase">
                        {showKeyPass ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>Confirmar frase de paso</label>
                    <input
                      type={showKeyPass ? 'text' : 'password'}
                      value={keyPass2}
                      onChange={(e) => setKeyPass2(e.target.value)}
                      placeholder="Repetir frase"
                    />
                  </div>
                </div>

                {keyPass && (
                  <div className="field" style={{ gap: 4 }}>
                    <div className="strength-bar">
                      <div className="strength-fill" style={{ width: `${strength.score}%`, background: strength.color }} />
                    </div>
                    <span className="muted" style={{ fontSize: 11.5 }}>Seguridad: <strong style={{ color: strength.color }}>{strength.label}</strong></span>
                  </div>
                )}

                <button type="submit" className="btn btn-primary" disabled={busy}>
                  <ShieldCheck size={16} /> Generar llave encriptada (.ecloudkey)
                </button>
              </form>

              <div className="card">
                <h2><Usb size={17} /> Guardar en pendrive / varias ubicaciones o copiar</h2>
                {!generatedKey ? (
                  <p className="muted">
                    Genera una llave a la izquierda para guardarla simultáneamente en tus pendrives USB detectados, en carpetas de respaldo o copiarla en un clic.
                  </p>
                ) : (
                  <>
                    <div className="banner ok">
                      Llave lista: <strong className="mono">{generatedKey.keyId}</strong> ({generatedKey.suggestedFileName})
                    </div>
                    <div className="field">
                      <label>Destinos donde guardar la llave</label>
                      {env.usbDrives.length > 0 && (
                        <div className="list">
                          {env.usbDrives.map((u) => (
                            <label key={u.drive} className="checkbox-row">
                              <input
                                type="checkbox"
                                checked={saveDirs.includes(u.root)}
                                onChange={(e) => setSaveDirs((prev) => e.target.checked ? [...new Set([...prev, u.root])] : prev.filter((d) => d !== u.root))}
                              />
                              <span><strong>{u.drive}</strong> ({u.label}) — {fmtSize(u.freeBytes)} libres</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {saveDirs.filter((d) => !env.usbDrives.some((u) => u.root === d)).map((dir) => (
                        <div key={dir} className="list-item" style={{ padding: '8px 10px' }}>
                          <span className="mono">{dir}</span>
                          <button className="btn btn-sm btn-danger" onClick={() => setSaveDirs((prev) => prev.filter((x) => x !== dir))}>Quitar</button>
                        </div>
                      ))}
                      <div className="row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn btn-sm" onClick={handleAddSaveDir}>
                          <Plus size={14} /> Añadir carpeta destino
                        </button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveKeyMultiple}>
                          Guardar en {saveDirs.length} ubicación(es)
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label>Texto cifrado portable (para copiar o pegar en móvil/otro PC)</label>
                      <textarea readOnly className="mono" value={generatedKey.clipboardString} />
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => { api.copyText(generatedKey.clipboardString); flash('ok', 'Llave encriptada copiada al portapapeles.'); }}
                        >
                          <Copy size={14} /> Copiar llave encriptada
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => { api.copyText(generatedKey.bundleJson); flash('ok', 'JSON .ecloudkey copiado.'); }}
                        >
                          <Copy size={14} /> Copiar JSON
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="card">
              <h2>Llaves autorizadas en este equipo</h2>
              {config.keys.length === 0 ? (
                <p className="muted">Todavía no has creado ninguna llave.</p>
              ) : (
                <div className="list">
                  {config.keys.map((k) => (
                    <div key={k.keyId} className="list-item">
                      <div>
                        <div className="row">
                          <strong>{k.label}</strong>
                          <span className="mono muted">{k.keyId}</span>
                          <span className={`badge ${k.revoked ? 'danger' : 'ok'}`}>{k.revoked ? 'Revocada' : 'Activa'}</span>
                          <span className="badge accent">{k.permissions === 'rw' ? 'RW' : 'Solo lectura'}</span>
                        </div>
                        <div className="muted" style={{ marginTop: 4 }}>
                          Creada: {new Date(k.createdAt).toLocaleString()} {k.lastUsedAt ? `· Último uso: ${new Date(k.lastUsedAt).toLocaleString()}` : '· Sin uso todavía'}
                        </div>
                      </div>
                      <div className="row">
                        {!k.revoked && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={async () => {
                              setState(await api.revokeKey(k.keyId));
                              flash('ok', `Llave ${k.keyId} revocada al instante.`);
                            }}
                          >
                            <ShieldAlert size={14} /> Revocar
                          </button>
                        )}
                        <button
                          className="btn btn-sm"
                          title="Eliminar registro"
                          onClick={async () => {
                            setState(await api.deleteKey(k.keyId));
                            flash('ok', `Registro de llave ${k.keyId} eliminado.`);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'kit' && (
          <>
            <div className="page-head">
              <div>
                <h1>Pasar Esteban Cloud al Pendrive (Paquete Todo-en-Uno)</h1>
                <p>Exporta en un solo clic un paquete completo listo para enchufar en cualquier otra PC Windows: instalador, lanzador automático, scripts de dependencias y tu llave encriptada.</p>
              </div>
              <button className="btn" onClick={refresh} disabled={busy}>
                <RefreshCw size={15} /> Detectar USB
              </button>
            </div>

            <div className="card hero-card">
              <div className="between">
                <div>
                  <h2><Package size={18} color="#67e8f9" /> Exportar paquete completo al pendrive</h2>
                  <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
                    Crea la carpeta <code>Esteban-Cloud-Kit</code> (y opcionalmente un único archivo <code>.zip</code>) con <strong>1-INSTALAR-ESTEBAN-CLOUD.cmd</strong>, el instalador Windows, scripts PowerShell y tu llave <code>.ecloudkey</code>.
                  </p>
                </div>
                <button className="btn btn-primary btn-lg" onClick={handleExportKit} disabled={busy}>
                  <Usb size={17} /> Pasar todo al Pendrive ahora
                </button>
              </div>

              <div className="grid-2">
                <div className="field">
                  <label>1. Pendrive USB o carpeta destino</label>
                  {env.usbDrives.length > 0 && (
                    <div className="row" style={{ marginBottom: 4 }}>
                      {env.usbDrives.map((u) => (
                        <button
                          key={u.drive}
                          type="button"
                          className={`btn btn-sm ${kitTargetDir === u.root ? 'btn-primary' : ''}`}
                          onClick={() => setKitTargetDir(u.root)}
                        >
                          <Usb size={13} /> {u.drive} ({u.label} · {fmtSize(u.freeBytes)} libres)
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <input
                      type="text"
                      style={{ flex: 1 }}
                      value={kitTargetDir}
                      onChange={(e) => setKitTargetDir(e.target.value)}
                      placeholder="Ej. E:\ o elige una carpeta destino"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const dir = await api.pickSaveFolder();
                        if (dir) setKitTargetDir(dir);
                      }}
                    >
                      <FolderOpen size={14} /> Elegir carpeta
                    </button>
                  </div>
                </div>

                <div className="field">
                  <label>2. Instalador incluido en el paquete</label>
                  <div className="list-item" style={{ padding: '9px 12px' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>
                        {kitCustomInstaller
                          ? kitCustomInstaller.split(/[\\/]/).pop()
                          : installerInfo?.found
                            ? installerInfo.name
                            : 'Instalador no detectado automáticamente'}
                      </div>
                      <div className="muted mono" style={{ wordBreak: 'break-all' }}>
                        {kitCustomInstaller || (installerInfo?.found ? `${fmtSize(installerInfo.size)} · ${installerInfo.path}` : 'Selecciona el .exe manualmente')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const p = await api.pickKitInstaller();
                        if (p) setKitCustomInstaller(p);
                      }}
                    >
                      Cambiar .exe
                    </button>
                  </div>
                </div>
              </div>

              <div className="row">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={kitIncludeGeneratedKey}
                    disabled={!generatedKey}
                    onChange={(e) => setKitIncludeGeneratedKey(e.target.checked)}
                  />
                  <span>
                    {generatedKey
                      ? `Incluir la llave recién generada (${generatedKey.suggestedFileName})`
                      : 'Sin llave recién generada (opcional: crea una en "Llaves y Pendrive" para incluirla aquí)'}
                  </span>
                </label>
                {!generatedKey && (
                  <button type="button" className="btn btn-sm" onClick={() => setTab('keys')}>
                    <KeyRound size={13} /> Crear llave primero
                  </button>
                )}
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={kitCreateZip}
                  onChange={(e) => setKitCreateZip(e.target.checked)}
                />
                <span>Empaquetar también en un solo archivo <code>.zip</code> además de la carpeta lista para doble clic</span>
              </label>
            </div>

            {kitResult && (
              <div className="card">
                <div className="between">
                  <h2><CheckCircle2 size={17} color="#34d399" /> Kit exportado correctamente</h2>
                  <button className="btn btn-sm btn-primary" onClick={() => api.openLocalFolder(kitResult.kitDir)}>
                    <FolderOpen size={14} /> Abrir carpeta del Kit
                  </button>
                </div>
                <div className="list">
                  <div className="list-item">
                    <span>Carpeta lista en destino</span>
                    <span className="mono">{kitResult.kitDir}</span>
                  </div>
                  <div className="list-item">
                    <span>Instalador incluido</span>
                    <span className="mono">{kitResult.installerName} ({fmtSize(kitResult.installerSize)})</span>
                  </div>
                  <div className="list-item">
                    <span>Llave encriptada incluida</span>
                    <span className={`badge ${kitResult.keyIncluded ? 'ok' : ''}`}>
                      {kitResult.keyIncluded ? kitResult.keyFileName : 'No incluida (solo programa + scripts)'}
                    </span>
                  </div>
                  {kitResult.zipPath && (
                    <div className="list-item">
                      <span>Archivo único ZIP</span>
                      <span className="mono">{kitResult.zipPath}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="card">
              <h2>Qué va dentro de tu pendrive</h2>
              <div className="grid-3">
                <div className="step-card done">
                  <strong>1-INSTALAR-ESTEBAN-CLOUD.cmd</strong>
                  <p className="muted" style={{ margin: 0 }}>En cualquier otra PC Windows, haces doble clic ahí: instala el programa y lo abre automáticamente.</p>
                </div>
                <div className="step-card done">
                  <strong>Setup .exe + Scripts 1-clic</strong>
                  <p className="muted" style={{ margin: 0 }}>Lleva el instalador oficial local + el script PowerShell para instalar Tailscale, rclone, WinFsp y Firewall.</p>
                </div>
                <div className="step-card done">
                  <strong>Tu llave .ecloudkey + guía</strong>
                  <p className="muted" style={{ margin: 0 }}>Al abrir la app en el otro PC, "Buscar llaves en USB" la detecta automáticamente dentro de <code>Esteban-Cloud-Kit</code>.</p>
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'client' && (
          <>
            <div className="page-head">
              <div>
                <h1>Conectar a otro equipo (Modo Cliente · Bidireccional)</h1>
                <p>Arrastra o carga tu llave <code>.ecloudkey</code> desde el pendrive para montar carpetas remotas como unidad <code>Z:</code> o explorarlas directamente aquí.</p>
              </div>
              <div className="row">
                <button className="btn" onClick={handleScanUsb}><Usb size={15} /> Buscar llaves en USB</button>
                <button className="btn" onClick={handlePickKeyFile}><FolderOpen size={15} /> Cargar .ecloudkey</button>
              </div>
            </div>

            {usbKeys.length > 0 && (
              <div className="card">
                <h3>Llaves detectadas en pendrives USB</h3>
                <div className="row">
                  {usbKeys.map((uk) => (
                    <button
                      key={uk.filePath}
                      className="btn btn-sm"
                      onClick={() => {
                        setBundleFilePath(uk.filePath);
                        setBundleText('');
                        flash('ok', `Seleccionada: ${uk.filePath}`);
                      }}
                    >
                      <KeyRound size={14} /> {uk.drive} {uk.fileName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid-2">
              <form
                className="card"
                onSubmit={handleConnect}
                onDragOver={(e) => { e.preventDefault(); setDraggingKey(true); }}
                onDragLeave={() => setDraggingKey(false)}
                onDrop={handleDropKeyFile}
              >
                <h2>Desbloquear y conectar</h2>
                <div className={`dropzone ${draggingKey ? 'dragging' : ''}`}>
                  <div className="between">
                    <span className="muted">
                      {bundleFilePath
                        ? <>Archivo listo: <strong className="mono" style={{ color: '#bae6fd' }}>{bundleFilePath}</strong></>
                        : 'Arrastra aquí tu archivo .ecloudkey desde tu pendrive, o pega el texto abajo.'}
                    </span>
                    <button type="button" className="btn btn-sm" onClick={handlePickKeyFile}>Examinar</button>
                  </div>
                </div>
                <div className="field">
                  <label>O pegar texto encriptado</label>
                  <textarea
                    className="mono"
                    value={bundleText}
                    onChange={(e) => { setBundleText(e.target.value); setBundleFilePath(''); }}
                    placeholder="ECLOUD1:... o JSON .ecloudkey"
                  />
                </div>
                <div className="field">
                  <label>Frase de paso de la llave</label>
                  <div className="input-wrap">
                    <input
                      type={showClientPass ? 'text' : 'password'}
                      value={clientPass}
                      onChange={(e) => setClientPass(e.target.value)}
                      placeholder="Escribe la frase secreta de esta llave"
                    />
                    <button type="button" className="input-eye" onClick={() => setShowClientPass((v) => !v)} aria-label="Mostrar u ocultar frase">
                      {showClientPass ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowAdvancedClient((v) => !v)}
                  >
                    {showAdvancedClient ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas (URL manual)'}
                  </button>
                  {showAdvancedClient && (
                    <div className="field" style={{ marginTop: 8 }}>
                      <label>URL manual del nodo (opcional — normalmente dejar vacío)</label>
                      <input
                        type="text"
                        value={overrideUrl}
                        onChange={(e) => setOverrideUrl(e.target.value)}
                        placeholder="Auto (Tailscale → LAN), ej. http://100.x.x.x:4789"
                      />
                    </div>
                  )}
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  <Link2 size={16} /> Conectar al nodo remoto
                </button>
              </form>

              <div className="card">
                <h2>Unidades montadas y equipos guardados</h2>
                {mounts.length === 0 ? (
                  <p className="muted">No hay unidades remotas montadas todavía. Conéctate a un nodo y pulsa <strong>Montar como disco Z:</strong>.</p>
                ) : (
                  <div className="list">
                    {mounts.map((m) => (
                      <div key={m.drive} className="list-item">
                        <div>
                          <strong>{m.drive} — {m.label}</strong>
                          <div className="muted mono">{m.url}</div>
                        </div>
                        <div className="row">
                          <button className="btn btn-sm btn-primary" onClick={() => api.openDrive(m.drive)}>Abrir</button>
                          <button className="btn btn-sm btn-danger" onClick={async () => setState(await api.unmountDrive(m.drive))}>Desmontar</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {activeSession && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    <div className="between" style={{ marginBottom: 8 }}>
                      <div>
                        <strong>Sesión activa: {activeSession.nodeName}</strong>
                        <div className="muted mono">{activeSession.baseUrl}</div>
                      </div>
                      <button className="btn btn-sm btn-danger" onClick={async () => setState(await api.disconnectClient(activeSession.sessionId))}>
                        Desconectar
                      </button>
                    </div>
                    <div className="row">
                      <select style={{ width: 96 }} value={driveLetter} onChange={(e) => setDriveLetter(e.target.value)}>
                        {['Z:', 'Y:', 'X:', 'W:', 'V:', 'U:'].map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                      <button className="btn btn-primary" onClick={handleMountDrive} disabled={busy}>
                        <HardDrive size={15} /> Montar como disco {driveLetter}
                      </button>
                    </div>
                  </div>
                )}

                {config.savedPeers?.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    <h3 style={{ marginBottom: 8 }}><Bookmark size={14} /> Equipos guardados</h3>
                    <div className="list">
                      {config.savedPeers.map((peer) => (
                        <div key={peer.id} className="list-item" style={{ padding: '9px 12px' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600 }}>{peer.nodeName || peer.label}</div>
                            <div className="muted mono">{peer.tailscaleIp || peer.lanIp || 'Auto'} · {peer.keyId}</div>
                          </div>
                          <div className="row">
                            {peer.keyFilePath && (
                              <button
                                className="btn btn-sm"
                                onClick={() => {
                                  setBundleFilePath(peer.keyFilePath);
                                  setBundleText('');
                                  flash('info', `Llave seleccionada (${peer.keyFilePath}). Ingresa la frase de paso y pulsa Conectar.`);
                                }}
                              >
                                Usar
                              </button>
                            )}
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={async () => setState(await api.removePeer(peer.id))}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {activeSession && (
              <div className="card">
                <div className="between">
                  <h2>Explorador remoto integrado · {activeSession.nodeName}</h2>
                  {activeRemoteShare && (
                    <div className="row">
                      <div style={{ position: 'relative', width: 200 }}>
                        <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#94a3b8' }} />
                        <input
                          type="text"
                          value={remoteSearch}
                          onChange={(e) => setRemoteSearch(e.target.value)}
                          placeholder="Filtrar archivos..."
                          style={{ paddingLeft: 30, paddingTop: 6, paddingBottom: 6, fontSize: 12.5 }}
                        />
                      </div>
                      <button className="btn btn-sm" onClick={() => loadRemoteDir(activeSession.sessionId, activeRemoteShare, remotePath)}>
                        <RefreshCw size={13} /> Actualizar
                      </button>
                      {activeRemoteShare.effectiveMode === 'rw' && (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={async () => {
                              const r = await api.uploadRemoteFiles({ sessionId: activeSession.sessionId, shareId: activeRemoteShare.id, relPath: remotePath });
                              if (!r.canceled) {
                                flash('ok', `Subido(s): ${r.uploaded.join(', ')}`);
                                loadRemoteDir(activeSession.sessionId, activeRemoteShare, remotePath);
                              }
                            }}
                          >
                            <Upload size={13} /> Subir
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={async () => {
                              const name = window.prompt('Nombre de la nueva carpeta:');
                              if (!name) return;
                              await api.createRemoteFolder({ sessionId: activeSession.sessionId, shareId: activeRemoteShare.id, relPath: remotePath, name });
                              loadRemoteDir(activeSession.sessionId, activeRemoteShare, remotePath);
                            }}
                          >
                            <FolderPlus size={13} /> + Carpeta
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {!activeRemoteShare ? (
                  <div className="grid-3">
                    {activeSession.shares.map((s) => (
                      <button
                        key={s.id}
                        className="list-item"
                        style={{ cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
                        onClick={() => loadRemoteDir(activeSession.sessionId, s, '')}
                      >
                        <div>
                          <strong>📁 {s.name}</strong>
                          <div className="muted">{s.effectiveMode === 'rw' ? 'Lectura y escritura' : 'Solo lectura'}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="row">
                      <button className="btn btn-sm" onClick={() => { setActiveRemoteShare(null); setRemotePath(''); }}>← Carpetas</button>
                      {remotePath && (
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            const parts = remotePath.split('/').filter(Boolean);
                            parts.pop();
                            loadRemoteDir(activeSession.sessionId, activeRemoteShare, parts.join('/'));
                          }}
                        >
                          ↑ Subir nivel
                        </button>
                      )}
                      <span className="mono muted">{activeRemoteShare.name}/{remotePath}</span>
                    </div>
                    <div className="list">
                      {filteredRemoteItems.length === 0 && <p className="muted">Sin elementos para mostrar.</p>}
                      {filteredRemoteItems.map((it) => {
                        const full = remotePath ? `${remotePath}/${it.name}` : it.name;
                        return (
                          <div key={full} className="list-item" style={{ padding: '9px 12px' }}>
                            <div
                              style={{ cursor: it.isDirectory ? 'pointer' : 'default', flex: 1 }}
                              onClick={() => it.isDirectory && loadRemoteDir(activeSession.sessionId, activeRemoteShare, full)}
                            >
                              <span>{it.isDirectory ? '📁' : '📄'} {it.name}</span>
                              {!it.isDirectory && <span className="muted" style={{ marginLeft: 10 }}>{fmtSize(it.size)}</span>}
                            </div>
                            <div className="row">
                              {!it.isDirectory && (
                                <button
                                  className="btn btn-sm"
                                  onClick={async () => {
                                    const r = await api.downloadRemoteFile({ sessionId: activeSession.sessionId, shareId: activeRemoteShare.id, relPath: full, fileName: it.name });
                                    if (!r.canceled) flash('ok', `Descargado en ${r.savedPath}`);
                                  }}
                                >
                                  <Download size={13} /> Descargar
                                </button>
                              )}
                              {activeRemoteShare.effectiveMode === 'rw' && (
                                <>
                                  <button
                                    className="btn btn-sm"
                                    title="Renombrar"
                                    onClick={async () => {
                                      const nextName = window.prompt('Nuevo nombre:', it.name);
                                      if (!nextName || nextName === it.name) return;
                                      const to = remotePath ? `${remotePath}/${nextName}` : nextName;
                                      await api.renameRemoteItem({ sessionId: activeSession.sessionId, shareId: activeRemoteShare.id, from: full, to });
                                      loadRemoteDir(activeSession.sessionId, activeRemoteShare, remotePath);
                                    }}
                                  >
                                    <Pencil size={13} />
                                  </button>
                                  <button
                                    className="btn btn-sm btn-danger"
                                    title="Eliminar"
                                    onClick={async () => {
                                      if (!window.confirm(`¿Eliminar "${it.name}"?`)) return;
                                      await api.deleteRemoteItem({ sessionId: activeSession.sessionId, shareId: activeRemoteShare.id, relPath: full });
                                      loadRemoteDir(activeSession.sessionId, activeRemoteShare, remotePath);
                                    }}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'deps' && (
          <>
            <div className="page-head">
              <div>
                <h1>Instalador automático con un solo botón</h1>
                <p>Instala y configura automáticamente con PowerShell + <code>winget</code> todo lo necesario para tu túnel global cifrado y montaje de discos <code>Z:</code>.</p>
              </div>
              <button className="btn" onClick={refresh}><RefreshCw size={15} /> Re-comprobar</button>
            </div>

            <div className="card hero-card">
              <div className="between">
                <div>
                  <h2><Wrench size={18} color="#67e8f9" /> Instalación completa en 1 clic</h2>
                  <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
                    Instala <strong>Tailscale</strong> (túnel global), <strong>rclone</strong> + <strong>WinFsp</strong> (disco <code>Z:</code>) y crea el Firewall limitado solo a Tailscale y tu red privada.
                  </p>
                </div>
                <button className="btn btn-primary btn-lg" onClick={handleInstallDeps} disabled={busy}>
                  <Wrench size={17} /> Instalar y configurar todo ahora
                </button>
              </div>
              <div className="row">
                <label className="checkbox-row">
                  <input type="checkbox" checked={optDisableSleep} onChange={(e) => setOptDisableSleep(e.target.checked)} />
                  <span>Evitar suspensión automática (enchufado)</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={optOpenSsh} onChange={(e) => setOptOpenSsh(e.target.checked)} />
                  <span>Instalar OpenSSH Server (SFTP opcional)</span>
                </label>
                <button className="btn btn-sm" onClick={() => api.launchTailscale()}>
                  <Globe size={14} /> Abrir / iniciar sesión en Tailscale
                </button>
                <button className="btn btn-sm" onClick={() => api.openScriptsFolder()}>
                  <FolderOpen size={14} /> Ver scripts PowerShell
                </button>
              </div>
              {installLog && <div className="log-box">{installLog}</div>}
            </div>

            <div className="card">
              <h2>Estado de dependencias en {env.hostName}</h2>
              <div className="grid-2">
                {[
                  { name: 'Tailscale (túnel global WireGuard)', ok: env.tailscale.installed, detail: env.tailscale.running ? `Conectado (${env.tailscale.ip})` : env.tailscale.installed ? 'Instalado · falta iniciar sesión' : 'Falta instalar' },
                  { name: 'rclone (montaje bidireccional WebDAV)', ok: env.rclone.installed, detail: env.rclone.installed ? env.rclone.path : 'Falta instalar' },
                  { name: 'WinFsp (driver de disco virtual Z:)', ok: env.winfsp.installed, detail: env.winfsp.installed ? 'Instalado y listo' : 'Falta instalar' },
                  { name: 'OpenSSH Server (SFTP nativo opcional)', ok: env.sshd.running, detail: env.sshd.installed ? env.sshd.status : 'Opcional (no instalado)' }
                ].map((item) => (
                  <div key={item.name} className="list-item">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div className="muted mono" style={{ wordBreak: 'break-all' }}>{item.detail}</div>
                    </div>
                    {item.ok ? <CheckCircle2 size={18} color="#34d399" /> : <AlertCircle size={18} color="#fbbf24" />}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'settings' && (
          <>
            <div className="page-head">
              <div>
                <h1>Ajustes, actualizaciones y acerca de</h1>
                <p>Configura el arranque automático al encender tu PC y revisa el canal propio de actualizaciones.</p>
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h2>Configuración del nodo</h2>
                <div className="field">
                  <label>Nombre visible de este equipo</label>
                  <input
                    type="text"
                    value={config.nodeName}
                    onChange={(e) => setState({ ...state, config: { ...config, nodeName: e.target.value } })}
                  />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Puerto TCP</label>
                    <input
                      type="number"
                      value={config.port}
                      onChange={(e) => setState({ ...state, config: { ...config, port: Number(e.target.value) } })}
                    />
                  </div>
                  <div className="field">
                    <label>Interfaz de escucha</label>
                    <select
                      value={config.bindMode}
                      onChange={(e) => setState({ ...state, config: { ...config, bindMode: e.target.value } })}
                    >
                      <option value="all">Tailscale + Red Local (Recomendado)</option>
                      <option value="tailscale">Solo túnel Tailscale (más estricto)</option>
                    </select>
                  </div>
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.autoStartServer}
                    onChange={(e) => setState({ ...state, config: { ...config, autoStartServer: e.target.checked } })}
                  />
                  <span>Activar servidor automáticamente al abrir Esteban Cloud</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.startWithWindows}
                    onChange={(e) => setState({ ...state, config: { ...config, startWithWindows: e.target.checked } })}
                  />
                  <span>Iniciar Esteban Cloud automáticamente cuando encienda Windows</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.minimizeToTray}
                    onChange={(e) => setState({ ...state, config: { ...config, minimizeToTray: e.target.checked } })}
                  />
                  <span>Mantener activo en la bandeja del sistema al cerrar la ventana</span>
                </label>

                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    const next = await api.updateSettings({
                      nodeName: config.nodeName,
                      port: config.port,
                      bindMode: config.bindMode,
                      autoStartServer: config.autoStartServer,
                      startWithWindows: config.startWithWindows,
                      minimizeToTray: config.minimizeToTray,
                      updateShareDir: config.updateShareDir,
                      updateServerUrl: config.updateServerUrl,
                      updateGithubRepo: config.updateGithubRepo,
                      enableGithubUpdates: config.enableGithubUpdates,
                      autoCheckUpdates: config.autoCheckUpdates,
                      autoDownloadUpdates: config.autoDownloadUpdates,
                      autoInstallWhenIdle: config.autoInstallWhenIdle
                    });
                    setState(next);
                    flash('ok', 'Ajustes guardados.');
                  }}
                >
                  Guardar cambios
                </button>
              </div>

              <div className="card">
                <h2>Actualizador automático (Tailscale + GitHub Releases)</h2>
                <p className="muted">
                  Busca automáticamente la versión más reciente tanto en tus equipos de <strong>Tailscale</strong> como en <strong>GitHub Releases</strong>, descarga con verificación <strong>SHA-256</strong> y actualiza automáticamente cuando no hay discos en uso.
                </p>

                <div className="field">
                  <label>Repositorio de GitHub para actualizaciones automáticas</label>
                  <input
                    type="text"
                    value={config.updateGithubRepo || 'estebanico10/esteban-cloud'}
                    onChange={(e) => setState({ ...state, config: { ...config, updateGithubRepo: e.target.value } })}
                    placeholder="estebanico10/esteban-cloud"
                  />
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.enableGithubUpdates !== false}
                    onChange={(e) => setState({ ...state, config: { ...config, enableGithubUpdates: e.target.checked } })}
                  />
                  <span>Activar canal automático de GitHub Releases (funciona incluso sin PC principal encendida)</span>
                </label>

                <div className="field">
                  <label>Carpeta local que comparte actualizaciones (en tu PC principal)</label>
                  <div className="row">
                    <input
                      type="text"
                      style={{ flex: 1 }}
                      value={config.updateShareDir || ''}
                      onChange={(e) => setState({ ...state, config: { ...config, updateShareDir: e.target.value } })}
                      placeholder="E:\CODE\ESTEBAN CLOUD\release"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const dir = await api.pickSaveFolder();
                        if (dir) setState({ ...state, config: { ...config, updateShareDir: dir } });
                      }}
                    >
                      Elegir
                    </button>
                  </div>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {hostedUpdate
                      ? `Compartiendo ahora a tus otros equipos: v${hostedUpdate.version} (${hostedUpdate.fileName} · ${fmtSize(hostedUpdate.size)})`
                      : 'Sin instalador detectado aún en esa carpeta.'}
                  </span>
                </div>

                <div className="field">
                  <label>URL fija del equipo servidor de actualizaciones (opcional — vacío = automático en Tailscale)</label>
                  <input
                    type="text"
                    value={config.updateServerUrl || ''}
                    onChange={(e) => setState({ ...state, config: { ...config, updateServerUrl: e.target.value } })}
                    placeholder="Auto (detecta PRO-NICOLA y equipos conectados en Tailscale)"
                  />
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.autoCheckUpdates !== false}
                    onChange={(e) => setState({ ...state, config: { ...config, autoCheckUpdates: e.target.checked } })}
                  />
                  <span>Buscar actualizaciones automáticamente en segundo plano (cada 15 min y al conectar)</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.autoDownloadUpdates !== false}
                    onChange={(e) => setState({ ...state, config: { ...config, autoDownloadUpdates: e.target.checked } })}
                  />
                  <span>Pre-descargar y verificar SHA-256 automáticamente cuando aparezca una versión nueva</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.autoInstallWhenIdle !== false}
                    onChange={(e) => setState({ ...state, config: { ...config, autoInstallWhenIdle: e.target.checked } })}
                  />
                  <span>Instalar y reiniciar automáticamente si no hay discos Z:/Y: montados en uso</span>
                </label>

                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      setBusy(true);
                      setUpdateProgress(null);
                      try {
                        const info = await api.checkUpdates();
                        setUpdateInfo(info);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    <RefreshCw size={15} /> Buscar actualizaciones
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const res = await api.pushUpdateToConnectedPeers();
                        const summary = (res.results || []).map((r) =>
                          r.ok
                            ? `${r.peer}: ${r.mode === 'push-notify' ? 'aviso push enviado' : `paquete subido a ${r.destination}`}`
                            : `${r.peer}: ${r.reason}`
                        ).join(' | ');
                        flash('ok', `Envío de actualización: ${summary}`);
                      } catch (err) {
                        flash('error', err.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Upload size={15} /> Enviar a equipos conectados
                  </button>
                  {updateInfo && (updateInfo.downloadUrl || updateInfo.localPath) && updateInfo.status === 'update-available' && (
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api.downloadAndInstallUpdate(updateInfo);
                        } catch (err) {
                          setUpdateProgress(null);
                          flash('error', err.message);
                          setBusy(false);
                        }
                      }}
                    >
                      <Download size={15} /> Descargar e instalar v{updateInfo.latestVersion}
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => api.openExternal(`https://github.com/${config.updateGithubRepo || 'estebanico10/esteban-cloud'}/releases`)}>
                    <ExternalLink size={14} /> GitHub Releases
                  </button>
                </div>

                {updateProgress && (
                  <div className="field" style={{ gap: 4 }}>
                    <div className="strength-bar">
                      <div className="strength-fill" style={{ width: `${updateProgress.percent || 0}%`, background: '#38bdf8' }} />
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {updateProgress.stage === 'installing'
                        ? 'SHA-256 verificado. Instalando actualización y reiniciando...'
                        : `Descargando actualización: ${updateProgress.percent || 0}% (${fmtSize(updateProgress.received)} / ${fmtSize(updateProgress.total)})`}
                    </span>
                  </div>
                )}

                {updateInfo && (
                  <div className={`banner ${updateInfo.status === 'update-available' ? 'ok' : ''}`}>
                    <div><strong>Actual: v{updateInfo.currentVersion}</strong> · {updateInfo.message}</div>
                    {updateInfo.sha256 && (
                      <div className="mono muted" style={{ marginTop: 4, fontSize: 11 }}>SHA-256: {updateInfo.sha256.slice(0, 24)}...</div>
                    )}
                  </div>
                )}

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 6 }}>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <BrandEmblem />
                    <div>
                      <div style={{ fontWeight: 700 }}>Esteban Cloud v{state.appVersion}</div>
                      <div className="muted">Hecho por Esteban Nicola · canal: estebanico10/esteban-cloud + red Tailscale</div>
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => api.openExternal('https://estebanico.com')}>
                    <ExternalLink size={14} /> estebanico.com
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
