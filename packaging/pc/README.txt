DHVW · ARM 设备端 · PC 测试包（a 测用，不涉及 ARM 真机）
============================================================

版本 {{VERSION}} · 构建于 {{BUILD_AT}}
资源包 {{PACK_FILES}} 个文件 · 场景 {{SCENES}}

这个包把设备端页面（arm/www）和本机静态壳打包在一起，任何 x64/arm64 PC 都能直接跑，
不需要 Node / Go / Python，也不需要 PC 主机在线。

快速开始
--------
Windows：双击 start-windows.bat
         （端口被占用时可传参：start-windows.bat 18081）
         也可以在命令行里跑，能直接看到报错：
           cd /d 本目录
           start-windows.bat 18080
Linux：  sh start-unix.sh [端口]
macOS：  sh start-unix.sh [端口]
         （首次打开若被 Gatekeeper 拦，执行：
          xattr -dr com.apple.quarantine . ）

启动后浏览器打开 http://127.0.0.1:18080/
  · 总观：      /
  · 巡演页：    /tour.html
  · 单图预览：  /preview.html?scene=<{{SCENES}}>
  · 健康检查：  /__health

包内容
------
www/                                  资源包（{{PACK_FILES}} 个文件，manifest 已校验）
{{SCENE_TREE}}
  assets/char/ojj_sheet.*             默认角色：大肥鱼鲸鱼娘
  assets/char/looks/whale.*           同上（巡演资源目录）
  assets/char/looks/atri|miku.*       旧宣传片换装备份，默认不加载
dhvw-shell-windows-amd64.exe          Windows x64 壳
dhvw-shell-linux-amd64                Linux x64 壳
dhvw-shell-darwin-amd64 / -arm64      macOS Intel / Apple Silicon 壳
qq-openclaw/                          可选 QQ / 飞书网关（壳按需拉起）
node/node.exe                         Windows 版 Node（随包，免安装；仅网关用）
start-windows.bat / start-unix.sh     启动器

默认内容
--------
· 地图：全部功能区随包；indoor-66500 是 cafe 的同图副本（历史包，不进巡演）。
· 总观默认角色：鲸鱼娘（assets/char/ojj_sheet.*，与 whale.* 同一张图集）。
· 巡演默认：依次走 {{TOUR_SCENES}}，全程鲸鱼娘。
  需要旧宣传片的逐场景换装，手动打开：
  /tour.html?looks=whale,atri,miku
· QQ Bot 默认关闭；在调试台打开后由壳用随包的 node/ 拉起 qq-openclaw，无需另装 Node。

运行方式
--------
· 默认纯离线：主机不可达时保持「世界·本地」，总观照常渲染、生活照常推进。
· 可选连接 PC 编排器（与本机 PC 外壳一起用时）：
  dhvw-shell-windows-amd64.exe -dev -addr 127.0.0.1:18080 -pair-addr "" -root www ^
    -default-ws ws://127.0.0.1:8877/dhvw
  或在 PC 外壳里用「设备配对 → 本机浏览器测试」打开 ARM 预览页。
· 启动器带 -dev（静态资源 no-cache），换包后刷新即可，不会吃到旧 assets 缓存。
· 启动器关掉局域网配对口（-pair-addr ""），不会弹 Windows 防火墙；要配对真机时再开。

环境要求与限制
--------------
· 浏览器：Chrome / Edge / Firefox 现代版本（用到 module Worker、IndexedDB、
  OffscreenCanvas、MediaRecorder；IE/旧 Safari 不支持）。
· start-windows.bat 是纯 ASCII + CRLF：cmd.exe 按 OEM 代码页（简中 GBK）解析批处理，
  UTF-8 中文注释会让整行错位，报出「'xxx' 不是内部或外部命令」之类乱码错误。
  要改这个 bat 请保持 ASCII 内容与 CRLF 换行（构建脚本会自动转 CRLF）。
· 显现模式仍是静态立绘占位：Live2D 资源尚未交付（A10 降级路径）。
· 页面数据存在浏览器 IndexedDB；壳的 data/ 目录在包目录下生成。删掉 data/ 与
  浏览器站点数据即可回到第 1 天 08:00。
· Windows 首次运行可能弹 SmartScreen（未签名）：更多信息 → 仍要运行。
· macOS 二进制未签名，见上方 quarantine 处理。

构建与校验
----------
随包 node：包内 node/node.exe 来自构建机的 dist/node-cache/node.exe（Windows 版 Node 24）。
壳的 findNode() 优先用它（/__health 的 gateway.nodeSource 显示 bundled），目标机无需预装 Node；
包内没有 node/ 时会回退系统 PATH（nodeSource=system），两者都没有则 gateway.available=false。

本包由 arm 仓库的 `npm run release:pc` 生成，步骤：场景包清单 → 资源包 manifest →
manifest 校验 → 场景包结构校验 → 交叉编译 → 复制 www / qq-openclaw / node → 打包压缩。
手工复核可用包内壳直接自检：`dhvw-shell-windows-amd64.exe -addr 127.0.0.1:18080 -root www`
然后看 `/__health` 的 `pack.missing / size_bad / hash_bad` 是否全为空。
