'use strict';

/**
 * PowerShell runner.
 * Chinese output through the Windows console codepage is unreliable, so every
 * script writes its JSON result to a temp file (UTF-8) and we read that back.
 */

var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');

var PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

var SEQ = 0;

function tmpOut(name) {
  SEQ += 1;
  return path.join(os.tmpdir(), 'nonsense-' + name + '-' + process.pid + '-' + Date.now() + '-' + SEQ + '.json');
}

function stripBom(s) {
  return s && s.charCodeAt(0) === 65279 ? s.slice(1) : s;
}

/**
 * file    absolute path to a .ps1
 * params  { Key: Value } plain object (values are passed as -Key Value)
 * runScript(file, params, [timeoutMs], cb)
 * cb(err, parsedJsonOrNull)
 */
function runScript(file, params, timeoutOrCb, maybeCb) {
  var cb = typeof timeoutOrCb === 'function' ? timeoutOrCb : maybeCb;
  var timeout = typeof timeoutOrCb === 'number' ? timeoutOrCb : 12000;
  var opts = { timeout: timeout };
  var out = tmpOut(opts.tag || path.basename(file, '.ps1'));
  var args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Out', out];
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    var value = params[key];
    if (value === undefined || value === null) continue;
    args.push('-' + key);
    args.push(String(value));
  }
  var settled = false;
  var child;
  function finish(err, data) {
    if (settled) return;
    settled = true;
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (e) { /* keep going */ }
    cb(err, data);
  }
  try {
    child = cp.spawn(PS, args, { windowsHide: true });
  } catch (e) { return finish(e); }

  var stderr = '';
  child.stderr.on('data', function (c) { stderr += c.toString('utf8'); });
  child.on('error', function (e) { finish(e); });
  var killer = setTimeout(function () {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    finish(new Error('powershell timeout after ' + opts.timeout + 'ms'));
  }, opts.timeout || 12000);

  child.on('exit', function (code) {
    clearTimeout(killer);
    if (code !== 0 && !fs.existsSync(out)) {
      return finish(new Error('powershell exit ' + code + ': ' + stderr.slice(0, 220).replace(/\s+/g, ' ')));
    }
    var text;
    try { text = stripBom(fs.readFileSync(out, 'utf8')); } catch (e) { return finish(e); }
    if (!text || !text.trim()) return finish(null, null);
    try { finish(null, JSON.parse(text)); } catch (e) { finish(new Error('bad json from ' + path.basename(file) + ': ' + text.slice(0, 160))); }
  });
}

/** Run a script that writes its own files instead of returning JSON to us. */
function runScriptRaw(file, params, timeout, cb) {
  var args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    if (params[key] === undefined || params[key] === null) continue;
    args.push('-' + key);
    args.push(String(params[key]));
  }
  var settled = false;
  function finish(err) {
    if (settled) return;
    settled = true;
    cb(err);
  }
  var child;
  try { child = cp.spawn(PS, args, { windowsHide: true }); } catch (e) { return finish(e); }
  var stderr = '';
  child.stderr.on('data', function (c) { stderr += c.toString('utf8'); });
  child.on('error', finish);
  var killer = setTimeout(function () {
    try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
    finish(new Error('powershell timeout ' + timeout + 'ms'));
  }, timeout || 15000);
  child.on('exit', function (code) {
    clearTimeout(killer);
    if (code === 0) return finish(null);
    finish(new Error('powershell exit ' + code + ': ' + stderr.slice(0, 200).replace(/\s+/g, ' ')));
  });
}

module.exports = { runScript: runScript, runScriptRaw: runScriptRaw, PS: PS };
