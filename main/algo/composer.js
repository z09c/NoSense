'use strict';

/**
 * 算法层 B：合成语句并把结果打包成渲染层可直接消费的结构
 * （含字体、字号、行高、按钮定义）。
 *
 * 时段问候模板来自配置 store.templates（已预装，后期可继续填充）。
 */


var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

var BANDS = [
  { key: 'night', label: '夜里', hours: [0, 1, 2, 3, 4], opener: '夜深了' },
  { key: 'morning', label: '上午', hours: [5, 6, 7, 8, 9, 10], opener: '上午好' },
  { key: 'noon', label: '中午', hours: [11, 12], opener: '中午好' },
  { key: 'afternoon', label: '下午', hours: [13, 14, 15, 16, 17], opener: '下午好' },
  { key: 'evening', label: '晚上', hours: [18, 19, 20, 21, 22], opener: '晚上好' },
  { key: 'night', label: '夜里', hours: [23], opener: '夜深了' }
];

function bandOf(date) {
  var h = date.getHours();
  for (var i = 0; i < BANDS.length; i++) {
    if (BANDS[i].hours.indexOf(h) >= 0) return BANDS[i];
  }
  return BANDS[1];
}

function two(n) { return n < 10 ? '0' + n : '' + n; }

function timeText(date) { return two(date.getHours()) + ':' + two(date.getMinutes()); }

function dateText(date) {
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + WEEK[date.getDay()];
}

var KIND_TAG = {
  file: '文件', usb: 'USB', battery: '电池', media: '媒体',
  notif: '通知', clock: '时间', uptime: '运行', system: '系统'
};

function Composer(store, knowledge) {
  this.store = store;
  this.knowledge = knowledge;
  this._seq = 0;
}

Composer.prototype._template = function (bandKey) {
  var set = this.store.get('templates.' + bandKey);
  if (!set || !set.greeting || !set.greeting.length) set = this.store.get('templates.fallback');
  var list = (set && set.greeting) || ['你好，现在是 {time}。'];
  var pick = function (arr) {
    return arr.length ? String(arr[Math.floor(Math.random() * arr.length)]) : '';
  };
  return {
    greeting: pick(list),
    care: pick((set && set.care) || [])
  };
};

Composer.prototype._fill = function (tpl, vars) {
  var out = tpl;
  for (var key in vars) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) continue;
    out = out.split('{' + key + '}').join(vars[key] === undefined ? '' : String(vars[key]));
  }
  return out;
};

Composer.prototype._font = function () {
  return {
    family: this.store.get('font.family', '等线'),
    size: Number(this.store.get('font.size', 12)),
    titleSize: Number(this.store.get('font.titleSize', 18)),
    lineHeight: Number(this.store.get('font.lineHeight', 1.5)),
    unit: this.store.get('font.unit', 'pt'),
    titleWeight: '700'
  };
};

Composer.prototype._pack = function (fields, date) {
  var d = date || new Date();
  var band = bandOf(d);
  this._seq += 1;
  var pack = {
    id: 'n' + d.getTime() + '-' + this._seq,
    kind: fields.kind || 'greet',
    tone: fields.tone || 'normal',
    band: band.key,
    bandLabel: band.label,
    time: timeText(d),
    date: dateText(d),
    title: fields.title || band.opener,
    rows: fields.rows || [],
    font: this._font(),
    actions: fields.actions || [],
    payload: fields.payload || null,
    sticky: !!fields.sticky,
    createdAt: d.getTime()
  };
  return pack;
};

/** 时段问候：上午好，现在是 10:32 + 今日名句 + 问候语，并附带天气/热点摘要 */
Composer.prototype.greeting = function (date) {
  var d = date || new Date();
  var band = bandOf(d);
  var quote = this.knowledge.quoteString();
  var greeting = this._fill(this._template(band.key).greeting, {
    time: timeText(d),
    date: dateText(d)
  });
  var care = this._fill(this._template(band.key).care || '', {
    time: timeText(d),
    date: dateText(d)
  });
  var weather = this.store.get('notify.weatherInGreet', true) ? this.knowledge.weatherString() : '';
  var hot = this.knowledge.hotString(this.store.get('notify.showHotCount', 5));
  var rows = [{ tag: '问候', text: greeting }];
  if (quote) rows.push({ tag: '一言', text: quote });
  if (care) rows.push({ tag: '叮嘱', text: care });
  if (weather) rows.push({ tag: '天气', text: weather });
  if (hot) rows.push({ tag: '热点', text: hot });
  return this._pack({
    kind: 'greet',
    title: band.opener,
    rows: rows,
    actions: [
      { key: 'weather', label: '天气' },
      { key: 'hot', label: '热点' },
      { key: 'no', label: '不要' },
      { key: 'ok', label: '好' }
    ]
  }, d);
};

/** 传感器事件 -> 通知包（默认动作只有 好 / 不要） */
Composer.prototype.fromEvent = function (ev) {
  var actions = [{ key: 'no', label: '不要' }, { key: 'ok', label: '好' }];
  if (ev.kind === 'notif' && ev.payload && ev.payload.hasLink) {
    actions.unshift({ key: 'open', label: '打开' });
  }
  var rows = [{ tag: KIND_TAG[ev.kind] || '消息', text: ev.body || '' }];
  var extra = ev.lines || [];
  for (var i = 0; i < extra.length; i++) rows.push({ tag: '', text: String(extra[i]) });
  return this._pack({
    kind: ev.kind,
    tone: ev.tone || 'normal',
    title: ev.title,
    rows: rows,
    actions: actions,
    payload: ev.payload || null,
    sticky: !!ev.sticky
  }, ev.date || new Date());
};

/** 供设置界面/调试预览使用 */
Composer.prototype.preview = function (kind, date) {
  if (kind === 'greet') return this.greeting(date);
  return this.fromEvent({
    kind: 'battery', title: '电池提醒', body: '电量剩余 20%，建议接通电源。',
    tone: 'warn', lines: ['（这是预览消息）'], date: date
  });
};

Composer.prototype.bandOf = function (date) { return bandOf(date || new Date()); };
Composer.prototype.timeText = timeText;
Composer.prototype.dateText = dateText;

module.exports = { Composer: Composer, bandOf: bandOf, WEEK: WEEK };
