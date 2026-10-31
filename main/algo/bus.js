'use strict';

/**
 * 信息总线：接收信息层事件 -> 免打扰/去重判定 -> 交给算法层合成 -> 送渲染层。
 * 免打扰时段内不推送，只缓存最近 5 条，时段结束后补发最新一条。
 */

function Bus(deps) {
  this.store = deps.store;
  this.log = deps.log;
  this.composer = deps.composer;
  this.knowledge = deps.knowledge;
  this.out = deps.out;              // { show(pack) }
  this.queue = [];
  this.current = null;
  this.recent = {};
  this.dndHold = [];
  this.muted = {};
  this.muteMs = 30 * 60 * 1000;
  this.maxQueue = 5;
}

Bus.prototype.show = function (pack) {
  if (!pack) return;
  this.current = pack;
  this.log.info('bus', '推送[' + pack.kind + '] ' + pack.title);
  this.out.show(pack);
};

Bus.prototype.pushEvent = function (ev) {
  var pack = this.composer.fromEvent(ev);
  this.submit(pack, ev);
};

Bus.prototype.submit = function (pack, ev) {
  if (!pack) return;
  var now = new Date();
  if (this.store.inDnd(now)) {
    this.dndHold.push(pack);
    if (this.dndHold.length > 5) this.dndHold.shift();
    this.log.info('bus', '免打扰时段，暂不推送: ' + pack.title);
    return;
  }
  if (this.isMuted(pack.kind)) {
    this.log.info('bus', '该类消息已被“不要”静默，忽略: ' + pack.title);
    return;
  }
  if (this.isDuplicate(pack)) {
    this.log.debug('bus', '重复消息已忽略: ' + pack.title);
    return;
  }
  if (ev && ev.suppressIfSameTrack && pack.kind === 'media' && !pack.payload.playing) return;
  if (this.current) {
    this.queue.push(pack);
    if (this.queue.length > this.maxQueue) this.queue.shift();
    this.log.debug('bus', '已排队（当前有消息）: ' + pack.title);
    return;
  }
  this.show(pack);
};

/** 点了“不要”：同类消息在 muteMs 内不再打扰 */
Bus.prototype.mute = function (kind) {
  this.muted[kind] = Date.now() + this.muteMs;
};

Bus.prototype.isMuted = function (kind) {
  var until = this.muted[kind];
  if (!until) return false;
  if (Date.now() >= until) { delete this.muted[kind]; return false; }
  return true;
};

Bus.prototype.isDuplicate = function (pack) {
  var key = pack.kind + '|' + pack.title + '|' + (pack.rows[0] ? pack.rows[0].text : '');
  var at = this.recent[key];
  var now = Date.now();
  if (at && now - at < 90000) return true;
  this.recent[key] = now;
  var keys = Object.keys(this.recent);
  if (keys.length > 120) {
    for (var i = 0; i < keys.length - 60; i++) delete this.recent[keys[i]];
  }
  return false;
};

Bus.prototype.greeting = function (force) {
  var self = this;
  var band = this.composer.bandOf(new Date()).key;
  if (!force && this._lastGreetBand === band) return;
  this._lastGreetBand = band;
  this.knowledge.refreshAll(function () {
    self.show(self.composer.greeting());
  });
};

Bus.prototype.dismiss = function (id, action) {
  if (this.current && this.current.id === id) this.current = null;
  this.log.info('bus', '消息 ' + id + ' 处理结果: ' + action);
  var next = this.queue.shift();
  if (next) return this.show(next);
  if (this.dndHold.length && !this.store.inDnd()) {
    var backlog = this.dndHold;
    this.dndHold = [];
    this.log.info('bus', '免打扰结束，补发最新 1 条（积压 ' + backlog.length + ' 条）');
    return this.show(backlog[backlog.length - 1]);
  }
};

Bus.prototype.currentId = function () {
  return this.current ? this.current.id : null;
};

Bus.prototype.currentPack = function () { return this.current; };
Bus.prototype.bandLabel = function () { return this.composer.bandOf(new Date()).label; };
Bus.prototype.timeText = function () { return this.composer.timeText(new Date()); };

Bus.prototype.stats = function () {
  return { queued: this.queue.length, held: this.dndHold.length, showing: !!this.current };
};

module.exports = { Bus: Bus };
