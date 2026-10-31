'use strict';

/** Small filesystem helpers shared by store / logger / sensors. */

var fs = require('fs');
var path = require('path');

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e && e.code !== 'EEXIST') throw e;
  }
  return dir;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/** Atomic-ish write: temp file then rename, so a crash never leaves a half config. */
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  var tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) { /* windows rename needs absent target */ }
  fs.renameSync(tmp, file);
}

function stamp(date) {
  var d = date || new Date();
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function clock(date) {
  var d = date || new Date();
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 'HH:MM' -> minutes from midnight; null when malformed. */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fromMinutes(total) {
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return p(Math.floor(total / 60) % 24) + ':' + p(total % 60);
}

function getPath(obj, dotted, fallback) {
  var parts = dotted.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
    cur = cur[parts[i]];
  }
  return cur === undefined ? fallback : cur;
}

function setPath(obj, dotted, value) {
  var parts = dotted.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


module.exports = {
  ensureDir: ensureDir,
  readJsonSafe: readJsonSafe,
  writeJsonAtomic: writeJsonAtomic,
  stamp: stamp,
  clock: clock,
  toMinutes: toMinutes,
  fromMinutes: fromMinutes,
  getPath: getPath,
  setPath: setPath,
  clone: clone
};
