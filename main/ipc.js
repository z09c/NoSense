'use strict';

/**
 * 主进程 IPC：渲染层 -> 主进程的唯一入口。
 * 所有对外跳转都经过协议白名单，避免 file:// 或 javascript: 注入。
 */

var SAFE_URL = /^https?:\/\//i;

function register(d) {
  var ipcMain = d.ipcMain;
  var shell = d.shell;
  var app = d.app;
  var store = d.store;
  var log = d.log;
  var wm = d.wm;
  var bus = d.bus;
  var knowledge = d.knowledge;
  var media = d.media;
  var notif = d.notif;
  var sys = d.sys;
  var panelData = d.panelData;

  function safeOpen(url) {
    if (typeof url !== 'string' || !SAFE_URL.test(url)) {
      log.warn('ipc', '拒绝打开非 http(s) 链接: ' + String(url).slice(0, 80));
      return false;
    }
    shell.openExternal(url);
    return true;
  }

  /* ---------------- 竖条 ---------------- */
  ipcMain.on('bar:ready', function () {
    wm.broadcastCfg(store.all());
    wm.sendBar('ui:mode', { mode: wm.expanded ? 'msg' : 'idle' });
    if (wm.expanded && bus.currentId()) wm.sendBar('ui:pack', bus.currentPack());
  });

  ipcMain.on('bar:hover', function (event, active) {
    if (!store.get('notify.hoverSettings', true)) return;
    wm.hover(!!active);
    if (active) {
      wm.sendBar('ui:menu', { bandLabel: bus.bandLabel(), time: bus.timeText() });
    }
  });

  ipcMain.on('bar:click', function () {
    if (!store.get('notify.hoverSettings', true)) return;
    wm.hover(true);
    wm.sendBar('ui:menu', { bandLabel: bus.bandLabel(), time: bus.timeText() });
  });

  ipcMain.on('bar:open-settings', function () { wm.openSettings(); });

  ipcMain.on('bar:action', function (event, msg) {
    if (!msg || !msg.id) return;
    var key = msg.key;
    log.info('ipc', '竖条按钮: ' + key + ' (' + msg.id + ')');
    if (key === 'weather' || key === 'hot') {
      wm.collapse();
      wm.openPanel(key, panelData(key));
      bus.dismiss(msg.id, key);
      return;
    }
    if (key === 'open') {
      var pack = bus.currentPack();
      if (pack && pack.payload) safeOpen(pack.payload.url);
    }
    if (key === 'no') {
      var cur = bus.currentPack();
      if (cur) bus.mute(cur.kind);
    }
    wm.collapse();
    bus.dismiss(msg.id, key);
  });

  /* ---------------- 面板 ---------------- */
  ipcMain.on('panel:close', function () { wm.closePanel(); });
  ipcMain.on('panel:open-url', function (event, url) { safeOpen(url); });

  /* ---------------- 设置 ---------------- */
  ipcMain.on('settings:ready', function () {
    wm.sendSettings('ui:cfg', store.all());
  });

  ipcMain.on('settings:set', function (event, msg) {
    if (!msg || typeof msg.path !== 'string') return;
    store.set(msg.path, msg.value);
    applyLive(msg.path, msg.value);
  });

  ipcMain.on('settings:invoke', function (event, msg) {
    var name = msg && msg.name;
    if (name === 'quit') {
      store.flush();
      app.quit();
    } else if (name === 'restart') {
      store.flush();
      app.relaunch();
      app.quit();
    } else if (name === 'closeSettings') {
      if (wm.settings && !wm.settings.isDestroyed()) wm.settings.close();
    } else if (name === 'relayout') {
      wm.reposition();
    } else if (name === 'previewGreeting') {
      bus.greeting(true);
    } else if (name === 'openDataDir') {
      shell.openPath(store.dirs().root);
    } else if (name === 'openLogDir') {
      shell.openPath(store.dirs().log);
    }
  });

  ipcMain.handle('settings:get', function () {
    return { cfg: store.all(), info: d.info() };
  });

  ipcMain.handle('settings:logs', function (event, query) {
    var q = query || {};
    return log.tail(q.limit || 120, q.level || 'debug');
  });

  /** 配置改动后立即生效的部分（不需要重启） */
  function applyLive(path, value) {
    if (path === 'bar.alwaysOnTop') wm.setBarTop(value);
    if (path === 'font.family' || path === 'font.size' || path === 'font.titleSize' || path === 'font.lineHeight') {
      wm.broadcastCfg(store.all());
    }
    if (path.indexOf('bar.') === 0) wm.reposition();
    if (path === 'sources.media') {
      if (value) media.start(); else media.stop();
    }
    if (path === 'sources.notifCenter') {
      if (value) notif.start(); else notif.stop();
    }
    if (path === 'sources.usb' || path === 'sources.battery' || path === 'sources.fileWatch') {
      sys.restart();
    }
    if (path.indexOf('weather.') === 0 || path.indexOf('refresh.') === 0 || path.indexOf('hot.') === 0) {
      knowledge.refreshAll(function () { wm.broadcastCfg(store.all()); });
    }
  }
}

module.exports = { register: register };
