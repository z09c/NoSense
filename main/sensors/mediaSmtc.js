'use strict';

/**
 * 信息层：第三方 SMTC 媒体会话（音乐/视频）。
 * 轮询 smtc.ps1，曲目或播放状态变化时上报；同时给面板提供“正在播放”快照。
 */

var EventEmitter = require('events').EventEmitter;
var pexec = require('../util/pexec');

function MediaSmtc(deps) {
  EventEmitter.call(this);
  this.store = deps.store;
  this.log = deps.log;
  this.psDir = deps.psDir;
  this.intervalMs = 6000;
  this.timer = null;
  this.current = null;
  this.lastKey = '';
  this.lastEmit = 0;
  this.minEmitGap = 20000;
  this.failCount = 0;
}
MediaSmtc.prototype = Object.create(EventEmitter.prototype);
MediaSmtc.prototype.constructor = MediaSmtc;

MediaSmtc.prototype.start = function () {
  this.stopped = false;
  if (this.timer) return;
  var self = this;
  this.timer = setInterval(function () { self.tick(); }, this.intervalMs);
  setTimeout(function () { self.tick(); }, 1500);
};

MediaSmtc.prototype.stop = function () {
  this.stopped = true;
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
};

MediaSmtc.prototype.tick = function () {
  var self = this;
  pexec.runScript(require('path').join(this.psDir, 'smtc.ps1'), {}, 12000, function (err, json) {
    if (self.stopped) return;   // stop() 之后到达的在途结果直接丢弃
    if (err || !json || !json.ok) {
      self.failCount += 1;
      if (self.failCount <= 1 || self.failCount % 40 === 0) {
        self.log.warn('smtc', '媒体采集失败: ' + (err ? err.message : (json && json.error)));
      }
      return;
    }
    self.failCount = 0;
    var best = pick(json);
    if (!best) {
      if (self.current && self.current.playing) self.emit('stopped', { kind: 'media', action: 'stopped' });
      self.current = null;
      self.lastKey = '';
      return;
    }
    best.source = json.source;
    var changed = self.apply(best);
    if (changed) self.maybeEmit(best);
  });
};

function pick(json) {
  var list = json.sessions || [];
  for (var i = 0; i < list.length; i++) if (list[i].playing) return list[i];
  return list.length ? list[0] : null;
}

/** SMTC 有时不给 DisplayName，用会话 id 里的包名兜底 */
function guessApp(session) {
  var id = String(session.id || '');
  if (id.indexOf('fg:') === 0) return id.slice(3);
  return id.split('!')[0] || '外部播放器';
}

MediaSmtc.prototype.apply = function (session) {
  if (!session.app) session.app = guessApp(session);
  var key = [session.app, session.title, session.artist, session.playing ? 'p' : (session.paused ? 'q' : 's')].join('|');
  var changed = key !== this.lastKey;
  if (changed) {
    var previous = this.current;
    this.current = session;
    this.lastKey = key;
    this._previous = previous;
  }
  return changed;
};

MediaSmtc.prototype.maybeEmit = function (session) {
  var now = Date.now();
  if (now - this.lastEmit < this.minEmitGap) return;
  this.lastEmit = now;
  var prev = this._previous;
  var what = session.playing ? '播放' : (session.paused ? '暂停' : '停止');
  var app = session.app || guessApp(session);
  var titleLine = session.title ? session.title : '(无标题)';
  var sub = [];
  if (session.artist) sub.push(session.artist);
  if (session.album) sub.push(session.album);
  if (session.source === 'foreground') sub.push('来源：前台窗口标题');
  this.emit('media', {
    kind: 'media',
    tone: 'normal',
    title: app + ' ' + what,
    body: titleLine + (sub.length ? (' — ' + sub.join(' · ')) : ''),
    lines: [],
    payload: {
      app: session.app, title: session.title, artist: session.artist, album: session.album,
      state: session.state, position: session.position, duration: session.duration, source: session.source
    },
    suppressIfSameTrack: !!prev && prev.title === session.title
  });
};

MediaSmtc.prototype.snapshot = function () {
  return this.current ? {
    app: this.current.app, title: this.current.title, artist: this.current.artist,
    album: this.current.album, state: this.current.state,
    position: this.current.position, duration: this.current.duration, source: this.current.source
  } : null;
};

module.exports = { MediaSmtc: MediaSmtc };
