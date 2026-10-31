/* 渲染层：天气面板 / 热点面板（数据由主进程随 ui:panel 事件下发） */
(function () {
  'use strict';

  var api = window.noSense;
  if (!api) return;

  var scroll = document.getElementById('scroll');
  var kindEl = document.getElementById('kind');
  var subEl = document.getElementById('sub');
  document.getElementById('close').onclick = function () { api.send('panel:close'); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderWeather(data) {
    kindEl.textContent = '天气';
    if (!data || !data.now) {
      subEl.textContent = '';
      scroll.appendChild(el('div', 'empty', '天气数据尚未就绪（稍后自动重试，或在设置里检查来源）。'));
      return;
    }
    subEl.textContent = (data.provider || '') + (data.observedAt ? ' · 观测于 ' + String(data.observedAt).replace('T', ' ') : '');
    var now = el('div', 'now');
    now.appendChild(el('div', 'temp', Math.round(data.now.tempC) + '°'));
    now.appendChild(el('div', 'wtext', data.now.text || ''));
    now.appendChild(el('div', 'city', (data.city || '') + (data.now.wind ? ' · 风 ' + data.now.wind : '')));
    scroll.appendChild(now);

    var range = el('div', 'desc');
    range.textContent = '未来 24 小时：' + round(data.min24h) + '~' + round(data.max24h) + '℃，共 ' + (data.hourly || []).length + ' 条';
    scroll.appendChild(range);

    var box = el('div', 'hours');
    var hours = data.hourly || [];
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      var cell = el('div', 'hour' + (h.rainProb >= 50 ? ' rain' : ''));
      cell.appendChild(el('span', null, h.label));
      cell.appendChild(el('b', null, (h.tempC === null ? '-' : Math.round(h.tempC) + '°')));
      cell.appendChild(el('span', null, h.text + (h.rainProb !== null && h.rainProb !== undefined ? ' ' + h.rainProb + '%' : '')));
      box.appendChild(cell);
    }
    scroll.appendChild(box);
  }

  function round(v) { return v === null || v === undefined ? '-' : Math.round(v); }

  function renderHot(data) {
    kindEl.textContent = '今日热点';
    var items = (data && data.items) || [];
    subEl.textContent = (data && data.provider ? '来源 ' + data.provider : '') + ' · 点击标题跳转';
    if (!items.length) {
      scroll.appendChild(el('div', 'empty', '热点数据尚未就绪（稍后自动重试）。'));
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var row = el('div', 'item');
      row.appendChild(el('div', 'rank' + (i < 3 ? ' hot' : ''), it.rank || (i + 1)));
      var right = el('div');
      var link = el('a', 'link', it.title);
      if (it.url) link.onclick = (function (url) { return function () { api.send('panel:open-url', url); }; })(it.url);
      right.appendChild(link);
      if (it.desc) right.appendChild(el('div', 'desc', it.desc));
      row.appendChild(right);
      scroll.appendChild(row);
    }
  }

  api.on('ui:panel', function (msg) {
    clear(scroll);
    if (!msg) return;
    if (msg.kind === 'weather') renderWeather(msg.data);
    else if (msg.kind === 'hot') renderHot(msg.data);
  });

  api.send('panel:ready');
})();
