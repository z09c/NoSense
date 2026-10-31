'use strict';

/**
 * SDK: 每日热搜。
 * 优先抓 Bing（必应首页热搜接口随官方改动较大，故给出多个候选端点），
 * 全部失败时退回可用来源（百度热搜榜），并在返回里注明实际来源。
 */

var net = require('./../util/net');

var BING_ENDPOINTS = [
  { name: 'bing-hotsearch-json', url: 'https://cn.bing.com/office/render.serf/stream?path=/content/hp/json/hotsearch&locale=zh-CN&maek=0' },
  { name: 'bing-api-v1', url: 'https://cn.bing.com/api/v1?scene=hp&count=12&format=json&locale=zh-CN' },
  { name: 'bing-hp-page', url: 'https://cn.bing.com/?ensearch=0&format=rss' }
];

var BAIDU_URL = 'https://top.baidu.com/api/board?platform=pc&tab=realtime';
var BAIDU_OPTS = {
  timeout: 9000,
  headers: { Referer: 'https://top.baidu.com/board?platform=pc&tab=realtime' }
};

function normalize(list, source) {
  var out = [];
  for (var i = 0; i < list.length && out.length < 20; i++) {
    var it = list[i];
    if (!it) continue;
    var title = it.title || it.word || it.query || it.text || it.name || '';
    if (typeof title !== 'string' || !title.trim()) continue;
    var url = it.url || it.rawUrl || it.link || it.href || '';
    if (url && /^www\./.test(url)) url = 'https://' + url;
    out.push({
      rank: out.length + 1,
      title: title.trim(),
      desc: typeof it.desc === 'string' ? it.desc.trim() : '',
      hot: it.hotScore || it.hot || it.index || it.score || '',
      url: url,
      source: source
    });
  }
  return out;
}

function fromObjectTree(json) {
  var found = null;
  function walk(node, depth) {
    if (found || depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node) && node.length >= 3) {
      var hits = 0;
      for (var i = 0; i < node.length; i++) {
        var e = node[i];
        if (e && typeof e === 'object' && (e.title || e.word || e.query || e.text)) hits++;
      }
      if (hits >= 3) { found = node; return; }
    }
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      walk(node[key], depth + 1);
      if (found) return;
    }
  }
  walk(json, 0);
  return found;
}

function grabBing(list, done) {
  if (!list.length) return done(new Error('bing: 候选端点全部失败'));
  var endpoint = list[0];
  net.getText(endpoint.url, { timeout: 9000 }, function (err, text) {
    if (err) return grabBing(list.slice(1), done);
    var items = null;
    if (/\{\s*"/.test(text) || /\[\s*\{/.test(text)) {
      try { items = fromObjectTree(JSON.parse(text)); } catch (e) { items = null; }
    }
    if (!items) {
      // html blob: pull the hot-search titles out of the embedded json fragment
      var scraped = [];
      var re = /"(?:query|text|title)"\s*:\s*"([^"]{2,60})"(?:\s*,\s*"(?:url|link)"\s*:\s*"([^"]*)")?/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        scraped.push({ title: decode(m[1]), url: m[2] ? decode(m[2]) : '' });
        if (scraped.length >= 20) break;
      }
      items = scraped;
    }
    var norm = normalize(items || [], 'bing');
    if (norm.length < 3) return grabBing(list.slice(1), done);
    done(null, { provider: endpoint.name, items: norm });
  });
}

function decode(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); });
}

function grabBaidu(cb) {
  net.getJson(BAIDU_URL, BAIDU_OPTS, function (err, json) {
    if (err) return cb(err);
    var cards = json && json.data && json.data.cards ? json.data.cards : null;
    if (!cards) return cb(new Error('baidu: 结构异常'));
    var merged = [];
    for (var i = 0; i < cards.length; i++) {
      var content = cards[i].content;
      if (Array.isArray(content)) merged = merged.concat(content);
      var top = cards[i].topContent;
      if (Array.isArray(top)) merged = top.concat(merged);
    }
    cb(null, { provider: 'baidu-board', items: normalize(merged, 'baidu') });
  });
}

/** cfg: { provider: 'auto'|'bing'|'baidu' } */
function fetch(cfg, cb) {
  var mode = (cfg && cfg.provider) || 'auto';
  if (mode === 'baidu') {
    return grabBaidu(function (err, data) {
      cb(err, data, err ? 'baidu 失败: ' + err.message : '');
    });
  }
  grabBing(BING_ENDPOINTS, function (err, data) {
    if (!err) return cb(null, data, '');
    grabBaidu(function (err2, data2) {
      if (!err2) return cb(null, data2, 'bing 不可用(' + err.message + ')，已改用百度热搜榜');
      cb(new Error('热搜全部来源失败: ' + err.message + ' / ' + err2.message), null, '');
    });
  });
}

module.exports = { fetch: fetch, BING_ENDPOINTS: BING_ENDPOINTS };
