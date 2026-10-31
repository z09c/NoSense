'use strict';

/**
 * Data persistence layer: config.json + meta.json + cache/*.json + log/*.log
 * All writes are synchronous-but-batched; config save is debounced so the
 * settings UI can hammer it while typing.
 */

var fs = require('fs');
var path = require('path');
var fsx = require('../util/fsx');

var APP_INFO = {
  name: 'NoSense',
  productName: 'NoSense 无感助手',
  version: '0.1.0',
  author: 'NoSense',
  description: '桌面右侧竖条信息助手：按时段合成问候、名句、天气与热搜，可拦截通知中心。',
  platform: 'Windows 10 1904+',
  homepage: ''
};

function defaults() {
  return {
    configVersion: 1,
    dnd: { enabled: true, start: '22:30', end: '07:30' },
    bar: {
      height: 128,
      width: 8,
      expandedWidth: 336,
      edgeGap: 6,
      alwaysOnTop: true,
      expandMs: 260,
      collapseMs: 180,
      hoverWidth: 156,
      hoverHeight: 112,
      autoCollapseMs: 0
    },
    font: { family: '等线', size: 12, titleSize: 18, lineHeight: 1.5, unit: 'pt' },
    refresh: { quoteHours: 6, weatherMinutes: 30, hotMinutes: 30 },
    weather: {
      provider: 'auto',
      city: '北京',
      districtId: '101010100',
      lat: 39.9042,
      lon: 116.4074,
      xiaomiKey: ''
    },
    sources: {
      quote: true,
      weather: true,
      hot: true,
      media: true,
      notifCenter: true,
      fileWatch: true,
      usb: true,
      battery: true,
      uptime: true
    },
    notify: {
      greetAtStartup: true,
      weatherInGreet: true,
      showHotCount: 5,
      hoverSettings: true,
      volumeHint: false
    },
    notifCenter: { apps: '' },
    hot: { provider: 'auto' },
    system: { uptimeReportHours: 6 },
    templates: {
      morning: {
        greeting: ['上午好，现在是 {time}。'],
        care: ['愿你今天顺顺利利。', '早餐吃过了吗？', '今天也请慢慢来。']
      },
      noon: {
        greeting: ['中午好，现在是 {time}。'],
        care: ['记得吃饭，顺便歇一会儿。', '午休十分钟，下午更清醒。']
      },
      afternoon: {
        greeting: ['下午好，现在是 {time}。'],
        care: ['再来一杯水，效率更高。', '坐久了起来活动两下。']
      },
      evening: {
        greeting: ['晚上好，现在是 {time}。'],
        care: ['今天也辛苦了。', '剩下的事明天再想。']
      },
      night: {
        greeting: ['夜深了，现在是 {time}。'],
        care: ['早点休息，明天见。', '别熬太久，眼睛会累。']
      },
      fallback: { greeting: ['你好，现在是 {time}。'], care: [] }
    }
  };
}

function Store(rootDir) {
  this.root = rootDir;
  this.configFile = path.join(rootDir, 'config.json');
  this.metaFile = path.join(rootDir, 'meta.json');
  this.cacheDir = path.join(rootDir, 'cache');
  this.config = fsx.clone(defaults());
  this.meta = null;
  this._saveTimer = null;
  this._listeners = [];
}

Store.prototype.init = function (appVersion) {
  fsx.ensureDir(this.root);
  fsx.ensureDir(this.cacheDir);
  var disk = fsx.readJsonSafe(this.configFile, null);
  if (disk && typeof disk === 'object') this.config = this._merge(defaults(), disk);
  this.meta = fsx.readJsonSafe(this.metaFile, null) || {};
  var today = fsx.stamp(new Date());
  if (!this.meta.firstInstallDate) {
    this.meta.firstInstallDate = today;
    this.meta.daysUsed = 1;
  }
  if (this.meta.lastRunDate !== today) {
    this.meta.daysUsed = (this.meta.daysUsed || 0) + 1;
    this.meta.lastRunDate = today;
  }
  this.meta.launches = (this.meta.launches || 0) + 1;
  this.meta.app = APP_INFO;
  this.meta.app.version = appVersion || APP_INFO.version;
  this.meta.lastSeenVersion = appVersion || APP_INFO.version;
  fsx.writeJsonAtomic(this.metaFile, this.meta);
  if (!disk) this.save();
  return this;
};

Store.prototype._merge = function (base, patch) {
  var out = fsx.clone(base);
  for (var key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    var value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') {
      out[key] = this._merge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

Store.prototype.get = function (dotted, fallback) {
  return fsx.getPath(this.config, dotted, fallback);
};

Store.prototype.set = function (dotted, value) {
  fsx.setPath(this.config, dotted, value);
  this.saveSoon();
  this._emit(dotted, value);
  return value;
};

Store.prototype.all = function () { return this.config; };
Store.prototype.appInfo = function () { return this.meta && this.meta.app ? this.meta.app : APP_INFO; };

Store.prototype.save = function () {
  try { fsx.writeJsonAtomic(this.configFile, this.config); } catch (e) { /* surfaced by logger */ }
  return this;
};

Store.prototype.saveSoon = function () {
  var self = this;
  if (this._saveTimer) clearTimeout(this._saveTimer);
  this._saveTimer = setTimeout(function () {
    self._saveTimer = null;
    self.save();
  }, 220);
};

Store.prototype.flush = function () {
  if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
  this.save();
  fsx.writeJsonAtomic(this.metaFile, this.meta);
};

Store.prototype.onChange = function (fn) { this._listeners.push(fn); };
Store.prototype._emit = function (key, value) {
  for (var i = 0; i < this._listeners.length; i++) this._listeners[i](key, value);
};

/** 免打扰判定：支持跨零点时段（22:30 -> 07:30）。 */
Store.prototype.inDnd = function (date) {
  var d = date || new Date();
  if (!this.get('dnd.enabled', true)) return false;
  var start = fsx.toMinutes(this.get('dnd.start'));
  var end = fsx.toMinutes(this.get('dnd.end'));
  if (start === null || end === null) return false;
  var now = d.getHours() * 60 + d.getMinutes();
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
};

Store.prototype.cacheWrite = function (name, value) {
  var file = path.join(this.cacheDir, name + '.json');
  try {
    fsx.writeJsonAtomic(file, { at: Date.now(), value: value });
    return true;
  } catch (e) { return false; }
};

Store.prototype.cacheRead = function (name, maxAgeMs) {
  var file = path.join(this.cacheDir, name + '.json');
  var raw = fsx.readJsonSafe(file, null);
  if (!raw || typeof raw !== 'object') return null;
  if (maxAgeMs && Date.now() - raw.at > maxAgeMs) return null;
  return raw.value;
};

Store.prototype.dirs = function () {
  return { root: this.root, cache: this.cacheDir, log: path.join(this.root, 'log') };
};

module.exports = { Store: Store, APP_INFO: APP_INFO, defaults: defaults };
