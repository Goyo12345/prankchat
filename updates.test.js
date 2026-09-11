const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { setupAppUpdates, updateDownloader } = require('./updates')

for (const response of [0, 1]) test(`Installation seulement après choix explicite: ${response}`, async () => {
  const app = new EventEmitter()
  app.isPackaged = true
  const updater = new EventEmitter()
  let installs = 0
  updater.checkForUpdates = async () => null
  updater.quitAndInstall = () => installs++
  setupAppUpdates({ app, autoUpdater: updater, getWindow: () => null,
    dialog: { showMessageBox: async () => ({ response }) } })
  updater.emit('update-downloaded', { version: '1.3.0' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(installs, response)
  app.emit('before-quit')
})

test('yt-dlp: mise à jour séparée et conservation du cache hors ligne', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prankchat-updater-test-'))
  try {
    const bundledPath = path.join(dir, 'bundled.exe')
    await fs.writeFile(bundledPath, '2026.06.09')
    let offline = false
    const runFile = async (file, args) => {
      if (args.includes('--version')) return { stdout: await fs.readFile(file, 'utf8') }
      assert.deepEqual(args, ['--ignore-config', '--update-to', 'stable'])
      if (offline) throw new Error('Hors ligne')
      await fs.writeFile(file, '2026.08.19')
      return { stdout: '' }
    }
    const options = { bundledPath, cacheDir: path.join(dir, 'cache'), runFile }
    const updated = await updateDownloader(options)
    assert.equal(await fs.readFile(updated, 'utf8'), '2026.08.19')
    assert.equal(await fs.readFile(bundledPath, 'utf8'), '2026.06.09')
    offline = true
    assert.equal(await updateDownloader(options), updated)
    assert.equal((await fs.readdir(options.cacheDir)).some(name => name.startsWith('update-')), false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
