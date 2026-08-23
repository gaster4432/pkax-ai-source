'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) errors.push(`${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    errors.push(`renderer gone: ${JSON.stringify(details)}`);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 4000));
  console.log('[smoke-renderer] errors:', JSON.stringify(errors, null, 2));
  console.log('[smoke-renderer] title:', win.webContents.getTitle());
  const hasApi = await win.webContents.executeJavaScript('typeof window.api');
  console.log('[smoke-renderer] api:', hasApi);
  const state = await win.webContents.executeJavaScript(`({
    convs: document.querySelectorAll('.conv-item').length,
    brand: document.querySelector('#brand-model')?.textContent,
    input: !!document.querySelector('#input'),
  })`);
  console.log('[smoke-renderer] dom:', JSON.stringify(state));
  app.quit();
});
