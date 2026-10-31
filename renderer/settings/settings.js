/* 用户配置层：设置界面（左侧菜单 + 右侧二级内容，风格与通知一致） */
(function () {
  'use strict';

  var api = window.noSense;
  if (!api) return;

  var content = document.getElementById('content');
  var pageTitle = document.getElementById('page-title');
  var dndFlag = document.getElementById('dnd-flag');
  var state = { cfg: {}, info: {} };
  var page = 'about';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function getPath(cfg, dotted) {
    var parts = dotted.split('.');
    var cur = cfg;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setCfg(path, value) {
    api.send('settings:set', { path: path, value: value });
  }

  /** 本地镜像也按点路径写入，界面立即反映新值 */
  function writeLocal(path, value) {
    var parts = path.split('.');
    var cur = state.cfg;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function two(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---------- 滚轮/按钮调节控件 ---------- */
  function spin(opts) {
    var box = el('span', 'wheel');
    var up = el('button', null, '▲');
    var num = el('span', 'num', two(opts.get()));
    var down = el('button', null, '▼');
    var unit = el('span', 'unit', opts.unit || '');
    box.appendChild(up); box.appendChild(num); box.appendChild(down); box.appendChild(unit);
    function apply(delta) {
      var next = opts.step(delta);
      num.textContent = two(next);
      opts.set(next);
    }
    up.onclick = function () { apply(1); };
    down.onclick = function () { apply(-1); };
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      apply(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    box.title = '可用滚轮或上下按钮调整';
    return box;
  }

  function timeSpin(label, path, unitName) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var pair = el('div', 'spin-pair');
    function parts() {
      var v = String(getPath(state.cfg, path) || '00:00');
      var m = /^(\d{1,2}):(\d{2})$/.exec(v);
      return { h: m ? parseInt(m[1], 10) : 0, m: m ? parseInt(m[2], 10) : 0 };
    }
    function write(h, m) {
      var v = two(h) + ':' + two(m);
      writeLocal(path, v);
      setCfg(path, v);
      refreshFlag();
    }
    pair.appendChild(spin({
      unit: '时',
      get: function () { return parts().h; },
      step: function (d) { var h = (parts().h + d + 24) % 24; write(h, parts().m); return h; }
    }));
    pair.appendChild(spin({
      unit: '分',
      get: function () { return parts().m; },
      step: function (d) { var m = (parts().m + d * 5 + 60) % 60; write(parts().h, m); return m; }
    }));
    pair.appendChild(el('span', 'hint', unitName));
    row.appendChild(pair);
    return row;
  }

  function switchRow(label, path, note) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var box = el('div', 'spin-pair');
    var cur = !!getPath(state.cfg, path);
    var btn = el('button', 'btn' + (cur ? ' primary' : ''), cur ? '已开启' : '已关闭');
    btn.onclick = function () {
      var next = !getPath(state.cfg, path);
      writeLocal(path, next);
      setCfg(path, next);
      btn.textContent = next ? '已开启' : '已关闭';
      btn.className = 'btn' + (next ? ' primary' : '');
      refreshFlag();
    };
    box.appendChild(btn);
    if (note) box.appendChild(el('span', 'hint', note));
    row.appendChild(box);
    return row;
  }

  function inputRow(label, path, placeholder, after) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var box = el('div', 'spin-pair');
    var input = el('input');
    input.type = 'text';
    input.value = getPath(state.cfg, path) === undefined ? '' : getPath(state.cfg, path);
    if (placeholder) input.placeholder = placeholder;
    input.onchange = function () {
      var v = after ? after(input.value) : input.value;
      writeLocal(path, v);
      setCfg(path, v);
    };
    box.appendChild(input);
    row.appendChild(box);
    return row;
  }

  function refreshFlag() {
    var on = getPath(state.cfg, 'dnd.enabled');
    var s = getPath(state.cfg, 'dnd.start');
    var e = getPath(state.cfg, 'dnd.end');
    if (!on) { dndFlag.textContent = '免打扰已关闭'; return; }
    var active = state.cfg.runtime && state.cfg.runtime.dndActive;
    dndFlag.textContent = '免打扰 ' + s + ' - ' + e + (active ? '（正在生效）' : '（当前不在时段内）');
  }

  /* ---------- 各页面 ---------- */
  var pages = {
    about: function () {
      var info = state.info || {};
      var box = el('div', 'kv');
      function kv(k, v) { box.appendChild(el('b', null, k)); box.appendChild(el('span', null, v)); }
      kv('名称', (info.app && info.app.name) || 'NoSense');
      kv('版本', (info.app && info.app.version) || '-');
      kv('定位', (info.app && info.app.description) || '');
      kv('适用系统', (info.app && info.app.platform) || 'Windows 10 1904+');
      kv('首次使用', info.firstInstallDate || '-');
      kv('使用天数', (info.daysUsed || 0) + ' 天');
      kv('启动次数', String(info.launches || 0));
      kv('本机已运行', info.uptimeText || '-');
      kv('当前时段', info.bandLabel ? (info.bandLabel + '（' + info.time + '）') : '-');
      kv('数据目录', info.dirs && info.dirs.root ? info.dirs.root : '-');
      kv('日志目录', info.dirs && info.dirs.log ? info.dirs.log : '-');
      content.appendChild(box);

      content.appendChild(el('h3', null, '信息层状态'));
      var src = el('div', 'kv');
      var k = info.knowledge || {};
      function line(name, label) {
        src.appendChild(el('b', null, label));
        var v = k[name];
        src.appendChild(el('span', null, v ? (v.label + '（' + new Date(v.at).toLocaleTimeString() + '）') : '尚未取得'));
      }
      line('quote', '名句');
      line('weather', '天气');
      line('hot', '热点');
      src.appendChild(el('b', null, '媒体'));
      src.appendChild(el('span', null, info.media ? (info.media.app + ' ' + info.media.title) : '未在播放'));
      src.appendChild(el('b', null, '通知中心'));
      src.appendChild(el('span', null, (info.notif && info.notif.ready ? ('只读抓取已接入：扫描 ' + info.notif.scanned + ' 条，其中 toast ' + info.notif.toasts + ' 条') : '尚未读取到通知库')));
      content.appendChild(src);

      var actions = el('div', 'row');
      var openDir = el('button', 'btn', '打开数据目录');
      openDir.onclick = function () { api.send('settings:invoke', { name: 'openDataDir' }); };
      var preview = el('button', 'btn primary', '预览一条问候');
      preview.onclick = function () { api.send('settings:invoke', { name: 'previewGreeting' }); };
      actions.appendChild(openDir); actions.appendChild(preview);
      content.appendChild(actions);
      content.appendChild(el('div', 'note', '说明：通知中心的“移除通知”需要 Windows 的 UserNotificationListener API，'
        + '本机 PowerShell 5.1 未提供该类型（已实测），因此 NoSense 采用只读方式抓取系统通知库，'
        + '并在竖条中替代呈现；时钟闹钟与自动播放类通知会被过滤呈现。'));
    },

    dnd: function () {
      content.appendChild(switchRow('启用免打扰', 'dnd.enabled'));
      content.appendChild(timeSpin('免打扰开始', 'dnd.start', '不推送通知'));
      content.appendChild(timeSpin('免打扰结束', 'dnd.end', '恢复推送'));
      var note = el('div', 'note');
      note.textContent = '时段内的系统事件不会推送；免打扰结束后补发最新一条。跨零点时段（如 22:30 - 07:30）同样有效。';
      content.appendChild(note);
      content.appendChild(el('h3', null, '推送内容'));
      content.appendChild(switchRow('天气摘要随问候推送', 'notify.weatherInGreet', ''));
      content.appendChild(inputRow('热点条数', 'notify.showHotCount', '5', function (v) {
        var n = parseInt(v, 10); return isNaN(n) ? 5 : Math.max(0, Math.min(10, n));
      }));
      content.appendChild(inputRow('自动收回(毫秒)', 'bar.autoCollapseMs', '0 = 不自动，如 8000', function (v) {
        var n = parseInt(v, 10); return isNaN(n) ? 0 : Math.max(0, n);
      }));
    },

    data: function () {
      content.appendChild(el('h3', null, '数据来源'));
      content.appendChild(inputRow('城市', 'weather.city'));
      content.appendChild(inputRow('纬度', 'weather.lat', '39.9042', function (v) { return parseFloat(v) || 39.9042; }));
      content.appendChild(inputRow('经度', 'weather.lon', '116.4074', function (v) { return parseFloat(v) || 116.4074; }));
      content.appendChild(inputRow('天气来源', 'weather.provider', 'auto / xiaomi / openmeteo'));
      content.appendChild(inputRow('小米天气 districtId', 'weather.districtId'));
      content.appendChild(inputRow('小米天气 key', 'weather.xiaomiKey', '留空则自动使用兜底源'));
      content.appendChild(inputRow('热点来源', 'hot.provider', 'auto / bing / baidu'));
      content.appendChild(switchRow('SMTC 媒体会话', 'sources.media'));
      content.appendChild(switchRow('通知中心抓取', 'sources.notifCenter'));
      content.appendChild(switchRow('文件变动监听', 'sources.fileWatch'));
      content.appendChild(switchRow('USB 插拔监听', 'sources.usb'));
      content.appendChild(switchRow('电池状态监听', 'sources.battery'));

      content.appendChild(el('h3', null, '外观'));
      content.appendChild(inputRow('字体', 'font.family', '等线'));
      content.appendChild(inputRow('正文字号(pt)', 'font.size', '12 = 小四', function (v) { return clampInt(v, 8, 30, 12); }));
      content.appendChild(inputRow('标题字号(pt)', 'font.titleSize', '18 = 小二', function (v) { return clampInt(v, 10, 36, 18); }));
      content.appendChild(inputRow('行高', 'font.lineHeight', '1.5', function (v) { return parseFloat(v) || 1.5; }));
      content.appendChild(inputRow('竖条宽度', 'bar.width', '8', function (v) { return clampInt(v, 4, 20, 8); }));
      content.appendChild(inputRow('竖条高度', 'bar.height', '128', function (v) { return clampInt(v, 60, 400, 128); }));
      content.appendChild(inputRow('展开宽度', 'bar.expandedWidth', '336', function (v) { return clampInt(v, 240, 520, 336); }));
      content.appendChild(inputRow('展开时长（毫秒）', 'bar.expandMs', '260', function (v) { return clampInt(v, 0, 1200, 260); }));
      content.appendChild(switchRow('总在最前', 'bar.alwaysOnTop'));
      var apply = el('button', 'btn primary', '应用尺寸并重新对齐');
      apply.onclick = function () { api.send('settings:invoke', { name: 'relayout' }); };
      content.appendChild(el('div', 'row')).appendChild(apply);
      content.appendChild(el('div', 'note', '刷新间隔：名句 ' + getPath(state.cfg, 'refresh.quoteHours') +
        ' 小时、天气/热点 ' + getPath(state.cfg, 'refresh.weatherMinutes') + ' 分钟。修改后立即生效。'));
    },

    logs: function () {
      var bar = el('div', 'row');
      var refresh = el('button', 'btn', '刷新');
      var clean = el('button', 'btn', '只看错误');
      var level = 'debug';
      refresh.onclick = function () { loadLogs(level); };
      clean.onclick = function () { level = level === 'debug' ? 'error' : 'debug'; clean.textContent = level === 'debug' ? '只看错误' : '显示全部'; loadLogs(level); };
      var open = el('button', 'btn', '打开日志目录');
      open.onclick = function () { api.send('settings:invoke', { name: 'openLogDir' }); };
      bar.appendChild(refresh); bar.appendChild(clean); bar.appendChild(open);
      content.appendChild(bar);
      var list = el('div');
      list.id = 'log-list';
      content.appendChild(list);
      loadLogs(level);
    }
  };

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function loadLogs(level) {
    api.invoke('settings:logs', { level: level || 'debug', limit: 120 }).then(function (rows) {
      var list = document.getElementById('log-list');
      if (!list) return;
      clear(list);
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        list.appendChild(el('div', 'logline ' + r.level, r.t + ' [' + r.level + '] ' + r.tag + ' · ' + r.msg));
      }
      if (!rows.length) list.appendChild(el('div', 'note', '暂无日志。'));
    });
  }

  function show(name) {
    if (name === 'quit') { api.send('settings:invoke', { name: 'quit' }); return; }
    if (name === 'restart') { api.send('settings:invoke', { name: 'restart' }); return; }
    page = name;
    var items = document.querySelectorAll('#menu .item');
    for (var i = 0; i < items.length; i++) {
      items[i].className = 'item' + (items[i].getAttribute('data-page') === name ? ' active' : '');
    }
    var titles = { about: '关于', dnd: '免打扰', data: '数据与外观', logs: '日志' };
    pageTitle.textContent = titles[name] || '设置';
    clear(content);
    pages[name]();
  }

  var menuItems = document.querySelectorAll('#menu .item');
  for (var i = 0; i < menuItems.length; i++) {
    (function (node) {
      node.onclick = function () { show(node.getAttribute('data-page')); };
    })(menuItems[i]);
  }
  document.getElementById('win-close').onclick = function () { api.send('settings:invoke', { name: 'closeSettings' }); };

  api.on('ui:cfg', function (cfg) {
    state.cfg = cfg || {};
    refreshFlag();
    if (page !== 'about') show(page);
  });

  api.on('ui:settings-refresh', function () { show(page); });
  api.on('ui:goto', function (name) { show(name); });

  api.invoke('settings:get').then(function (res) {
    state.cfg = res.cfg || {};
    state.info = res.info || {};
    document.getElementById('ver').textContent = 'v' + (state.info.app ? state.info.app.version : '0.1.0');
    refreshFlag();
    show('about');
  });

  api.send('settings:ready');
})();
