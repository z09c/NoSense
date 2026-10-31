'use strict';

/**
 * 渲染层窗口管理：
 *  - bar    右侧中间的小竖条（收起 = 细条，有消息时线性展开）
 *  - panel  天气 / 热点弹出面板
 *  - settings 设置窗口（左侧菜单）
 * 竖条展开采用逐帧线性改变窗口宽度（“消息动画线性展开”），
 * 右边缘与竖向中心保持锚定，避免跳动。
 */

var path = require('path');

var FILE_URL = function (rel) { return 'file://' + path.join(__dirname, '..', rel).replace(/\\/g, '/'); };

var MIN_BAR_WINDOW = 32;   // Chromium 对窗口宽度的硬下限，比这窄的竖条只能靠透明边距画

/** 可见竖条宽度 -> 窗口宽度与左右透明边距 */
function barGeom(visualWidth) {
  var v = Math.max(4, visualWidth || 8);
  var margin = Math.max(12, Math.ceil((MIN_BAR_WINDOW - v) / 2));
  return { windowWidth: v + margin * 2, margin: margin };
}

function anchorBounds(work, width, height, cfg, rightInset) {
  var gap = cfg.edgeGap === undefined ? 6 : cfg.edgeGap;
  var center = Math.round(work.y + work.height / 2);
  return {
    x: Math.round(work.x + work.width - width - gap + (rightInset || 0)),
    y: Math.round(center - height / 2),
    width: width,
    height: height
  };
}

function WM(opts) {
  this.electron = opts.electron;
  this.store = opts.store;
  this.log = opts.log;
  this.dev = !!opts.dev;
  this.bar = null;
  this.panel = null;
  this.settings = null;
  this.expanded = false;
  this.barWidth = 8;
  this.barWindowWidth = 32;
  this.barMargin = 12;
  this.barHeight = 128;
  this.anim = null;
  this.lastContentHeight = 0;
}

/** 渲染进程异常退出要有迹可循，否则界面只是“空白”很难排查 */
WM.prototype.watch = function (name, win) {
  var self = this;
  win.on('render-process-gone', function (event, details) {
    self.log.error('wm', name + ' 渲染进程退出: ' + (details ? details.reason + '/' + details.exitCode : '未知'));
    if (name === 'bar') self.bar = null;
    if (name === 'panel') self.panel = null;
    if (name === 'settings') self.settings = null;
  });
  win.on('unresponsive', function () { self.log.warn('wm', name + ' 无响应'); });
  win.on('did-fail-load', function (event, code, desc, url) {
    self.log.error('wm', name + ' 加载失败 ' + code + ' ' + desc + ' ' + url);
  });
  win.webContents.on('did-finish-load', function () { self.log.info('wm', name + ' 页面已加载'); });
  if (this.dev) {
    win.webContents.on('console-message', function (event, level, message, line, sourceId) {
      self.log.write(level >= 2 ? 'error' : 'debug', 'render:' + name,
        message + ' @' + String(sourceId || '').split('/').pop() + ':' + line);
    });
  }
};

/** 以竖条当前所在显示器为准（跟随鼠标会造成多屏时来回跳） */
WM.prototype.work = function () {
  var screen = this.electron.screen;
  var point;
  if (this.bar && !this.bar.isDestroyed()) {
    var b = this.bar.getBounds();
    point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  } else {
    point = screen.getCursorScreenPoint();
  }
  return screen.getDisplayNearestPoint(point).workArea;
};

/* ---------------- 竖条 ---------------- */

WM.prototype.createBar = function () {
  var self = this;
  var BrowserWindow = this.electron.BrowserWindow;
  var cfg = this.store.get('bar', {});
  this.barWidth = cfg.width || 8;
  var geom = barGeom(this.barWidth);
  this.barWindowWidth = geom.windowWidth;
  this.barMargin = geom.margin;
  this.barHeight = cfg.height || 128;
  var bounds = anchorBounds(this.work(), this.barWindowWidth, this.barHeight, cfg, this.barMargin);

  this.bar = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  this.bar.loadURL(FILE_URL('renderer/bar/index.html'));
  this.watch('bar', this.bar);
  this.bar.once('ready-to-show', function () { self.bar.show(); });
  if (this.dev) this.bar.webContents.openDevTools({ mode: 'detach' });
  this.bar.on('closed', function () { self.bar = null; });
  this.reposition();
  return this.bar;
};

WM.prototype.reposition = function () {
  if (!this.bar) return;
  var cfg = this.store.get('bar', {});
  var width = this.expanded ? (cfg.expandedWidth || 336) : this.barWindowWidth;
  var height = this.expanded ? Math.max(this.barHeight, this.lastContentHeight || this.barHeight) : this.barHeight;
  var inset = this.expanded ? 0 : this.barMargin;
  this.bar.setBounds(anchorBounds(this.work(), width, height, cfg, inset));
};

/** 线性展开：宽度从细条均匀增长到目标宽度 */
WM.prototype.expand = function (targetWidth, targetHeight, ms, onFrame, done) {
  var self = this;
  var cfg = this.store.get('bar', {});
  var work = this.work();
  var now = this.bar && !this.bar.isDestroyed() ? this.bar.getBounds() : { width: this.barWindowWidth, height: this.barHeight };
  var fromW = now.width;
  var fromH = now.height;
  var steps = Math.max(6, Math.round((ms || cfg.expandMs || 260) / 16));
  var i = 0;
  if (this.anim) clearInterval(this.anim);
  this.expanded = true;
  this.lastContentHeight = targetHeight || fromH;
  this.anim = setInterval(function () {
    i += 1;
    var ratio = i / steps;                       // 线性，不加成缓动曲线
    var w = Math.round(fromW + (targetWidth - fromW) * ratio);
    var h = Math.round(fromH + ((targetHeight || fromH) - fromH) * ratio);
    if (!self.bar || self.bar.isDestroyed()) { clearInterval(self.anim); self.anim = null; return; }
    self.bar.setBounds(anchorBounds(work, w, h, cfg));
    if (onFrame) onFrame(ratio);
    if (i >= steps) {
      clearInterval(self.anim);
      self.anim = null;
      if (done) done();
    }
  }, 16);
};

WM.prototype.collapse = function (done) {
  var self = this;
  var cfg = this.store.get('bar', {});
  var work = this.work();
  var fromW = this.bar ? this.bar.getBounds().width : this.barWidth;
  var fromH = this.bar ? this.bar.getBounds().height : this.barHeight;
  var steps = Math.max(5, Math.round((cfg.collapseMs || 180) / 16));
  var i = 0;
  if (this.anim) clearInterval(this.anim);
  this.expanded = false;
  this.anim = setInterval(function () {
    i += 1;
    var ratio = i / steps;
    var w = Math.round(fromW + (self.barWindowWidth - fromW) * ratio);
    var h = Math.round(fromH + (self.barHeight - fromH) * ratio);
    if (!self.bar || self.bar.isDestroyed()) { clearInterval(self.anim); self.anim = null; return; }
    // 收窄过程中同步把窗口右移，让可见竖条始终贴在同一条边
    self.bar.setBounds(anchorBounds(work, w, h, cfg, Math.round(self.barMargin * ratio)));
    if (i >= steps) {
      clearInterval(self.anim);
      self.anim = null;
      self.lastContentHeight = 0;
      self.sendBar('ui:mode', { mode: 'idle' });
      if (done) done();
    }
  }, 16);
};

WM.prototype.sendBar = function (channel, payload) {
  if (this.bar && !this.bar.isDestroyed()) this.bar.webContents.send(channel, payload);
};

/** 无消息时悬停/点击竖条 -> 临时展开一小块，弹出设置按钮 */
WM.prototype.hover = function (active) {
  if (!this.bar || this.bar.isDestroyed() || this.expanded) return;
  var cfg = this.store.get('bar', {});
  var work = this.work();
  if (active) {
    var w = cfg.hoverWidth || 156;
    var h = cfg.hoverHeight || 112;
    this.bar.setBounds(anchorBounds(work, w, h, cfg));
    this.sendBar('ui:mode', { mode: 'menu' });
  } else {
    this.bar.setBounds(anchorBounds(work, this.barWindowWidth, this.barHeight, cfg, this.barMargin));
    this.sendBar('ui:mode', { mode: 'idle' });
  }
};

WM.prototype.showPack = function (pack) {
  var self = this;
  var cfg = this.store.get('bar', {});
  if (!this.bar) return;
  var width = cfg.expandedWidth || 336;
  var height = estimateHeight(pack, width);
  pack.autoCollapseMs = Number(cfg.autoCollapseMs) || 0;
  this.sendBar('ui:pack', pack);
  if (this.expanded) {
    this.lastContentHeight = height;
    this.reposition();
    return;
  }
  this.expand(width, height, cfg.expandMs || 260, null, function () {
    self.lastContentHeight = height;
    self.reposition();
  });
};

/** 依据内容量估算展开高度，渲染层不需要回报尺寸 */
/** 按展开宽度估算换行：18pt 标题约 15 字/行，12pt 正文约 22 字/行 */
function estimateHeight(pack, width) {
  var per = Math.max(12, Math.floor(((width || 336) - 40) / 16));
  var h = 26;
  h += Math.ceil(Math.max(1, String(pack.title || '').length) / 15) * 34;
  var rows = pack.rows || [];
  for (var i = 0; i < rows.length; i++) {
    var text = String(rows[i].text || '');
    var cap = rows[i].tag ? per - 3 : per + 2;
    // 渲染层最多显示 3 行（热点行 2 行），高度按实际显示行数算
    var maxLines = rows[i].tag === '热点' ? 2 : 3;
    var lines = Math.min(maxLines, Math.max(1, Math.ceil(text.length / cap)));
    h += lines * 25 + 4;
  }
  h += (pack.actions || []).length ? 46 : 10;
  return Math.max(150, Math.min(480, h));
}

/** 配置变化时同步渲染层（字体、免打扰、竖条尺寸等） */
WM.prototype.broadcastCfg = function (cfg) {
  var view = JSON.parse(JSON.stringify(cfg || this.store.all()));
  view.runtime = { dndActive: this.store.inDnd(new Date()), barMargin: this.barMargin };
  this.sendBar('ui:cfg', view);
  this.sendSettings('ui:cfg', cfg);
  if (this.panel && !this.panel.isDestroyed()) this.panel.webContents.send('ui:cfg', cfg);
};

/* ---------------- 面板（天气 / 热点） ---------------- */

WM.prototype.openPanel = function (kind, data) {
  var self = this;
  var BrowserWindow = this.electron.BrowserWindow;
  var width = kind === 'hot' ? 400 : 420;
  var height = kind === 'hot' ? 520 : 560;
  var cfg = this.store.get('bar', {});
  var work = this.work();
  var gap = cfg.edgeGap === undefined ? 6 : cfg.edgeGap;

  if (!this.panel || this.panel.isDestroyed()) {
    this.panel = new BrowserWindow({
      width: width,
      height: height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    this.panel.on('closed', function () { self.panel = null; });
    this.panel.on('blur', function () { self.closePanel(); });
    this.panel.loadURL(FILE_URL('renderer/panel/index.html'));
    this.watch('panel', this.panel);
  }
  var x = Math.round(work.x + work.width - width - gap - (cfg.expandedWidth || 336) / 2);
  var y = Math.round(work.y + work.height / 2 - height / 2);
  this.panel.setBounds({ x: Math.max(work.x + 8, x), y: Math.max(work.y + 8, y), width: width, height: height });
  var push = function () {
    if (self.panel && !self.panel.isDestroyed()) {
      self.panel.webContents.send('ui:panel', { kind: kind, data: data });
      self.panel.show();
      self.panel.focus();
    }
  };
  if (this.panel.webContents.isLoading()) this.panel.webContents.once('did-finish-load', push);
  else push();
  return this.panel;
};

WM.prototype.closePanel = function () {
  if (this.panel && !this.panel.isDestroyed()) this.panel.hide();
};

/* ---------------- 设置 ---------------- */

WM.prototype.openSettings = function () {
  var self = this;
  var BrowserWindow = this.electron.BrowserWindow;
  if (this.settings && !this.settings.isDestroyed()) {
    this.settings.show();
    this.settings.focus();
    this.settings.webContents.send('ui:settings-refresh');
    return this.settings;
  }
  this.settings = new BrowserWindow({
    width: 780,
    height: 540,
    frame: false,
    transparent: false,
    resizable: true,
    minWidth: 660,
    minHeight: 460,
    show: false,
    skipTaskbar: false,
    backgroundColor: '#12151b',
    title: 'NoSense 设置',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  this.settings.loadURL(FILE_URL('renderer/settings/index.html'));
  this.settings.once('ready-to-show', function () { self.settings.show(); });
  this.settings.on('closed', function () { self.settings = null; });
  if (this.dev) this.settings.webContents.openDevTools({ mode: 'detach' });
  return this.settings;
};

WM.prototype.sendSettings = function (channel, payload) {
  if (this.settings && !this.settings.isDestroyed()) this.settings.webContents.send(channel, payload);
};

WM.prototype.setBarTop = function (onTop) {
  if (this.bar && !this.bar.isDestroyed()) this.bar.setAlwaysOnTop(!!onTop, 'screen-saver');
};

WM.prototype.destroyAll = function () {
  var wins = [this.bar, this.panel, this.settings];
  for (var i = 0; i < wins.length; i++) {
    if (wins[i] && !wins[i].isDestroyed()) {
      try { wins[i].destroy(); } catch (e) { /* ignore */ }
    }
  }
  this.bar = null;
  this.panel = null;
  this.settings = null;
};

module.exports = { WM: WM, anchorBounds: anchorBounds, barGeom: barGeom, MIN_BAR_WINDOW: MIN_BAR_WINDOW };
