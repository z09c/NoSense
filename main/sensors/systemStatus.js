'use strict';

/**
 * 信息层：系统状态
 *  - 文件移动/复制/删除（监听桌面、文档、下载）
 *  - USB 设备插拔（轮询 WMI 快照做差集）
 *  - 电池状态（Electron powerMonitor）
 *  - 已运行时长 / 系统时间跳变
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var pexec = require('../util/pexec');
var fsx = require('../util/fsx');

var IGNORE_NAMES = /(^~\$|\.tmp$|\.crdownload$|\.part$|^Thumbs\.db$|^desktop\.ini$|^\.DS_Store$)/i;
var IGNORE_DIRS = /(\\node_modules\\|\\\.git\\|\\AppData\\|\\OneDrive\\|\\$Recycle\.Bin)/i;

function SystemStatus(deps) {
  EventEmitter.call(this);
  this.store = deps.store;
  this.log = deps.log;
  this.psDir = deps.psDir;
  this.app = deps.app;
  this.powerMonitor = deps.powerMonitor;
  this.watchers = [];
  this.pending = {};
  this.flushTimer = null;
  this.recent = [];           // 近期消失/出现的文件名，用于判断移动 vs 删除
  this.usbSnapshot = null;
  this.usbFirstRun = true;
  this.battery = null;
  this.bootTime = Date.now() - Math.floor(os.uptime()) * 1000;
  this.lastTick = Date.now();
  this.lastMinute = -1;
  this.lastUptimeReport = Date.now();
  this.timers = [];
}
SystemStatus.prototype = Object.create(EventEmitter.prototype);
SystemStatus.prototype.constructor = SystemStatus;

SystemStatus.prototype.restart = function () {
  this.stop();
  this.start();
};

SystemStatus.prototype.start = function () {
  if (this.store.get('sources.fileWatch', true)) this.watchFiles();
  if (this.store.get('sources.usb', true)) this.startUsb();
  if (this.store.get('sources.battery', true)) this.startBattery();
  this.startClock();
};

SystemStatus.prototype.stop = function () {
  for (var i = 0; i < this.watchers.length; i++) {
    try { this.watchers[i].close(); } catch (e) { /* ignore */ }
  }
  this.watchers = [];
  for (var j = 0; j < this.timers.length; j++) clearInterval(this.timers[j]);
  this.timers = [];
  if (this.flushTimer) clearTimeout(this.flushTimer);
};

/* ---------------- 系统时间 / 运行时长 ---------------- */

SystemStatus.prototype.startClock = function () {
  var self = this;
  var timer = setInterval(function () {
    var now = Date.now();
    var drift = now - (self.lastTick + 20000);
    if (drift > 300000 || drift < -300000) {
      self.emit('sys', {
        kind: 'clock', tone: 'warn', title: '系统时间变化',
        body: '检测到系统时间跳变 ' + Math.round(drift / 60000) + ' 分钟，当前 ' + fmtTime(new Date(now)) + '。',
        lines: ['（NoSense 的问候时段已按新时间重新计算）']
      });
    }
    self.lastTick = now;

    var minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    if (minute !== self.lastMinute) {
      self.lastMinute = minute;
      self.emit('minute', minute);
    }

    var hours = self.store.get('system.uptimeReportHours', 6);
    if (now - self.lastUptimeReport >= hours * 3600000) {
      self.lastUptimeReport = now;
      self.emit('sys', {
        kind: 'uptime', tone: 'info', title: '运行时长',
        body: '本机已连续运行 ' + humanDuration(now - self.bootTime) + '，开机时间 ' + fmtDateTime(new Date(self.bootTime)) + '。',
        lines: []
      });
    }
  }, 20000);
  this.timers.push(timer);
};

/* ---------------- 电池 ---------------- */

SystemStatus.prototype.startBattery = function () {
  var self = this;
  if (!this.powerMonitor || !this.powerMonitor.getSystemBatteryState) return;
  var probe = function () {
    var st;
    try { st = self.powerMonitor.getSystemBatteryState(); } catch (e) { return; }
    if (!st || !st.batteryExists) return;
    var level = Math.round((st.batteryLevel || 0) * 100);
    var charging = !!st.charging;
    var prev = self.battery;
    self.battery = { level: level, charging: charging, at: Date.now() };
    if (!prev) {
      self.emit('sys', {
        kind: 'battery', tone: level <= 20 ? 'warn' : 'info',
        title: '电池状态', body: '当前电量 ' + level + '%，' + (charging ? '正在充电' : '使用电池供电') + '。',
        lines: []
      });
      return;
    }
    if (prev.charging !== charging) {
      self.emit('sys', {
        kind: 'battery', tone: charging ? 'info' : 'warn',
        title: charging ? '已接通电源' : '已断开电源',
        body: '电量 ' + level + '%，' + (charging ? '正在充电。' : '改用电池供电，请注意剩余电量。'),
        lines: []
      });
    } else if (!charging) {
      var marks = [80, 50, 20, 10, 5];
      for (var i = 0; i < marks.length; i++) {
        if (prev.level > marks[i] && level <= marks[i]) {
          self.emit('sys', {
            kind: 'battery', tone: level <= 20 ? 'warn' : 'info',
            title: '电量提醒', body: '电量剩余 ' + level + '%。',
            lines: []
          });
          break;
        }
      }
    }
  };
  probe();
  this.timers.push(setInterval(probe, 45000));
  // 低电关机前的系统级事件也转发一次
  try {
    this.powerMonitor.on('shutdown', function () {
      self.emit('sys', { kind: 'system', tone: 'warn', title: '系统即将关机', body: '收到系统关机信号，配置已保存。', lines: [], sticky: false });
      self.store.flush();
    });
    this.powerMonitor.on('lock-screen', function () {
      self.emit('sys', { kind: 'system', tone: 'info', title: '屏幕已锁定', body: '回到登录界面，NoSense 将继续在后台运行。', lines: [] });
    });
  } catch (e) { /* ignore */ }
};

/* ---------------- USB ---------------- */

SystemStatus.prototype.startUsb = function () {
  var self = this;
  var script = path.join(this.psDir, 'usb.ps1');
  var probe = function () {
    pexec.runScript(script, {}, 15000, function (err, json) {
      if (err || !json || !json.ok) {
        if (err && err.message && String(err.message).indexOf('timeout') < 0) self.log.warn('usb', err.message);
        return;
      }
      var ids = {};
      var items = (json.usb || []).concat(json.drives || []);
      for (var i = 0; i < items.length; i++) ids[items[i].id] = items[i];
      var prev = self.usbSnapshot;
      self.usbSnapshot = ids;
      if (self.usbFirstRun) { self.usbFirstRun = false; return; }
      var added = [], removed = [];
      for (var k in ids) {
        if (!Object.prototype.hasOwnProperty.call(ids, k)) continue;
        if (!prev[k]) added.push(ids[k]);
      }
      for (var p in prev) {
        if (!Object.prototype.hasOwnProperty.call(prev, p)) continue;
        if (!ids[p]) removed.push(prev[p]);
      }
      if (added.length) {
        self.emit('sys', {
          kind: 'usb', tone: 'info', title: 'USB 设备接入',
          body: added.map(friendly).slice(0, 3).join('；'),
          lines: []
        });
      }
      if (removed.length) {
        self.emit('sys', {
          kind: 'usb', tone: 'info', title: 'USB 设备移除',
          body: removed.map(friendly).slice(0, 3).join('；'),
          lines: []
        });
      }
    });
  };
  probe();
  this.timers.push(setInterval(probe, 20000));
};

function friendly(item) {
  var name = String(item.name || '').trim();
  if (!name) name = 'USB 设备';
  if (/^([A-Z]:)\s/.test(name)) return '可移动磁盘 ' + name + (item.free !== undefined ? '（剩余 ' + mb(item.free) + '）' : '');
  return name;
}

function mb(bytes) {
  var n = Number(bytes);
  if (!isFinite(n)) return '?';
  if (n > 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  return Math.round(n / 1048576) + ' MB';
}

/* ---------------- 文件变动 ---------------- */

SystemStatus.prototype.watchDirs = function () {
  var dirs = this.store.get('system.watchDirs');
  if (dirs && dirs.length) return dirs;
  var out = [];
  var names = ['desktop', 'documents', 'downloads'];
  for (var i = 0; i < names.length; i++) {
    try {
      var p = this.app.getPath(names[i]);
      if (p && fs.existsSync(p)) out.push(p);
    } catch (e) { /* ignore */ }
  }
  return out;
};

SystemStatus.prototype.watchFiles = function () {
  var self = this;
  var dirs = this.watchDirs();
  for (var i = 0; i < dirs.length; i++) {
    (function (dir) {
      try {
        var w = fs.watch(dir, { persistent: true }, function (event, filename) {
          if (!filename) return;
          self.onFileEvent(dir, event, filename);
        });
        w.on('error', function (e) { self.log.warn('fileWatch', dir + ': ' + e.message); });
        self.watchers.push(w);
      } catch (e) {
        self.log.warn('fileWatch', '无法监听 ' + dir + ': ' + e.message);
      }
    })(dirs[i]);
  }
  if (dirs.length) this.log.info('fileWatch', '监听目录: ' + dirs.join(', '));
};

SystemStatus.prototype.onFileEvent = function (dir, event, rel) {
  var full = path.join(dir, rel);
  if (IGNORE_NAMES.test(rel) || IGNORE_DIRS.test(full)) return;
  var exists = false;
  try { exists = fs.existsSync(full); } catch (e) { /* ignore */ }
  var kind;
  if (event === 'change') kind = 'modify';
  else if (exists) kind = this.consumeRecent(full, 'appear') ? 'move-in' : 'create';
  else {
    this.rememberRecent(full, 'vanish');
    kind = 'delete';
  }
  var entry = { kind: kind, dir: path.basename(dir), name: path.basename(full), full: full };
  var key = kind + '|' + full;
  this.pending[key] = entry;
  this.scheduleFlush();
};

SystemStatus.prototype.rememberRecent = function (full, how) {
  this.recent.push({ full: full, how: how, at: Date.now() });
  if (this.recent.length > 120) this.recent.shift();
};

/** 同名文件在 6 秒内“先消失后出现” => 判定为移动 */
SystemStatus.prototype.consumeRecent = function (full, want) {
  var now = Date.now();
  for (var i = this.recent.length - 1; i >= 0; i--) {
    var r = this.recent[i];
    if (now - r.at > 6000) break;
    if (r.how === 'vanish' && want === 'appear' && baseOf(r.full) === baseOf(full)) {
      this.recent.splice(i, 1);
      return true;
    }
  }
  return false;
};

function baseOf(p) { return path.basename(p).toLowerCase(); }

SystemStatus.prototype.scheduleFlush = function () {
  var self = this;
  if (this.flushTimer) return;
  this.flushTimer = setTimeout(function () {
    self.flushTimer = null;
    var list = [];
    for (var key in self.pending) {
      if (Object.prototype.hasOwnProperty.call(self.pending, key)) list.push(self.pending[key]);
    }
    self.pending = {};
    if (!list.length) return;
    var labels = { create: '新增', modify: '修改', delete: '删除或移出', 'move-in': '移入' };
    var counts = {};
    for (var i = 0; i < list.length; i++) {
      var l = labels[list[i].kind] || list[i].kind;
      counts[l] = (counts[l] || 0) + 1;
    }
    var summary = [];
    for (var c in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, c)) summary.push(c + ' ' + counts[c] + ' 项');
    }
    var samples = list.slice(0, 3).map(function (e) { return e.dir + '\\' + e.name; });
    var noisy = summary.join('、');
    // 纯内容修改不打扰用户，只写日志
    if (Object.keys(counts).length === 1 && counts['修改']) {
      self.log.debug('fileWatch', '内容修改: ' + samples.join(', '));
      return;
    }
    self.emit('sys', {
      kind: 'file', tone: 'info', title: '文件变动：' + noisy,
      body: '位置：' + path.dirname(list[0].full) + '；示例：' + samples.join('、') +
        (list.length > 3 ? ' 等 ' + list.length + ' 项' : ''),
      lines: []
    });
  }, 1400);
};

SystemStatus.prototype.snapshot = function () {
  return {
    bootTime: this.bootTime,
    uptimeMs: Date.now() - this.bootTime,
    uptimeText: humanDuration(Date.now() - this.bootTime),
    battery: this.battery,
    watchDirs: this.watchDirs(),
    usbDevices: this.usbSnapshot ? Object.keys(this.usbSnapshot).length : 0
  };
};

function humanDuration(ms) {
  var total = Math.floor(ms / 1000);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  if (h >= 24) return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  return h + ' 小时 ' + m + ' 分';
}

function fmtTime(d) { return fsx.clock(d).slice(0, 5); }

function fmtDateTime(d) { return fsx.stamp(d) + ' ' + fmtTime(d); }

module.exports = { SystemStatus: SystemStatus, humanDuration: humanDuration };
