const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { exec } = require('child_process')
const fs = require('fs')
const os = require('os')

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

function isDirectMedia(url) {
  return url.match(/\.(mp4|webm|ogg|mov|gif|jpg|jpeg|png|gifv)(\?|$)/i) ||
         url.includes('catbox.moe') ||
         url.includes('streamable.com') ||
         url.includes('i.imgur.com') ||
         url.includes('giphy.com')
}

function downloadAndPlay(url, data) {
  const tmpFile = path.join(os.tmpdir(), `prankchat_${Date.now()}.mp4`)
  const ytdlp = path.join(__dirname, 'yt-dlp.exe')

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

app.whenReady().then(() => {
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

ipcMain.on('close-overlay', () => {
  overlayWindow.webContents.send('close-overlay')
})

ipcMain.on('delete-tmp', (event, tmpFile) => {
  if (tmpFile && fs.existsSync(tmpFile)) {
    fs.unlinkSync(tmpFile)
  }
})