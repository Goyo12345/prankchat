const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const run = promisify(execFile)

function setupAppUpdates({ app, autoUpdater, dialog, getWindow, getLanguage = () => 'fr' }) {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  // Never restart or install implicitly when the user closes the app.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  let checking = false
  let ready = false
  autoUpdater.on('error', error => console.error('Mise à jour PrankChat:', error.message))
  autoUpdater.on('update-downloaded', async info => {
    if (ready) return
    ready = true
    try {
      const catalog = require('./translations')
      const index = Math.max(0, ['fr', 'en', 'de', 'es', 'it', 'pt'].indexOf(getLanguage()))
      const t = key => catalog[key][index]
      const options = {
        type: 'info', title: t('updateTitle'),
        message: t('updateReady').replace('{version}', info.version),
        detail: t('updateDetail'),
        buttons: [t('later'), t('restart')], defaultId: 0, cancelId: 0
      }
      const win = getWindow()
      const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      if (result.response === 1) autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      console.error('Invitation de mise à jour:', error.message)
    }
  })
  async function check() {
    if (checking || ready) return
    checking = true
    try { await autoUpdater.checkForUpdates() }
    catch (error) { console.error('Vérification de mise à jour:', error.message) }
    finally { checking = false }
  }
  void check()
  const timer = setInterval(check, 6 * 60 * 60 * 1000)
  timer.unref()
  app.once('before-quit', () => clearInterval(timer))
}

// Update a private staging copy: running downloads and the bundled fallback
// are never overwritten. yt-dlp verifies the official release checksum itself.
async function updateDownloader({ bundledPath, cacheDir, runFile = run }) {
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const opts = { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }
  const version = async file => {
    const { stdout } = await runFile(file, ['--ignore-config', '--version'], opts)
    const value = stdout.trim()
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(value)) throw new Error('Version yt-dlp invalide')
    return value
  }
  const bundledVersion = await version(bundledPath)
  const cachedPath = path.join(cacheDir, 'current.json')
  let source = bundledPath
  let sourceVersion = bundledVersion
  try {
    const cached = JSON.parse(await fs.promises.readFile(cachedPath, 'utf8'))
    if (/^[a-f0-9]{64}\.exe$/.test(cached.file)) {
      const candidate = path.join(cacheDir, cached.file)
      const candidateVersion = await version(candidate)
      if (candidateVersion >= bundledVersion) {
        source = candidate
        sourceVersion = candidateVersion
      }
    }
  } catch (_) { /* Missing or broken cache: keep bundled fallback. */ }
  let stage
  try {
    stage = await fs.promises.mkdtemp(path.join(cacheDir, 'update-'))
    const executable = path.join(stage, 'yt-dlp.exe')
    await fs.promises.copyFile(source, executable)
    await runFile(executable, ['--ignore-config', '--update-to', 'stable'], { ...opts, timeout: 120000 })
    if (await version(executable) < sourceVersion) throw new Error('Version yt-dlp antérieure refusée')
    const bytes = await fs.promises.readFile(executable)
    const filename = crypto.createHash('sha256').update(bytes).digest('hex') + '.exe'
    const destination = path.join(cacheDir, filename)
    if (!fs.existsSync(destination)) await fs.promises.copyFile(executable, destination)
    const manifestTmp = path.join(stage, 'current.json')
    await fs.promises.writeFile(manifestTmp, JSON.stringify({ file: filename }))
    await fs.promises.rename(manifestTmp, cachedPath)
    return destination
  } catch (error) {
    console.error('Mise à jour yt-dlp indisponible, version précédente conservée:', error.message)
    return source
  } finally {
    if (stage) await fs.promises.rm(stage, { recursive: true, force: true })
  }
}

module.exports = { setupAppUpdates, updateDownloader }
