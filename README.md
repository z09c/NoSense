# NoSense 无感助手

> 一条贴在屏幕边缘的竖条，把需要知道的事安静地送到手边。

它是一条贴在屏幕边缘的细竖条，平时几乎不存在，鼠标靠近时才展开成一张通知卡片。NoSense 把 Windows 上那些零散、吵闹、又确实有用的信息收拢到同一个地方：按时段送来的问候与叮嘱、天气和热搜、正在播放的音乐（可直接切歌、拖进度、调音量）、文件的新增、删除、改动与移动、刚打开的文档或程序、U 盘插拔、电量与开机时长，以及通知中心转来的消息。

它并不想让你多看屏幕。免打扰时段、按类别静默、伪媒体会话过滤（资源管理器、安全软件的「查杀任务」不会冒充「正在播放」）、移入文件夹与真删除的区分、以及真删除可一键还原，都是为了少打扰一点、少误会一点。竖条可以拖到左右任意一侧、上下任意位置，位置会记住；主题色、字体、毛玻璃质感、动画速度与画质档都能调，低性能设备会自动降级以保证流畅。

配置、缓存和日志全部留在本机，联网只用于拉取天气、热搜与名句。支持 Windows 10 1904 及以上，提供安装版与便携版，遵循 GPL-3.0 许可。

## 功能一览

- **时段问候**：上午／中午／下午／晚上／夜里自动切换，附名句、叮嘱、天气与热搜摘要；问候模板可在 `config.json` 里自行修改。
- **媒体播控**：基于 Windows SMTC，显示曲目、艺人、进度与音量，支持上一曲、播放暂停、下一曲、拖动进度；默认智能过滤非媒体会话，也可切换为「仅白名单」或「全部显示」。
- **文件与系统**：监听目录的新增、删除、改动、移动；跨目录移动会配对识别，真删除会核对回收站记录后才提供「撤销」；另有 U 盘插拔、电量、开机时长与系统唤醒提醒。
- **打开提示**：打开 `.txt`、`.exe`、`.doc`、`.ppt`、`.xls` 系列等文件时，提示文件名、位置与打开程序。
- **通知中心**：把 Windows 通知中心的消息接进同一张卡片。
- **不打扰**：免打扰时段（支持跨零点）、按类别静默、忽略按钮。
- **外观与性能**：可拖动停靠、左右侧与上下位置、主题色、字体字号、毛玻璃高光、画质档与动画速度；动画期间自动降级模糊与阴影，低画质设备跳过逐帧高光。

## 安装与使用

- 环境：Windows 10 1904 及以上（x64）、系统自带的 Windows PowerShell 5.1。
- 安装包：`release/` 下的 NSIS 安装版（可选安装目录、无需管理员权限）或便携版，双击即用。
- 启动后竖条默认贴右侧中部；鼠标移上去展开卡片与悬停菜单，从菜单进入「设置」。
- 按住竖条拖动可换到左侧或上／中／下位置，松开即吸附，位置重启后保留。
- 设置页分区：关于、免打扰、外观、数据来源、日志、重启软件、关闭软件。SMTC 会话过滤与打开文档提示都在「数据来源」里。

## 数据与隐私

- 配置、缓存、日志、撤销用的影子副本都在 `%APPDATA%\NoSense\nonsense\`：`config.json`、`meta.json`、`cache/`、`log/`、`ps/`、`shadow/`。
- 网络请求只用于 GET 拉取天气、热搜、名句／诗词等公开数据；文件内容、播放记录、通知内容只在本机处理，不会上报。
- 排障：设置页「日志」可查看运行日志；若出现启动后纯黑窗口，看 `log/` 下当天日志里的「渲染自检」行。

## 开发

```bash
npm install        # 安装 Electron 45 与 electron-builder
npm start          # 直接运行
npm run dev        # 带调试日志运行
npm run dist       # 打包，输出到 release/（NSIS 安装版 + 便携版，x64）
```

架构：**信息层**（`sensors/` + `sdk/`）→ **算法层**（`knowledge` / `composer` / `bus`）→ **渲染层**（`wm.js` + `renderer/`），`store` 与 `logger` 横切负责持久化。系统侧采集统一走一个常驻 PowerShell 进程（`resources/ps/worker.ps1`），以 JSON 行协议通信，避免每轮 spawn 的开销。渲染层通过 `preload/` 的 `contextBridge` 访问主进程能力。

```
main/
  main.js ipc.js wm.js undo.js assets.js
  state/     配置、元数据与日志
  algo/      knowledge / composer / bus
  sensors/   systemStatus / mediaSmtc / notifCenter / docOpen
  sdk/       weather / hotsearch / quote / poem / regions
  util/      psworker（PowerShell 行协议）/ net / fsx
preload/     contextBridge 安全桥
renderer/    bar / panel / settings + 主题与图标
resources/   fonts / ps/worker.ps1 / regions.json
tools/       图标与地区数据生成脚本
build/       安装包图标
```

打包提示：

- `resources/fonts/**`、`resources/ps/**`、`resources/regions.json` 必须解包（已在 `package.json` 的 `asarUnpack` 配好），否则 PowerShell 脚本和字体无法从 asar 内读取；页面一律用 `loadFile` 加载，不要拼 `file://` 路径。
- 构建使用本地 Electron（`electronDist` 指向 `node_modules/electron/dist`），先完成 `npm install` 再执行 `npm run dist`。
- 修改 `worker.ps1` 后，已安装的旧版本需要重启应用，让资源释放逻辑把新脚本重新写入用户数据目录。

## 许可

GPL-3.0-or-later，详见 [LICENSE](LICENSE)。随附字体的许可见 `resources/fonts/` 下的 LICENSE / NOTICE 文件。

