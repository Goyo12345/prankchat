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
  const cmd = `"${ytdlp}" -o "${tmpFile}" --no-playlist -f "best[ext=mp4]/best" "${url}"`

  exec(cmd, (error) => {
    if (error) {
      console.error('Erreur téléchargement:', error)
      return
    }

    overlayWindow.webContents.send('show-prank', {
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
  // On limite à 480p et 50 Mo : suffisant pour l'overlay, et léger à envoyer.
  const cmd = `"${ytdlp}" -o "${tmpFile}" --no-playlist -f "best[height<=480][ext=mp4]/best[ext=mp4]/best" --max-filesize 50m "${data.imageUrl}"`

  exec(cmd, { timeout: 120000 }, (error) => {
    if (error) {
      console.error('Erreur téléchargement:', error)
      return
    }

    // 1) On envoie la vidéo au serveur (pour OBS + l'ami). On lit d'abord
    //    le fichier, avant que l'overlay ne le supprime en fin de lecture.
    uploadToServer(tmpFile, data)

    // 2) On l'affiche aussi sur notre propre overlay, tout de suite.
    overlayWindow.webContents.send('show-prank', {
      imageUrl: `file://${tmpFile}`,
      caption: data.caption,
      tmpFile: tmpFile
    })
  })
}

function uploadToServer(tmpFile, data) {
  const fileData = fs.readFileSync(tmpFile)
  const query =
    `room=${encodeURIComponent(data.roomCode)}` +
    `&caption=${encodeURIComponent(data.caption || '')}` +
    `&senderId=${encodeURIComponent(data.senderId || '')}`

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
    res.on('end', () => console.log('Vidéo envoyée au serveur:', body))
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
    overlayWindow.webContents.send('show-prank', data)
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
