'use strict';

/**
 * 信息层：通知中心（systemAPP）
 * 目标：抓取「时钟闹钟」「自动播放」等进入通知中心的 toast，交给 NoSense 竖条呈现。
 *
 * 平台实测结论（Win10 19045 + PowerShell 5.1）：
 *   Windows.UI.Notifications.UserNotificationListener 类型不存在，
 *   无法读取或移除通知中心里的既有通知。
 * 可行替代：只读解析系统通知库 wpndatabase.db 的临时副本（绝不写回系统库）。
 *   本机该库目前只有 Type='tile' 的磁贴更新记录；出现 toast 记录时即可抓取呈现。
 *   “从通知中心移除通知”在本系统无法实现，已在日志与设置页说明。
 */

var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var pexec = require('../util/pexec');

var DEFAULT_FILTER = ['clock', 'alarm', 'autoplay', 'playback', '时钟', '闹钟', '自动播放'];

function NotifCenter(deps) {
  EventEmitter.call(this);
  this.store = deps.store;
  this.log = deps.log;
  this.psDir = deps.psDir;
  this.intervalMs = 20000;
  this.timer = null;
  this.seen = {};
  this.ready = false;
  this.toasts = 0;
  this.scanned = 0;
}
NotifCenter.prototype = Object.create(EventEmitter.prototype);
NotifCenter.prototype.constructor = NotifCenter;

NotifCenter.prototype.start = function () {
  this.stopped = false;
  if (this.timer) return;
  var self = this;
  this.timer = setInterval(function () { self.tick(); }, this.intervalMs);
  setTimeout(function () { self.tick(); }, 4000);
};

NotifCenter.prototype.stop = function () {
  this.stopped = true;
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
};

NotifCenter.prototype.tick = function () {
  var self = this;
  var base = path.join(this.store.dirs().root, 'wpn-copy.sqlite');
  var script = path.join(this.psDir, 'wpn-copy.ps1');
  pexec.runScriptRaw(script, { Out: base }, 20000, function (err) {
    if (self.stopped) return;   // 已停止，丢弃在途结果
    var meta = readMeta(base + '.meta');
    var main = meta && meta.files && meta.files.length ? meta.files[0].path : base;
    if (err) self.failOnce('复制通知库失败: ' + err.message);
    else {
      try { self.readDb(main); } catch (e) { self.failOnce('读取通知库失败: ' + e.message); }
    }
    cleanup(base, meta);
  });
};

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function cleanup(base, meta) {
  var files = [base, base + '-wal', base + '-shm', base + '.meta'];
  if (meta && meta.files) {
    for (var i = 0; i < meta.files.length; i++) files.push(meta.files[i].path);
  }
  for (var j = 0; j < files.length; j++) {
    try { if (fs.existsSync(files[j])) fs.unlinkSync(files[j]); } catch (e) { /* 被占用则下次再删 */ }
  }
}

NotifCenter.prototype.failOnce = function (msg) {
  if (this._lastErr === msg) return;
  this._lastErr = msg;
  this.log.warn('notifCenter', msg);
};

NotifCenter.prototype.readDb = function (file) {
  if (!fs.existsSync(file)) return this.failOnce('通知库副本不存在，可能系统未启用通知中心');
  var sqlite;
  try { sqlite = require('node:sqlite'); } catch (e) {
    return this.failOnce('当前运行时无 node:sqlite，通知中心抓取不可用');
  }
  // 副本以读写方式打开：让 SQLite 折叠复制来的 -wal（只动副本，不动系统库）
  var db = new sqlite.DatabaseSync(file);
  var cols = columnNames(db, 'Notification');
  if (!cols.length) { db.close(); return this.failOnce('通知库里没有 Notification 表'); }
  var idCol = pickCol(cols, ['Id', 'NotificationId', 'RowId', 'rid']);
  var typeCol = pickCol(cols, ['Type', 'Kind', 'NotifyType']);
  var payCol = pickCol(cols, ['Payload', 'Xml', 'Content', 'RawData']);
  var timeCol = pickCol(cols, ['ArrivalTime', 'CreationTime', 'ModifiedTime', 'Timestamp']);
  var appCol = pickCol(cols, ['AppId', 'Provider', 'Sender', 'AumiId', 'Package']);
  if (!payCol || !timeCol) { db.close(); return this.failOnce('通知库字段不符合预期: ' + cols.join(',')); }

  var sql = 'select ' + q(idCol || 'rowid') + ' as id, ' + q(payCol) + ' as payload, ' +
    'cast(' + q(timeCol) + ' as text) as stamp' +
    (typeCol ? (', ' + q(typeCol) + ' as kind') : '') +
    (appCol ? (', ' + q(appCol) + ' as appid') : '') +
    ' from Notification order by ' + q(timeCol) + ' desc limit 80';
  var rows;
  try { rows = db.prepare(sql).all(); } catch (e) { db.close(); return this.failOnce('查询通知失败: ' + e.message); }
  db.close();

  this.ready = true;
  this.scanned = rows.length;
  var found = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var payload = String(row.payload || '');
    var isToast = row.kind ? String(row.kind).toLowerCase() === 'toast' : payload.indexOf('<toast') >= 0;
    if (!isToast) continue;
    this.toasts += 1;
    var parsed = parsePayload(payload);
    var appId = String(row.appid || parsed.app || '');
    if (!this.matches(appId + ' ' + parsed.title + ' ' + parsed.body)) continue;
    var key = String(row.id) + ':' + parsed.title;
    if (this.seen[key]) continue;
    this.seen[key] = Date.now();
    found.unshift({
      id: row.id, appId: appId, title: parsed.title, body: parsed.body,
      app: parsed.app || appId.split('_')[0] || '通知中心',
      at: fileTimeToDate(Number(row.stamp))
    });
  }
  for (var j = 0; j < found.length; j++) {
    var n = found[j];
    this.log.info('notifCenter', '捕获通知: ' + n.app + ' / ' + n.title);
    this.emit('notification', {
      kind: 'notif',
      tone: 'normal',
      title: '[' + n.app + '] ' + (n.title || '新通知'),
      body: n.body || '通知中心收到一条消息，NoSense 已代为呈现。',
      lines: ['时间 ' + clockOf(n.at) + '（本系统不支持从通知中心移除，仅替代呈现）'],
      payload: { appId: n.appId, notifId: n.id, hasLink: false }
    });
  }
  if (Object.keys(this.seen).length > 400) this.trimSeen();
};

NotifCenter.prototype.trimSeen = function () {
  var keys = Object.keys(this.seen).sort();
  for (var i = 0; i < keys.length - 200; i++) delete this.seen[keys[i]];
};

/** 只呈现用户关心的 systemAPP 通知：时钟闹钟 / 自动播放，关键词可在设置里追加 */
NotifCenter.prototype.matches = function (hay) {
  var text = String(hay || '').toLowerCase();
  var custom = String(this.store.get('notifCenter.apps', '') || '').toLowerCase();
  var words = DEFAULT_FILTER.concat(custom ? custom.split(/[,;、\s]+/) : []);
  for (var i = 0; i < words.length; i++) {
    if (words[i] && text.indexOf(words[i]) >= 0) return true;
  }
  return false;
};

function columnNames(db, table) {
  try {
    return db.prepare('pragma table_info(' + table + ')').all().map(function (r) { return r.name; });
  } catch (e) { return []; }
}

function pickCol(cols, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (cols.indexOf(candidates[i]) >= 0) return candidates[i];
  }
  return '';
}

function q(name) { return '[' + String(name).replace(/[[\]]/g, '') + ']'; }

function clockOf(d) {
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

function parsePayload(xml) {
  var out = { app: '', title: '', body: '' };
  var texts = [];
  var re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var t = decodeXml(m[1]).replace(/\s+/g, ' ').trim();
    if (t) texts.push(t);
  }
  out.title = texts.length ? texts[0] : '';
  out.body = texts.slice(1).join(' / ');
  var dn = /DisplayName="([^"]+)"/i.exec(xml);
  var brand = /Brand="([^"]+)"/i.exec(xml);
  out.app = dn ? decodeXml(dn[1]) : (brand ? decodeXml(brand[1]) : '');
  return out;
}

function decodeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/g, '&');
}

/** FILETIME（自 1601 起的 100ns 间隔）-> Date */
function fileTimeToDate(ft) {
  var n = Number(ft);
  if (!isFinite(n) || n <= 0) return new Date();
  var ms = n / 10000 - 11644473600000;
  var d = new Date(ms);
  return isNaN(d.getTime()) ? new Date() : d;
}

NotifCenter.prototype.status = function () {
  return { ready: this.ready, scanned: this.scanned, toasts: this.toasts, seen: Object.keys(this.seen).length };
};

module.exports = {
  NotifCenter: NotifCenter,
  parsePayload: parsePayload,
  fileTimeToDate: fileTimeToDate,
  DEFAULT_FILTER: DEFAULT_FILTER
};
