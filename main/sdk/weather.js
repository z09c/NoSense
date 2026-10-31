'use strict';

/**
 * SDK: 天气源。
 * provider 'xiaomi'   -> 小米天气开放接口（需要在设置里填 key）
 * provider 'openmeteo'-> 免密钥兜底，返回当前 + 未来 24 小时
 * provider 'auto'     -> 先试小米，失败或无 key 时用 open-meteo
 */

var net = require('./../util/net');

var CODE_TEXT = {
  0: '晴', 1: '基本晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '大雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹'
};

function codeText(code) {
  var n = parseInt(code, 10);
  return CODE_TEXT[n] || '未知';
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function openMeteo(cfg, cb) {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + cfg.lat + '&longitude=' + cfg.lon +
    '&current_weather=true&hourly=temperature_2m,weathercode,precipitation_probability&timezone=Asia%2FShanghai&forecast_days=2';
  net.getJson(url, { timeout: 10000 }, function (err, json) {
    if (err) return cb(err);
    if (!json || !json.current_weather) return cb(new Error('open-meteo: 无当前天气字段'));
    var now = json.current_weather;
    var hourly = json.hourly || {};
    var hours = [];
    var startIdx = 0;
    if (hourly.time && hourly.time.length) {
      var nowHour = (now.time || '').slice(0, 13);
      for (var i = 0; i < hourly.time.length; i++) {
        if (String(hourly.time[i]).slice(0, 13) >= nowHour) { startIdx = i; break; }
      }
    }
    for (var j = startIdx; j < hourly.time.length && hours.length < 24; j++) {
      hours.push({
        time: hourly.time[j],
        label: pad2(parseInt(String(hourly.time[j]).slice(11, 13), 10)) + ':00',
        tempC: hourly.temperature_2m ? hourly.temperature_2m[j] : null,
        code: hourly.weathercode ? hourly.weathercode[j] : null,
        text: hourly.weathercode ? codeText(hourly.weathercode[j]) : '',
        rainProb: hourly.precipitation_probability ? hourly.precipitation_probability[j] : null
      });
    }
    cb(null, {
      provider: 'open-meteo',
      city: cfg.city,
      observedAt: now.time,
      now: { tempC: now.temperature, text: codeText(now.weathercode), code: now.weathercode, wind: now.windspeed },
      hourly: hours,
      min24h: minOf(hours),
      max24h: maxOf(hours)
    });
  });
}

function minOf(list) {
  var v = null;
  for (var i = 0; i < list.length; i++) {
    var t = list[i].tempC;
    if (typeof t === 'number' && (v === null || t < v)) v = t;
  }
  return v;
}

function maxOf(list) {
  var v = null;
  for (var i = 0; i < list.length; i++) {
    var t = list[i].tempC;
    if (typeof t === 'number' && (v === null || t > v)) v = t;
  }
  return v;
}

function xiaomi(cfg, cb) {
  if (!cfg.xiaomiKey) return cb(new Error('xiaomi: 未配置 key'));
  var url = 'https://api23.misat.xiaomi.com/weather-api/v1/forecast/all' +
    '?districtId=' + encodeURIComponent(cfg.districtId || '') +
    '&key=' + encodeURIComponent(cfg.xiaomiKey) + '&app_id=weather';
  net.getJson(url, { timeout: 10000 }, function (err, json) {
    if (err) return cb(err);
    var d = json && json.data ? json.data : json;
    var realtime = d && d.realtime;
    if (!realtime || !realtime.info) return cb(new Error('xiaomi: 返回结构不符合预期'));
    var future = (d.future || []).slice(0, 24);
    var hours = [];
    for (var i = 0; i < future.length; i++) {
      var f = future[i];
      hours.push({
        time: f.date + 'T' + pad2(parseInt(f.hours || 0, 10)) + ':00',
        label: pad2(parseInt(f.hours || 0, 10)) + ':00',
        tempC: f.temperature === undefined ? null : Number(f.temperature),
        code: null,
        text: f.weather ? String(f.weather) : (f.notes || ''),
        rainProb: f.rainProbability === undefined ? null : Number(f.rainProbability)
      });
    }
    cb(null, {
      provider: 'xiaomi',
      city: cfg.city,
      observedAt: realtime.time || '',
      now: { tempC: Number(realtime.info.temperature), text: String(realtime.info.weather || ''), code: null, wind: realtime.info.direct || '' },
      hourly: hours,
      min24h: minOf(hours),
      max24h: maxOf(hours)
    });
  });
}

/** cfg: { provider, city, districtId, lat, lon, xiaomiKey } */
function fetch(cfg, cb) {
  var mode = cfg.provider || 'auto';
  if (mode === 'openmeteo') return openMeteo(cfg, cb);
  if (mode === 'xiaomi') return xiaomi(cfg, cb);
  xiaomi(cfg, function (err, data) {
    if (!err) return cb(null, data);
    openMeteo(cfg, function (err2, data2) {
      if (err2) return cb(new Error('天气全部来源失败: xiaomi(' + err.message + ') / open-meteo(' + err2.message + ')'));
      cb(null, data2);
    });
  });
}

module.exports = { fetch: fetch, codeText: codeText };
