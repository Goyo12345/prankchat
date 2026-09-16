// Run with: electron i18n.electron-test.cjs (isolated storage, hidden windows).
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const catalog = require('./translations')
const reportPath = process.env.PRANKCHAT_TEST_REPORT
const report = []
function record(message) {
  report.push(message)
  if (reportPath) fs.writeFileSync(reportPath, report.join('\n'))
  console.log(message)
}
app.disableHardwareAcceleration()
const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'prankchat-i18n-'))
app.setPath('userData', temporaryProfile)
app.whenReady().then(async () => {
  try {
    for (const [key, rows] of Object.entries(catalog)) {
      assert.equal(rows.length, 6, key)
      const tokens = value => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()
      for (const row of rows) {
        assert.ok(typeof row === 'string' && row.length, key)
        assert.deepEqual(tokens(row), tokens(rows[0]), key)
      }
    }
    // Tests must not contact accounts, billing, or the production socket server.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }))
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    for (const filename of ['landing.html', 'index.html']) {
      await win.loadFile(path.join(__dirname, filename))
      for (const [index, language] of ['fr', 'en', 'de', 'es', 'it', 'pt'].entries()) {
        const result = await win.webContents.executeJavaScript(`(() => {
          const select = document.getElementById('language-select');
          select.value = ${JSON.stringify(language)}; select.dispatchEvent(new Event('change'));
          const errors = [];
          document.querySelectorAll('[data-i18n]').forEach(el => {
            if (el.textContent !== PRANKCHAT_TRANSLATIONS[el.dataset.i18n][${index}]) errors.push(el.dataset.i18n);
          });
          for (const attribute of ['title','placeholder']) document.querySelectorAll('[data-i18n-'+attribute+']').forEach(el => {
            if (el.getAttribute(attribute) !== I18n.t(el.getAttribute('data-i18n-'+attribute))) errors.push(attribute);
          });
          return { errors, lang: document.documentElement.lang, saved: localStorage.getItem('prankchat.language') };
        })()`)
        assert.deepEqual(result, { errors: [], lang: language, saved: language })
      }
      await win.loadFile(path.join(__dirname, filename))
      assert.equal(await win.webContents.executeJavaScript('I18n.language'), 'pt')
      if (filename === 'index.html') {
        const result = await win.webContents.executeJavaScript(`(() => {
          document.getElementById('authEmail').value = 'example@example.com';
          document.getElementById('caption').value = 'Mon texte à conserver';
          updatePremiumUI(false, 0);
          I18n.text('status', 'waiting');
          I18n.setLanguage('de');
          const exhausted = document.getElementById('quotaBar').textContent === I18n.t('exhausted') && document.getElementById('upsellBox').style.display === 'block';
          updatePremiumUI(false, 3); I18n.setLanguage('en');
          const quota = document.getElementById('quotaBar').textContent;
          const waiting = document.getElementById('status').textContent;
          updatePremiumUI(true, null);
          return { exhausted, quota, waiting, premiumHidden: document.getElementById('quotaBar').style.display === 'none', email: document.getElementById('authEmail').value, caption: document.getElementById('caption').value };
        })()`)
        assert.deepEqual(result, { exhausted: true, quota: '🎁 Free sends today: 3/5', waiting: '⏳ Waiting for your friend...', premiumHidden: true, email: 'example@example.com', caption: 'Mon texte à conserver' })
      }
      record('PASS: ' + filename + ' six languages, persistence, translations')
    }
    win.destroy()
    record('PASS: quota states and user input preserved')
    app.exit(0)
  } catch (error) { record('FAIL: ' + error.stack); app.exit(1) }
})
