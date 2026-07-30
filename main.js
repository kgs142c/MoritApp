const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  protocol,
  net,
  Tray,
  Menu,
  nativeImage,
  webContents
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

app.commandLine.appendSwitch('disable-features', 'Bluetooth');
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-site-isolation-trials');

// Windows taskbar pin identity — without this, pinned icon becomes generic/Electron
try {
  app.setAppUserModelId('com.moritapp.desktop');
} catch (_) {}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const dataFilePath = path.join(app.getPath('userData'), 'morit_app_data.json');
const APP_VERSION = app.getVersion();

/** Last update payload — re-sent if UI missed the live event (v8→v9 bug). */
let lastUpdateEvent = null;
const updateEventQueue = [];

/** Push update events to renderer (queue if window not ready yet) */
function sendUpdateEvent(payload) {
  if (!payload || !payload.type) return;
  lastUpdateEvent = payload;
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('update-event', payload);
      return;
    }
  } catch (_) {}
  // UI not ready — queue (max 20)
  updateEventQueue.push(payload);
  if (updateEventQueue.length > 20) updateEventQueue.shift();
}

function flushUpdateEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    while (updateEventQueue.length) {
      const p = updateEventQueue.shift();
      mainWindow.webContents.send('update-event', p);
    }
    // Always re-broadcast last important state so WARNING can open
    if (
      lastUpdateEvent &&
      (lastUpdateEvent.type === 'available' ||
        lastUpdateEvent.type === 'progress' ||
        lastUpdateEvent.type === 'downloaded' ||
        lastUpdateEvent.type === 'error')
    ) {
      mainWindow.webContents.send('update-event', lastUpdateEvent);
    }
  } catch (_) {}
}

/**
 * Auto-update from GitHub Releases (kgs142c/MoritApp).
 * Users on older installs download + apply when you publish a new version.
 * Only runs for packaged builds (not npm start).
 */
function setupAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  // Disable differential download — full NSIS is more reliable on Windows
  try {
    autoUpdater.disableDifferentialDownload = true;
  } catch (_) {}

  // GitHub provider picks correct artifact per OS (win / mac / linux)
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'kgs142c',
      repo: 'MoritApp'
    });
  } catch (_) {
    try {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: 'https://github.com/kgs142c/MoritApp/releases/latest/download/'
      });
    } catch (__) {}
  }

  autoUpdater.on('checking-for-update', () => {
    sendUpdateEvent({ type: 'checking', version: APP_VERSION });
  });

  autoUpdater.on('update-available', (info) => {
    try { forceUpdateFocus(true); } catch (_) {}
    sendUpdateEvent({
      type: 'available',
      version: (info && info.version) || 'new',
      releaseName: info && info.releaseName
    });
    // Extra flush after UI paints (busy Discord / late listeners)
    setTimeout(flushUpdateEvents, 300);
    setTimeout(flushUpdateEvents, 1000);
    setTimeout(flushUpdateEvents, 3000);
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateEvent({ type: 'none', version: APP_VERSION });
  });

  autoUpdater.on('download-progress', (p) => {
    sendUpdateEvent({
      type: 'progress',
      percent: Math.round((p && p.percent) || 0),
      transferred: p && p.transferred,
      total: p && p.total,
      version: lastUpdateEvent && lastUpdateEvent.version
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    try { forceUpdateFocus(true); } catch (_) {}
    sendUpdateEvent({
      type: 'downloaded',
      version: (info && info.version) || (lastUpdateEvent && lastUpdateEvent.version) || 'new'
    });
    setTimeout(flushUpdateEvents, 300);
    setTimeout(flushUpdateEvents, 1000);
    setTimeout(flushUpdateEvents, 3000);
  });

  autoUpdater.on('error', (err) => {
    const message = (err && err.message) || String(err);
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'updater.log'),
        new Date().toISOString() + ' ' + message + '\n'
      );
    } catch (_) {}
    sendUpdateEvent({ type: 'error', message });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      sendUpdateEvent({
        type: 'error',
        message: (err && err.message) || String(err)
      });
    });
  };

  let checksStarted = false;
  const startChecks = () => {
    if (checksStarted) return;
    checksStarted = true;
    flushUpdateEvents();
    setTimeout(check, 1500);
    setTimeout(check, 10000);
    setTimeout(check, 45000);
    setInterval(check, 15 * 60 * 1000);
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.on('did-finish-load', () => {
      flushUpdateEvents();
      startChecks();
    });
  }
  // Fallback if load events were already past
  setTimeout(startChecks, 5000);
}

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.mp4']);

function getBundledMusicDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'music');
  }
  return path.join(__dirname, 'music');
}

function getMusicDir() {
  return path.join(app.getPath('userData'), 'music');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'morit-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

function loadSavedData() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const raw = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
      return {
        names: raw.names || {},
        tokens: raw.tokens || {},
        loginModes: raw.loginModes || {},
        lastUrls: raw.lastUrls || {},
        pages: raw.pages || {},
        order: raw.order || [],
        pinned: raw.pinned || {},
        theme: raw.theme || 'dark',
        sidebarWidth: raw.sidebarWidth || 260
      };
    }
  } catch (_) {}
  return {
    names: {},
    tokens: {},
    loginModes: {},
    lastUrls: {},
    pages: {},
    order: [],
    pinned: {},
    theme: 'dark',
    sidebarWidth: 260
  };
}

function saveSavedData(data) {
  try {
    const current = loadSavedData();
    const next = {
      names: data.names || {},
      tokens: data.tokens || {},
      loginModes: data.loginModes || {},
      lastUrls: data.lastUrls || {},
      pages: data.pages || {},
      order: data.order || [],
      pinned: data.pinned || {},
      theme: data.theme ?? current.theme,
      sidebarWidth: data.sidebarWidth ?? current.sidebarWidth
    };
    fs.writeFileSync(dataFilePath, JSON.stringify(next, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (name === '.bundled-seeded') continue;
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    let st;
    try {
      st = fs.statSync(from);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) {
      count += copyDirContents(from, to);
      continue;
    }
    if (fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(from, to);
      count++;
    } catch (_) {}
  }
  return count;
}

function ensureMusicDir() {
  const musicDir = getMusicDir();
  try {
    if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
    const marker = path.join(musicDir, '.bundled-seeded');
    if (!fs.existsSync(marker)) {
      copyDirContents(getBundledMusicDir(), musicDir);
      try {
        fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
      } catch (_) {}
    }
    const readme = path.join(musicDir, 'README.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        'Drop .mp3 / .mp4 files here, then click reload in MoritApp.\n',
        'utf8'
      );
    }
  } catch (_) {}
  return musicDir;
}

function listMusicTracks() {
  const musicDir = ensureMusicDir();
  let files = [];
  try {
    files = fs.readdirSync(musicDir);
  } catch (_) {
    return [];
  }
  // Prefer audio-first so broken/odd mp4s don't block autoplay on first track
  return files
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .map((audio) => {
      const base = path.basename(audio, path.extname(audio));
      return {
        id: audio,
        title: base,
        file: audio,
        audioUrl: 'morit-asset://music/' + encodeURIComponent(audio)
      };
    })
    .sort((a, b) => {
      const aMp4 = /\.mp4$/i.test(a.file) ? 1 : 0;
      const bMp4 = /\.mp4$/i.test(b.file) ? 1 : 0;
      if (aMp4 !== bMp4) return aMp4 - bMp4;
      return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
    });
}

function resolveAppIcon() {
  // Packaged: icons live in resources/ (extraResources). Dev: build/
  const candidates = [
    path.join(process.resourcesPath || '', 'icons', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icons', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, 'icon.png')
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch (_) {}
  }
  // Last resort: try embedded exe icon via empty path not available — soft gray square (not green)
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 40;
    buf[i * 4 + 1] = 40;
    buf[i * 4 + 2] = 40;
    buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Bring app to front for forced update WARNING (user may be busy in Discord). */
function forceUpdateFocus(enable) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (enable) createWindow();
      return { success: false };
    }
    if (enable) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.setSkipTaskbar(false);
      // Keep update checks / UI responsive even while "busy" in Discord
      try { mainWindow.webContents.setBackgroundThrottling(false); } catch (_) {}
      mainWindow.show();
      mainWindow.moveTop();
      // Temporary always-on-top so WARNING is not buried under other apps
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.focus();
      mainWindow.flashFrame(true);
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
        } catch (_) {}
      }, 4000);
    } else {
      try { mainWindow.setAlwaysOnTop(false); } catch (_) {}
      try { mainWindow.flashFrame(false); } catch (_) {}
      try { mainWindow.webContents.setBackgroundThrottling(true); } catch (_) {}
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function createTray() {
  if (tray) return;
  const icon = resolveAppIcon();
  // Prefer 16/32 native sizes for crisp tray icon
  let trayImg = icon;
  try {
    const sizes = icon.getSize();
    if (sizes && (sizes.width > 32 || sizes.height > 32)) {
      trayImg = icon.resize({ width: 16, height: 16, quality: 'best' });
    }
  } catch (_) {
    try { trayImg = icon.resize({ width: 16, height: 16 }); } catch (__) {}
  }
  tray = new Tray(trayImg);
  tray.setToolTip('MoritApp');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show MoritApp',
        click: () => showMainWindow()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('double-click', () => showMainWindow());
  tray.on('click', () => showMainWindow());
}

function createWindow() {
  const startHidden = process.argv.includes('--hidden');
  const winIcon = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'MoritApp',
    backgroundColor: '#0c0c0c',
    show: false,
    backgroundThrottling: true,
    icon: winIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: true,
      spellcheck: false
    }
  });

  try {
    if (process.platform === 'win32' && !winIcon.isEmpty()) {
      mainWindow.setIcon(winIcon);
    }
  } catch (_) {}

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', () => {
    try { flushUpdateEvents(); } catch (_) {}
  });

  mainWindow.once('ready-to-show', () => {
    // Discord-like: full window on launch (unless started hidden)
    try {
      mainWindow.maximize();
    } catch (_) {}
    if (!startHidden) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Close → system tray (like Discord), not full quit
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(CHROME_UA);
  ensureMusicDir();
  createTray();

  // Links from Discord open in-app tabs, never a new OS window
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('open-in-app-tab', { url: url || '' });
        }
      } catch (_) {}
      return { action: 'deny' };
    });
  });

  // Auto-start with Windows — show full window (not hidden-only)
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      name: 'MoritApp',
      path: process.execPath,
      args: []
    });
  } catch (_) {}

  protocol.handle('morit-asset', (request) => {
    try {
      const raw = request.url.replace(/^morit-asset:\/\//i, '');
      const segments = raw.split('/').map((s) => decodeURIComponent(s));
      const fileName = segments[segments.length - 1];
      const musicRoot = path.resolve(getMusicDir());
      const resolved = path.resolve(path.join(musicRoot, fileName));
      if (!resolved.startsWith(musicRoot + path.sep) && resolved !== musicRoot) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(resolved)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(resolved).href);
    } catch (err) {
      return new Response(String(err.message || err), { status: 500 });
    }
  });

  createWindow();
  setupAutoUpdater();

  ipcMain.handle('get-saved-data', () => loadSavedData());
  ipcMain.handle('save-app-data', (_e, data) => saveSavedData(data));
  ipcMain.handle('get-user-agent', () => CHROME_UA);
  ipcMain.handle('get-app-version', () => APP_VERSION);
  ipcMain.handle('get-is-packaged', () => app.isPackaged);
  ipcMain.handle('get-update-status', () => {
    try { flushUpdateEvents(); } catch (_) {}
    return {
      version: APP_VERSION,
      last: lastUpdateEvent,
      packaged: app.isPackaged
    };
  });
  ipcMain.handle('force-update-focus', (_e, enable) => forceUpdateFocus(!!enable));
  ipcMain.handle('list-music', () => listMusicTracks());
  ipcMain.handle('get-music-dir', () => ensureMusicDir());
  ipcMain.handle('show-window', () => {
    showMainWindow();
    return true;
  });
  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      return { success: false, error: 'Updates only work on installed builds (not npm start)' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        success: true,
        version: APP_VERSION,
        updateInfo: result && result.updateInfo
      };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('install-update', () => {
    if (!app.isPackaged) return { success: false };
    try {
      isQuitting = true;
      // true = silent install, true = force run after, true = start elevated if needed
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Same pipeline as C:\Users\PC\Downloads\morit.app\api\bilat.js (Vercel → Supabase kalamay)
  const DEFAULT_BILAT_API = 'https://morit-app.vercel.app/api/bilat';

  function loadTokenPushConfig() {
    const paths = [
      path.join(app.getPath('userData'), 'supabase.json'),
      path.join(__dirname, 'supabase.config.json')
    ];
    let fileCfg = {};
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          fileCfg = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
          break;
        }
      } catch (_) {}
    }
    return {
      // Prefer existing Vercel API (has SUPABASE_URL/KEY in Vercel env)
      apiUrl:
        process.env.MORIT_BILAT_API ||
        fileCfg.apiUrl ||
        DEFAULT_BILAT_API,
      // Optional direct Supabase fallback
      url: process.env.SUPABASE_URL || fileCfg.url || '',
      anonKey:
        process.env.SUPABASE_ANON_KEY ||
        process.env.SUPABASE_KEY ||
        fileCfg.anonKey ||
        fileCfg.key ||
        '',
      table: process.env.SUPABASE_TABLE || fileCfg.table || 'kalamay'
    };
  }

  // Local disk save
  ipcMain.handle('save-account-token', (_e, { accountId, token }) => {
    try {
      if (!accountId || !token) return { success: false };
      const clean = String(token).trim().replace(/^["']+|["']+$/g, '');
      if (clean.split('.').length < 3) return { success: false, error: 'invalid token' };
      const data = loadSavedData();
      data.tokens = data.tokens || {};
      data.tokens[accountId] = clean;
      saveSavedData(data);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // save token button → POST same body as bilat.js → Vercel → Supabase kalamay
  ipcMain.handle('push-token-supabase', async (_e, { accountId, accountName, token }) => {
    try {
      if (!token) return { success: false, error: 'Walay token' };
      const clean = String(token).trim().replace(/^["']+|["']+$/g, '');
      if (clean.split('.').length < 3) return { success: false, error: 'Invalid token' };

      // Always keep local copy first
      const data = loadSavedData();
      data.tokens = data.tokens || {};
      if (accountId) data.tokens[accountId] = clean;
      saveSavedData(data);

      const cfg = loadTokenPushConfig();

      // 1) Preferred: existing Vercel API (morit.app/api/bilat)
      if (cfg.apiUrl) {
        try {
          const res = await fetch(cfg.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accountId: accountId || accountName || 'unknown',
              token: clean
            })
          });
          const json = await res.json().catch(() => ({}));
          if (res.ok && json && json.success !== false) {
            return {
              success: true,
              message: json.message || 'Na-save via Vercel → Supabase (kalamay)'
            };
          }
          // If API fails and we have direct Supabase creds, fall through
          if (!(cfg.url && cfg.anonKey)) {
            return {
              success: false,
              error: (json && json.error) || ('API HTTP ' + res.status)
            };
          }
        } catch (apiErr) {
          if (!(cfg.url && cfg.anonKey)) {
            return { success: false, error: 'Vercel API error: ' + (apiErr.message || apiErr) };
          }
        }
      }

      // 2) Fallback: direct Supabase insert (if keys provided)
      if (cfg.url && cfg.anonKey) {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(cfg.url, cfg.anonKey);
        const { error } = await supabase.from(cfg.table || 'kalamay').insert([
          { account_id: accountId || 'unknown', token: clean }
        ]);
        if (error) return { success: false, error: error.message };
        return { success: true, message: 'Na-save sa Supabase (' + (cfg.table || 'kalamay') + ')' };
      }

      return {
        success: false,
        error: 'Walay working Vercel API / Supabase config'
      };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('get-supabase-status', () => {
    const cfg = loadTokenPushConfig();
    let host = '';
    try {
      host = cfg.apiUrl ? new URL(cfg.apiUrl).host : '';
    } catch (_) {}
    return {
      configured: !!(cfg.apiUrl || (cfg.url && cfg.anonKey)),
      mode: cfg.apiUrl ? 'vercel-api' : 'direct-supabase',
      apiUrl: cfg.apiUrl || '',
      table: cfg.table || 'kalamay',
      urlHost: host
    };
  });

  ipcMain.handle('clear-partition', async (_e, partitionName) => {
    try {
      const ses = session.fromPartition(partitionName);
      ses.setUserAgent(CHROME_UA);
      await ses.clearStorageData();
      await ses.clearCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('prepare-partition', async (_e, partitionName) => {
    try {
      const ses = session.fromPartition(partitionName, { cache: true });
      ses.setUserAgent(CHROME_UA);
      return { success: true, userAgent: CHROME_UA };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Throttle / unthrottle a webview guest (inactive Discord accounts)
  ipcMain.handle('set-webview-throttle', (_e, { webContentsId, throttle }) => {
    try {
      const wc = webContents.fromId(Number(webContentsId));
      if (!wc || wc.isDestroyed()) return { success: false };
      wc.setBackgroundThrottling(!!throttle);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows/Linux when window is hidden
  if (process.platform === 'darwin') {
    // macOS dock behavior
  }
  // do not quit — tray keeps process alive unless isQuitting
  if (isQuitting && process.platform !== 'darwin') {
    // already quitting
  }
});
