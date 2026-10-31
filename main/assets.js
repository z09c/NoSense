'use strict';

/**
 * 打包后 main 进程位于 app.asar 内，外部 powershell.exe 读不到 asar 里的 .ps1，
 * 因此启动时把资源脚本释放（并同步）到用户数据目录。
 */

var fs = require('fs');
var path = require('path');

function ensureExtracted(app, targetDir) {
  var srcDir = path.join(app.getAppPath(), 'resources', 'ps');
  fs.mkdirSync(targetDir, { recursive: true });
  var names;
  try {
    names = fs.readdirSync(srcDir);
  } catch (e) {
    return { dir: targetDir, error: '找不到内置脚本目录 ' + srcDir };
  }
  var copied = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!/\.ps1$/.test(name)) continue;
    var src = path.join(srcDir, name);
    var dst = path.join(targetDir, name);
    try {
      var data = fs.readFileSync(src);
      var needs = true;
      if (fs.existsSync(dst)) {
        try { needs = Buffer.compare(fs.readFileSync(dst), data) !== 0; } catch (e) { needs = true; }
      }
      if (needs) {
        fs.writeFileSync(dst, data);
        copied.push(name);
      }
    } catch (e) { /* keep existing copy */ }
  }
  return { dir: targetDir, copied: copied };
}

module.exports = { ensureExtracted: ensureExtracted };
