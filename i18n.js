(function () {
  'use strict'
  const catalog = window.PRANKCHAT_TRANSLATIONS
  const languages = ['fr', 'en', 'de', 'es', 'it', 'pt']
  const names = ['Français', 'English', 'Deutsch', 'Español', 'Italiano', 'Português']
  const normalize = value => String(value || '').toLowerCase().split(/[-_]/)[0]
  let saved
  try { saved = localStorage.getItem('prankchat.language') } catch (_) {}
  let language = languages.includes(saved) ? saved :
    (navigator.languages || [navigator.language]).map(normalize).find(code => languages.includes(code)) || 'en'
  const bindings = new Map()
  function t(key, values = {}) {
    const row = catalog[key]
    const message = row ? row[languages.indexOf(language)] || row[0] : key
    return message.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
  }
  function text(element, key, values = {}) {
    if (typeof element === 'string') element = document.getElementById(element)
    bindings.set(element, { key, values })
    element.textContent = t(key, values)
  }
  function render() {
    document.documentElement.lang = language
    document.querySelectorAll('[data-i18n]').forEach(element => {
      if (!bindings.has(element)) element.textContent = t(element.dataset.i18n)
    })
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)))
      })
    }
    bindings.forEach(({ key, values }, element) => { element.textContent = t(key, values) })
    document.querySelectorAll('[data-language-select]').forEach(select => { select.value = language })
  }
  function setLanguage(code) {
    if (!languages.includes(code)) return
    language = code
    try { localStorage.setItem('prankchat.language', language) } catch (_) {}
    render()
    window.dispatchEvent(new CustomEvent('languagechange', { detail: language }))
  }
  window.I18n = { t, text, setLanguage, get language() { return language } }
  function init() {
    const toolbar = document.createElement('div')
    toolbar.className = 'language-toolbar'
    const label = document.createElement('label')
    label.htmlFor = 'language-select'
    label.dataset.i18n = 'language'
    const select = document.createElement('select')
    select.id = 'language-select'
    select.setAttribute('data-language-select', '')
    languages.forEach((code, index) => {
      const option = document.createElement('option')
      option.value = code
      option.textContent = names[index]
      option.lang = code
      select.append(option)
    })
    select.addEventListener('change', () => setLanguage(select.value))
    toolbar.append(label, select)
    document.body.prepend(toolbar)
    render()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
