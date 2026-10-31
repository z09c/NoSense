'use strict';

/**
 * Preload（ES5 + CommonJS）：只暴露渲染层需要的最小能力。
 * 渲染层接触不到 Node，也不直接使用 ipcRenderer。
 */

var electron = require('electron');
var contextBridge = electron.contextBridge;
var ipcRenderer = electron.ipcRenderer;

function on(channel, handler) {
  if (typeof channel !== 'string' || typeof handler !== 'function') return function () {};
  var listener = function (event, data) { handler(data); };
  ipcRenderer.on(channel, listener);
  return function () { ipcRenderer.removeListener(channel, listener); };
}

function send(channel, payload) {
  if (typeof channel !== 'string') return;
  ipcRenderer.send(channel, payload);
}

function invoke(channel, payload) {
  if (typeof channel !== 'string') return Promise.reject(new Error('bad channel'));
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('noSense', {
  on: on,
  send: send,
  invoke: invoke,
  platform: process.platform,
  electronVersion: process.versions.electron
});
