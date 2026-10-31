/* 渲染层：竖条交互与消息卡片渲染（由主进程发来的 pack 驱动，含字体字号） */
(function () {
  'use strict';

  var api = window.noSense;
  if (!api) return;

  var els = {
    band: document.getElementById('band'),
    title: document.getElementById('title'),
    stamp: document.getElementById('stamp'),
    rows: document.getElementById('rows'),
    actions: document.getElementById('actions'),
    chip: document.getElementById('chip'),
    mBand: document.getElementById('m-band'),
    mTime: document.getElementById('m-time'),
    mSettings: document.getElementById('m-settings')
  };

  var current = null;
  var mode = 'idle';
  var hideTimer = null;
  var hovering = false;

  var ROW_CLASS = { 一言: 'quote', 天气: 'weather', 热点: 'hot', 叮嘱: 'care' };

  function setMode(next) {
    mode = next;
    document.body.setAttribute('data-mode', next);
    if (next !== 'menu') els.chip.classList.remove('show');
  }

  /** 字号单位由主进程给出（pt：小二=18pt 标题、小四=12pt 正文） */
  function applyFont(font) {
    if (!font) return;
    var unit = font.unit || 'px';
    document.documentElement.style.fontFamily =
      '"' + font.family + '", "DengXian", "Microsoft YaHei UI", sans-serif';
    els.title.style.fontSize = font.titleSize + unit;
    els.title.style.fontWeight = font.titleWeight || '700';
    els.rows.style.fontSize = font.size + unit;
    els.rows.style.lineHeight = font.lineHeight;
  }

  function render(pack) {
    current = pack;
    applyFont(pack.font);
    els.band.textContent = pack.bandLabel || '提示';
    els.band.className = pack.tone === 'warn' ? 'warn' : '';
    els.title.textContent = pack.title || 'NoSense';
    els.stamp.textContent = pack.time + ' · ' + pack.date;

    while (els.rows.firstChild) els.rows.removeChild(els.rows.firstChild);
    var rows = pack.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var row = document.createElement('div');
      row.className = 'line' + (ROW_CLASS[rows[i].tag] ? ' ' + ROW_CLASS[rows[i].tag] : '');
      if (rows[i].tag) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = rows[i].tag;
        row.appendChild(tag);
      }
      var txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = rows[i].text;
      row.appendChild(txt);
      els.rows.appendChild(row);
    }

    while (els.actions.firstChild) els.actions.removeChild(els.actions.firstChild);
    var acts = pack.actions || [];
    for (var j = 0; j < acts.length; j++) els.actions.appendChild(makeButton(acts[j]));

    setMode('msg');
    clearTimeout(hideTimer);
    if (pack.autoCollapseMs) hideTimer = setTimeout(function () { act('no'); }, pack.autoCollapseMs);
  }

  function makeButton(action) {
    var btn = document.createElement('button');
    btn.className = 'btn' + (action.key === 'ok' ? ' primary' : (action.key === 'no' ? ' ghost' : ''));
    btn.textContent = action.label;
    btn.setAttribute('data-key', action.key);
    btn.onclick = function () { act(action.key); };
    return btn;
  }

  function act(key) {
    if (!current) return;
    api.send('bar:action', { id: current.id, key: key });
  }

  api.on('ui:pack', render);
  api.on('ui:mode', function (msg) {
    setMode(msg.mode);
    if (msg.mode !== 'menu') { hovering = false; els.chip.classList.remove('show'); }
  });
  api.on('ui:cfg', function (cfg) {
    if (cfg && cfg.font) applyFont(cfg.font);
    document.body.setAttribute('data-dnd', cfg && cfg.runtime && cfg.runtime.dndActive ? '1' : '0');
    if (cfg && cfg.runtime && cfg.runtime.barMargin) {
      barMargin = cfg.runtime.barMargin;
      document.documentElement.style.setProperty('--bar-margin', barMargin + 'px');
    }
  });
  api.on('ui:menu', function (info) {
    els.mBand.textContent = info.bandLabel || '--';
    els.mTime.textContent = info.time || '--:--';
  });

  // 悬停/点击竖条：无消息时弹出设置按钮
  // 注意 mouseenter/mouseleave 只在元素上触发，绑到 window 永远不会响
  var barMargin = 12;

  /** 窗口比可见竖条宽（左右是透明边距），只有落在竖条上才算悬停 */
  function onStrip(e) {
    if (mode !== 'idle') return true;
    if (!e || typeof e.clientX !== 'number') return true;
    return e.clientX >= barMargin && e.clientX <= window.innerWidth - barMargin;
  }

  function hoverIn(e) {
    if (mode === 'msg' || hovering || !onStrip(e)) return;
    hovering = true;
    api.send('bar:hover', true);
    els.chip.classList.add('show');
  }
  function hoverOut() {
    if (mode === 'msg' || !hovering) return;
    hovering = false;
    api.send('bar:hover', false);
    els.chip.classList.remove('show');
  }
  var root = document.documentElement;
  root.addEventListener('mouseenter', hoverIn);
  root.addEventListener('mousemove', hoverIn);
  root.addEventListener('mouseleave', hoverOut);
  document.addEventListener('mouseleave', hoverOut);
  window.addEventListener('blur', hoverOut);
  root.addEventListener('mousedown', function (e) {
    if (mode !== 'msg' && onStrip(e)) api.send('bar:click');
  });
  els.chip.onclick = function () { api.send('bar:open-settings'); };
  els.mSettings.onclick = function () { api.send('bar:open-settings'); };
  window.addEventListener('click', function (e) {
    var key = e.target && e.target.getAttribute && e.target.getAttribute('data-key');
    if (key) act(key);
  });

  api.send('bar:ready');
})();
