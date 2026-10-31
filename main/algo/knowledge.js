'use strict';

/**
 * 算法层 A：存储和处理 SDK 信息。
 * - 拉取到的原始数据归一化后落盘（重启即用，不依赖网络）
 * - 对外只暴露 string 形态：名句 string、当前+未来24小时天气 string、热点 array
 */

var weatherSdk = require('../sdk/weather');
var quoteSdk = require('../sdk/quote');
var hotSdk = require('../sdk/hotsearch');

var KEY = { quote: 'quote', weather: 'weather', hot: 'hot' };

function friendlySource(provider) {
  if (!provider) return '未知来源';
  if (provider.indexOf('baidu') === 0) return '百度热搜榜';
  if (provider.indexOf('bing') === 0) return '必应热搜';
  return provider;
}

function Knowledge(store, log) {
  this.store = store;
  this.log = log;
  this.snap = {
    quote: store.cacheRead(KEY.quote, 0),
    weather: store.cacheRead(KEY.weather, 0),
    hot: store.cacheRead(KEY.hot, 0)
  };
  this._busy = {};
}

Knowledge.prototype._ttl = function (group, unitMs, fallback) {
  var n = Number(this.store.get('refresh.' + group));
  if (!isFinite(n) || n <= 0) n = fallback;
  return n * unitMs;
};

Knowledge.prototype._load = function (name, ttl, loader, cb) {
  var self = this;
  var cached = this.snap[name];
  if (cached && ttl > 0 && Date.now() - cached._at < ttl) return cb(null, cached, true);
  if (this._busy[name]) return cb(new Error('busy'), null, true);
  this._busy[name] = true;
  loader(function (err, value) {
    self._busy[name] = false;
    if (err) {
      self.log.warn('knowledge', name + ' 刷新失败: ' + err.message);
      // 失败时保留旧数据，只是不再阻塞后续刷新
      if (cached && cached._at > Date.now() - ttl * 12) return cb(null, cached, false);
      return cb(err, null, false);
    }
    value._at = Date.now();
    self.snap[name] = value;
    self.store.cacheWrite(KEY[name], value);
    self.log.info('knowledge', name + ' 已刷新: ' + (value._label || ''));
    cb(null, value, false);
  });
};

Knowledge.prototype.refreshQuote = function (cb) {
  var self = this;
  this._load('quote', this._ttl('quoteHours', 3600000, 6), function (done) {
    quoteSdk.fetch(function (err, q) {
      if (err) return done(err);
      done(null, { text: q.text, from: q.from, fromWho: q.fromWho, cat: q.cat, _label: q.text.slice(0, 16) });
    });
  }, cb || function () {});
};

Knowledge.prototype.refreshWeather = function (cb) {
  var self = this;
  var cfg = {
    provider: this.store.get('weather.provider', 'auto'),
    city: this.store.get('weather.city', ''),
    districtId: this.store.get('weather.districtId', ''),
    lat: this.store.get('weather.lat'),
    lon: this.store.get('weather.lon'),
    xiaomiKey: this.store.get('weather.xiaomiKey', '')
  };
  this._load('weather', this._ttl('weatherMinutes', 60000, 30), function (done) {
    weatherSdk.fetch(cfg, function (err, data) {
      if (err) return done(err);
      data._label = data.now.text + ' ' + data.now.tempC + '℃';
      done(null, data);
    });
  }, cb || function () {});
};

Knowledge.prototype.refreshHot = function (cb) {
  var self = this;
  var cfg = { provider: this.store.get('hot.provider', 'auto') };
  this._load('hot', this._ttl('hotMinutes', 60000, 30), function (done) {
    hotSdk.fetch(cfg, function (err, data, note) {
      if (err) return done(err);
      if (note) self.log.info('hotsearch', note);
      data._label = friendlySource(data.provider) + ' ' + data.items.length + ' 条';
      done(null, data);
    });
  }, cb || function () {});
};

Knowledge.prototype.refreshAll = function (cb) {
  var left = 3;
  var callback = cb;
  function done() {
    left -= 1;
    if (left <= 0 && callback) {
      var fn = callback;
      callback = null;
      fn();
    }
  }
  this.refreshQuote(done);
  this.refreshWeather(done);
  this.refreshHot(done);
};

/* ---------- string extraction (给合成语句用) ---------- */

Knowledge.prototype.quoteString = function () {
  var q = this.snap.quote;
  if (!q || !q.text) return '';
  var tail = q.from ? ('—— ' + (q.fromWho ? q.fromWho + '《' + q.from + '》' : q.from)) : '';
  if (tail && /——/.test(q.text)) tail = '';
  return q.text + (tail ? (' ' + tail) : '');
};

Knowledge.prototype.weatherString = function () {
  var w = this.snap.weather;
  if (!w) return '';
  var line = (w.city ? w.city + ' ' : '') + w.now.text + ' ' + Math.round(w.now.tempC) + '℃';
  if (w.min24h !== null && w.max24h !== null) line += '，未来24小时 ' + Math.round(w.min24h) + '~' + Math.round(w.max24h) + '℃';
  var rain = this._maxRain(w.hourly);
  if (rain !== null && rain >= 40) line += '，注意携带雨具（最高降水概率 ' + rain + '%）';
  return line;
};

Knowledge.prototype._maxRain = function (hours) {
  var v = null;
  for (var i = 0; i < (hours || []).length; i++) {
    var p = hours[i].rainProb;
    if (typeof p === 'number' && (v === null || p > v)) v = p;
  }
  return v;
};

Knowledge.prototype.hotString = function (count) {
  var items = (this.snap.hot && this.snap.hot.items) || [];
  var n = Math.min(count || 3, items.length);
  var out = [];
  for (var i = 0; i < n; i++) out.push((i + 1) + '.' + items[i].title);
  return out.join('；');
};

Knowledge.prototype.hotItems = function (count) {
  var items = (this.snap.hot && this.snap.hot.items) || [];
  return items.slice(0, count || 12);
};

Knowledge.prototype.hourly24 = function () {
  return (this.snap.weather && this.snap.weather.hourly) || [];
};

Knowledge.prototype.status = function () {
  var names = ['quote', 'weather', 'hot'];
  var out = {};
  for (var i = 0; i < names.length; i++) {
    var snap = this.snap[names[i]];
    out[names[i]] = snap ? { at: snap._at, label: snap._label || '' } : null;
  }
  if (this.snap.hot) out.hot.count = (this.snap.hot.items || []).length;
  return out;
};

module.exports = { Knowledge: Knowledge };
