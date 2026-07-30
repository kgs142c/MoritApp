const { app, BrowserWindow, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('disable-features', 'Bluetooth');
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-site-isolation-trials');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const dataFilePath = path.join(app.getPath('userData'), 'morit_app_data.json');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.mp4']);

function getBundledMusicDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'music');
  }
  return path.join(__dirname, 'music');
}

function getMusicDir() {
  // User-writable library (seeded from built-in music on first run)
  return path.join(app.getPath('userData'), 'music');
}

// Custom protocol for local music files (must register before ready)
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
        theme: raw.theme || 'dark',
        sidebarWidth: raw.sidebarWidth || 260
      };
    }
  } catch (_) {}
  return { names: {}, tokens: {}, loginModes: {}, theme: 'dark', sidebarWidth: 260 };
}

function saveSavedData(data) {
  try {
    const current = loadSavedData();
    const next = {
      names: data.names || {},
      tokens: data.tokens || {},
      loginModes: data.loginModes || {},
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
    // Don't overwrite existing user files
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

    // First run after install: copy built-in tracks into user music folder
    const marker = path.join(musicDir, '.bundled-seeded');
    if (!fs.existsSync(marker)) {
      const bundled = getBundledMusicDir();
      copyDirContents(bundled, musicDir);
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

  const audios = files.filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));

  return audios.map((audio) => {
    const base = path.basename(audio, path.extname(audio));
    return {
      id: audio,
      title: base,
      file: audio,
      audioUrl: 'morit-asset://music/' + encodeURIComponent(audio)
    };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'MoritApp',
    backgroundColor: '#0c0c0c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(CHROME_UA);
  ensureMusicDir();

  // Start with Windows login (also set by installer registry key)
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      name: 'MoritApp',
      path: process.execPath,
      args: []
    });
  } catch (_) {}

  // morit-asset://music/filename.mp4  →  userData/music/filename.mp4
  protocol.handle('morit-asset', (request) => {
    try {
      const raw = request.url.replace(/^morit-asset:\/\//i, '');
      const segments = raw.split('/').map((s) => decodeURIComponent(s));
      // Expect: music / <filename>
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

  ipcMain.handle('get-saved-data', () => loadSavedData());
  ipcMain.handle('save-app-data', (_e, data) => saveSavedData(data));
  ipcMain.handle('get-user-agent', () => CHROME_UA);
  ipcMain.handle('list-music', () => listMusicTracks());
  ipcMain.handle('get-music-dir', () => ensureMusicDir());

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
      const ses = session.fromPartition(partitionName);
      ses.setUserAgent(CHROME_UA);
      return { success: true, userAgent: CHROME_UA };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
