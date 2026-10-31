'use strict';

/**
 * 主进程入口（ES5 + CommonJS）。
 * 结构：信息层(sensors/sdk) -> 算法层(knowledge/composer/bus) -> 渲染层(wm+renderer)
 *       数据持久化层(store+logger) 供各层读写。
 */

var electron = require('electron');
var app = electron.app;
var ipcMain = electron.ipcMain;
var shell = electron.shell;
var powerMonitor = electron.powerMonitor;
var path = require('path');

var assets = require('./assets');
var storeMod = require('./state/store');
var loggerMod = require('./state/logger');
var Knowledge = require('./algo/knowledge').Knowledge;
var Composer = require('./algo/composer').Composer;
var Bus = require('./algo/bus').Bus;
var WM = require('./wm').WM;
var SystemStatus = require('./sensors/systemStatus').SystemStatus;
var MediaSmtc = require('./sensors/mediaSmtc').MediaSmtc;
var NotifCenter = require('./sensors/notifCenter').NotifCenter;
var ipc = require('./ipc');

var DEV = process.argv.indexOf('--dev') >= 0;

// 透明小窗口 + 毛玻璃在 Win10 各种驱动上软件渲染更稳（GPU 合成曾导致渲染进程崩溃）
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  app.setAppUserModelId('com.nonsense.desktop');
  process.on('uncaughtException', function (e) {
    if (log) log.error('crash', e.message + ' | ' + (e.stack || '').split('\n').slice(0, 3).join(' <- '));
    else console.log('crash(before-log)', e);
  });
  process.on('unhandledRejection', function (r) {
    if (log) log.warn('promise', '未处理的 Promise 失败: ' + (r && r.message ? r.message : String(r)));
  });

  var store = null;
  var log = null;
  var wm = null;
  var knowledge = null;
  var composer = null;
  var bus = null;
  var sys = null;
  var media = null;
  var notif = null;
  var heartbeat = null;
  var lastBand = '';

  app.on('second-instance', function () {
    if (wm) wm.openSettings();
  });

  app.on('window-all-closed', function () {
    // 没有窗口常驻：竖条被销毁即视为退出（设置里“关闭软件”会显式 quit）
    if (wm && !wm.bar) app.quit();
  });

  app.whenReady().then(start);

  function start() {
    var root = path.join(app.getPath('userData'), 'nonsense');
    store = new storeMod.Store(root).init(app.getVersion());
    log = new loggerMod.Logger(store.dirs().log, DEV ? 'debug' : 'info', DEV);
    log.info('app', '启动 NoSense v' + app.getVersion() + '（数据目录 ' + root + '）');

    var ps = assets.ensureExtracted(app, path.join(root, 'ps'));
    if (ps.error) log.warn('assets', ps.error);
    if (ps.copied && ps.copied.length) log.info('assets', '释放采集脚本: ' + ps.copied.join(', '));

    knowledge = new Knowledge(store, log);
    composer = new Composer(store, knowledge);
    wm = new WM({ electron: electron, store: store, log: log, dev: DEV });
    bus = new Bus({
      store: store, log: log, composer: composer, knowledge: knowledge,
      out: { show: function (pack) { wm.showPack(pack); } }
    });

    sys = new SystemStatus({ store: store, log: log, psDir: ps.dir, app: app, powerMonitor: powerMonitor });
    media = new MediaSmtc({ store: store, log: log, psDir: ps.dir });
    notif = new NotifCenter({ store: store, log: log, psDir: ps.dir });

    sys.on('sys', function (ev) { bus.pushEvent(ev); });
    sys.on('minute', onMinute);
    media.on('media', function (ev) { bus.pushEvent(ev); });
    notif.on('notification', function (ev) { bus.pushEvent(ev); });

    wm.createBar();
    ipc.register({
      ipcMain: ipcMain, shell: shell, app: app, store: store, log: log,
      wm: wm, bus: bus, knowledge: knowledge, media: media, notif: notif, sys: sys,
      panelData: panelData, info: collectInfo
    });

    if (store.get('sources.media', true)) media.start();
    if (store.get('sources.notifCenter', true)) notif.start();
    sys.start();
    wm.setBarTop(store.get('bar.alwaysOnTop', true));

    lastBand = composer.bandOf(new Date()).key;
    knowledge.refreshAll(function () {
      if (store.get('notify.greetAtStartup', true) && !store.inDnd()) bus.greeting(true);
    });
    heartbeat = setInterval(tick, 60000);

    try {
      powerMonitor.on('resume', function () {
        log.info('app', '系统唤醒，刷新一次数据源');
        knowledge.refreshAll(function () {});
      });
    } catch (e) { /* ignore */ }
  }

  function tick() {
    knowledge.refreshAll(function () {});
    onMinute(new Date().getHours() * 60 + new Date().getMinutes());
  }

  /** 每分钟：时段切换时推送一次问候（免打扰时段内自动挂起） */
  function onMinute() {
    var band = composer.bandOf(new Date()).key;
    if (band !== lastBand) {
      lastBand = band;
      bus.greeting(false);
    }
  }

  function panelData(key) {
    if (key === 'weather') {
      var w = knowledge.snap.weather;
      if (!w) return { now: null };
      return {
        city: w.city, provider: w.provider, observedAt: w.observedAt, now: w.now,
        hourly: w.hourly, min24h: w.min24h, max24h: w.max24h
      };
    }
    if (key === 'hot') {
      var h = knowledge.snap.hot;
      return h ? { provider: h.provider, items: h.items } : { items: [] };
    }
    return null;
  }

  function collectInfo() {
    var meta = store.meta || {};
    var now = new Date();
    return {
      app: store.appInfo(),
      firstInstallDate: meta.firstInstallDate,
      daysUsed: meta.daysUsed,
      launches: meta.launches,
      uptimeText: sys ? sys.snapshot().uptimeText : '-',
      bandLabel: composer.bandOf(now).label,
      time: composer.timeText(now),
      dirs: store.dirs(),
      knowledge: knowledge.status(),
      media: media.snapshot(),
      notif: notif.status(),
      bus: bus.stats()
    };
  }

  app.on('before-quit', function () {
    if (heartbeat) clearInterval(heartbeat);
    if (sys) sys.stop();
    if (media) media.stop();
    if (notif) notif.stop();
    if (store) store.flush();
    if (log) log.info('app', '退出，配置已落盘');
  });
}

