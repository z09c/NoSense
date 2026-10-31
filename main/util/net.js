'use strict';

/**
 * ES5 HTTP/HTTPS helper. Callback style, no promises, no async.
 */

var http = require('http');
var https = require('https');
var zlib = require('zlib');
var urlMod = require('url');

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 NoSense/0.1';

function decode(buffer, encoding, cb) {
  encoding = (encoding || '').toLowerCase();
  if (encoding.indexOf('gzip') >= 0 && zlib.gunzipSync) {
    try { return cb(null, zlib.gunzipSync(buffer)); } catch (e) { return cb(null, buffer); }
  }
  if (encoding.indexOf('deflate') >= 0) {
    try { return cb(null, zlib.inflateSync(buffer)); } catch (e) {
      try { return cb(null, zlib.inflateRawSync(buffer)); } catch (e2) { return cb(null, buffer); }
    }
  }
  if (encoding.indexOf('br') >= 0 && zlib.brotliDecompressSync) {
    try { return cb(null, zlib.brotliDecompressSync(buffer)); } catch (e) { return cb(null, buffer); }
  }
  return cb(null, buffer);
}

function request(rawUrl, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  var settled = false;
  var target = urlMod.parse(rawUrl);
  var transport = target.protocol === 'http:' ? http : https;
  var headers = {
    'User-Agent': opts.ua || UA,
    'Accept': opts.accept || 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.8,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate'
  };
  if (opts.headers) {
    for (var k in opts.headers) {
      if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
    }
  }
  function done(err, res) {
    if (settled) return;
    settled = true;
    cb(err, res);
  }
  var req = transport.get({
    host: target.hostname,
    port: target.port,
    path: target.path,
    headers: headers,
    timeout: opts.timeout || 9000
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      decode(Buffer.concat(chunks), res.headers['content-encoding'], function (err, buf) {
        if (err) return done(err);
        done(null, {
          status: res.statusCode,
          headers: res.headers,
          buffer: buf,
          text: buf.toString(opts.encoding || 'utf8')
        });
      });
    });
  });
  req.on('timeout', function () { req.abort(); done(new Error('timeout: ' + rawUrl)); });
  req.on('error', function (e) { done(e); });
}

function getText(rawUrl, opts, cb) {
  request(rawUrl, opts, function (err, res) {
    if (err) return cb(err);
    if (res.status >= 400) return cb(new Error('http ' + res.status + ' for ' + rawUrl));
    cb(null, res.text, res);
  });
}

function getJson(rawUrl, opts, cb) {
  getText(rawUrl, opts, function (err, text) {
    if (err) return cb(err);
    var body = text;
    var start = body.indexOf('{');
    var arr = body.indexOf('[');
    if (start > 0 || arr === 0) {
      // tolerate jsonp-ish wrappers / leading BOM or noise
      var from = arr >= 0 && (start < 0 || arr < start) ? arr : start;
      if (from > 0) body = body.slice(from);
    }
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) { return cb(new Error('bad json from ' + rawUrl + ': ' + e.message)); }
    cb(null, parsed);
  });
}

module.exports = { request: request, getText: getText, getJson: getJson, UA: UA };
