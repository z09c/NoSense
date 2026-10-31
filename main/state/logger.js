'use strict';

/** File logger: one JSONL per day + an in-RAM ring buffer for the settings UI. */

var fs = require('fs');
var path = require('path');
var fsx = require('../util/fsx');

var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
var KEEP_DAYS = 14;

function Logger(logDir, minLevel, echo) {
  this.dir = logDir;
  fsx.ensureDir(this.dir);
  this.min = LEVELS[minLevel || 'info'];
  this.echo = !!echo;
  this.ring = [];
  this._prune();
}

Logger.prototype._file = function () {
  return path.join(this.dir, fsx.stamp(new Date()) + '.log');
};

Logger.prototype.write = function (level, tag, message, extra) {
  if ((LEVELS[level] || 20) < this.min) return;
  var entry = {
    t: fsx.stamp(new Date()) + ' ' + fsx.clock(new Date()),
    ms: Date.now(),
    level: level,
    tag: tag,
    msg: String(message),
    data: extra === undefined ? undefined : extra
  };
  this.ring.push(entry);
  if (this.ring.length > 300) this.ring.shift();
  if (this.echo) {
    console.log('[' + entry.t.slice(11) + '] ' + level.toUpperCase() + ' ' + tag + ' · ' + entry.msg);
  }
  try {
    fs.appendFileSync(this._file(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* never let logging crash the app */ }
};

Logger.prototype.debug = function (tag, msg, extra) { this.write('debug', tag, msg, extra); };
Logger.prototype.info = function (tag, msg, extra) { this.write('info', tag, msg, extra); };
Logger.prototype.warn = function (tag, msg, extra) { this.write('warn', tag, msg, extra); };
Logger.prototype.error = function (tag, msg, extra) { this.write('error', tag, msg, extra); };

Logger.prototype.tail = function (limit, level) {
  var min = LEVELS[level || 'debug'] || 0;
  var out = [];
  for (var i = this.ring.length - 1; i >= 0 && out.length < (limit || 100); i--) {
    if ((LEVELS[this.ring[i].level] || 20) >= min) out.push(this.ring[i]);
  }
  return out;
};

Logger.prototype._prune = function () {
  var self = this;
  var cutoff = Date.now() - KEEP_DAYS * 86400000;
  try {
    var names = fs.readdirSync(this.dir);
    for (var i = 0; i < names.length; i++) {
      var full = path.join(this.dir, names[i]);
      var m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(names[i]);
      if (!m) continue;
      if (Date.parse(m[1] + 'T00:00:00') < cutoff) {
        try { fs.unlinkSync(full); } catch (e) { void self; }
      }
    }
  } catch (e) { /* dir missing is fine */ }
};

module.exports = { Logger: Logger, LEVELS: LEVELS };
