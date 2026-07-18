const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { exec } = require('child_process')
const fs = require('fs')
const os = require('os')
const https = require('https')

// L'adresse de ton serveur Railway (sans le https://)
const SERVER_HOST = 'prankchat-production.up.railway.app'

let mainWindow
let overlayWindow

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  mainWindow.loadFile('index.html')
}

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  overlayWindow = new BrowserWindow({
    width: width,
    height: height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  })

  overlayWindow.setIgnoreMouseEvents(true)
  overlayWindow.loadFile('overlay.html')
}

// Envoie la vanne à l'overlay (qui reste affiché en permanence, transparent).
function showOverlay(data) {
  overlayWindow.webContents.send('show-prank', data)
}

// Chemin vers yt-dlp.exe (différent selon que l'app est installée ou en dev)
function getYtdlpPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'yt-dlp.exe')
    : path.join(app.getAppPath(), 'yt-dlp.exe')
}

function isDirectMedia(url) {
  return url.match(/\.(mp4|webm|ogg|mov|gif|jpg|jpeg|png|gifv)(\?|$)/i) ||
         url.includes('catbox.moe') ||
         url.includes('streamable.com') ||
         url.includes('i.imgur.com') ||
         url.includes('giphy.com')
}

// Cas d'un lien qu'on doit télécharger pour NOTRE overlay (reçu d'un ami)
function downloadAndPlay(url, data) {
  const tmpFile = path.join(os.tmpdir(), `prankchat_${Date.now()}.mp4`)
  const ytdlp = getYtdlpPath()
  // On force le codec H.264 pour que la vidéo s'affiche partout (pas juste le son).
  const cmd = `"${ytdlp}" -o "${tmpFile}" --no-playlist -f "best[ext=mp4]/best" -S "vcodec:h264" "${url}"`

  exec(cmd, (error) => {
    if (error) {
      console.error('Erreur téléchargement:', error)
      return
    }

    showOverlay({
      ...data,
      imageUrl: `file://${tmpFile}`,
      tmpFile: tmpFile
    })
  })
}

// NOUVEAU : on télécharge la vidéo YouTube/TikTok sur CE PC (l'IP maison
// n'est pas bloquée par YouTube), puis on l'envoie au serveur pour qu'OBS
// et l'ami puissent la lire comme un simple .mp4.
function downloadAndRelay(data) {
  const tmpFile = path.join(os.tmpdir(), `prankchat_${Date.now()}.mp4`)
  const ytdlp = getYtdlpPath()
  // -S "vcodec:h264,res:480" : on force le codec H.264 (lisible partout, sinon
  // TikTok donne du H.265 = son sans image) et on vise du ~480p pour rester léger.
  const cmd = `"${ytdlp}" -o "${tmpFile}" --no-playlist -f "best[ext=mp4]/best" -S "vcodec:h264,res:480" --max-filesize 50m "${data.imageUrl}"`

  exec(cmd, { timeout: 120000 }, (error) => {
    if (error) {
      console.error('Erreur téléchargement:', error)
      return
    }

    // 1) On envoie la vidéo au serveur (pour OBS + l'ami). On lit d'abord
    //    le fichier, avant que l'overlay ne le supprime en fin de lecture.
    uploadToServer(tmpFile, data)

    // 2) On l'affiche aussi sur notre propre overlay, tout de suite.
    showOverlay({
      imageUrl: `file://${tmpFile}`,
      caption: data.caption,
      duration: data.duration,
      position: data.position,
      size: data.size,
      tmpFile: tmpFile
    })
  })
}

function uploadToServer(tmpFile, data) {
  const fileData = fs.readFileSync(tmpFile)
  const query =
    `room=${encodeURIComponent(data.roomCode)}` +
    `&caption=${encodeURIComponent(data.caption || '')}` +
    `&senderId=${encodeURIComponent(data.senderId || '')}` +
    `&token=${encodeURIComponent(data.sendToken || '')}` +
    `&duration=${encodeURIComponent(data.duration || '')}` +
    `&position=${encodeURIComponent(data.position || 'center')}` +
    `&size=${encodeURIComponent(data.size || 'medium')}`

  const options = {
    hostname: SERVER_HOST,
    path: `/upload?${query}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileData.length
    }
  }

  const req = https.request(options, (res) => {
    let body = ''
    res.on('data', (c) => (body += c))
    res.on('end', () => {
      console.log('Vidéo envoyée au serveur:', res.statusCode, body)
      // Freemium : le serveur a refusé (quota gratuit du jour épuisé) -> on prévient l'app.
      if (res.statusCode === 402 && mainWindow) {
        mainWindow.webContents.send('prank-limit-reached')
      }
    })
  })
  req.on('error', (e) => console.error('Erreur envoi serveur:', e))
  req.write(fileData)
  req.end()
}

// Au démarrage, on efface les vidéos temporaires laissées par une session
// précédente (par ex. si l'app a crashé). À ce moment aucune n'est utilisée.
function cleanupTempFiles() {
  const dir = os.tmpdir()
  fs.readdir(dir, (err, files) => {
    if (err) return
    files.forEach((f) => {
      if (f.startsWith('prankchat_')) {
        try {
          fs.unlinkSync(path.join(dir, f))
        } catch (e) {
          // fichier peut-être encore ouvert, on ignore
        }
      }
    })
  })
}

app.whenReady().then(() => {
  cleanupTempFiles()
  createMainWindow()
  createOverlay()
})

ipcMain.on('show-prank', (event, data) => {
  if (isDirectMedia(data.imageUrl)) {
    showOverlay(data)
  } else {
    downloadAndPlay(data.imageUrl, data)
  }
})

// Déclenché quand l'expéditeur envoie un lien YouTube/TikTok
ipcMain.on('download-and-relay', (event, data) => {
  downloadAndRelay(data)
})

ipcMain.on('close-overlay', () => {
  overlayWindow.webContents.send('close-overlay')
})

ipcMain.on('delete-tmp', (event, tmpFile) => {
  if (tmpFile && fs.existsSync(tmpFile)) {
    fs.unlinkSync(tmpFile)
  }
})
