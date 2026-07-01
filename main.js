const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

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

app.whenReady().then(() => {
  createMainWindow()
  createOverlay()
})

ipcMain.on('show-prank', (event, data) => {
  overlayWindow.webContents.send('show-prank', data)
})

ipcMain.on('close-overlay', () => {
  overlayWindow.webContents.send('close-overlay')
})