# 东方摩耶堂 · Moyetang

> 一个**只给自己用**的本地笔记软件。电脑（Windows）+ 安卓，数据全部是本地文件，**不登录、不联网、不上云**。
>
> A personal, local-first note-taking app for Windows + Android. Plain files on disk, no account, no cloud, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![React](https://img.shields.io/badge/React-19-61DAFB)

<p align="center">
  <img src="public/logo-day.png" width="120" alt="logo">
</p>

---

## 这是什么 / What is this

一开始只是想"有个地方写东西"，后来长成了一个小而全的个人工作台：

- **认知区**：文本笔记（Markdown + 编辑辅助栏）＋ **树状图笔记**（自绘 SVG 画布，能加子级/同级、拖节点改层级、节点挂图）
- **信息区**：抬手就记的碎片（截图/图片）、分类、45 分钟未推进提醒、一键**联动**成笔记或待办
- **执行区**：待办集 ＋ 四象限 ＋ 番茄钟（暂停/中断/结算二次确认）、重复待办、子任务
- **日程**：月视图 ＋ 一周七列 ＋ 当天日报（手写小结入 `dailies/`）、倒计时
- **技能区**：奖状（带图/寄语/整页详情）、格言（每日一句）
- **档案库**：把笔记/信息收进档案，条目与笔记文件双向可还原
- **局域网同步**：电脑当服务端，手机扫码/短码配对；同一条按 `updatedAt` 取新，图片按"只增不删的并集"传
- **桌面端**：托盘（6:00/18:00 换图标）、`Ctrl+Space` 速记小窗、置顶挂件、`.md` 打开方式、整包备份/导出

> 它不是"给所有人用的产品"：没有账号体系、没有多端漫游、没有插件生态。
> 设计目标只有一条 —— **我自己的数据，放在我自己的磁盘上，随时能拿走**。

## 界面 / Screenshots

> 截图区暂时留空：本仓库**不放作者本人真实笔记的截图**（会泄露私人内容）。
> 想看界面就按下面「本地跑起来」启动；主题是 7 套配色 + 深色，全部 Tailwind 变量。

| 桌面 | 手机 |
|---|---|
| （待补：用空白数据另拍一套） | （待补） |

## 技术栈 / Stack

| 层 | 用了什么 |
|---|---|
| 壳 | **Tauri 2**（Windows / Android 共用同一套 Rust 核心） |
| 前端 | **React 19 + TypeScript + Vite 8 + Tailwind CSS 4 + Zustand**，编辑器 **CodeMirror 6** |
| 后端 | **Rust**：`store/*` 每个数据文件一套（**原子写 + `.bak`**）、`sync_*`（合并规则与落地分离）、托盘 / 通知 / 全局快捷键 |
| 存储 | 纯文件：`notes/*.json`、`todos.json`、`info.jsonl`、`assets/`、`backups/`（见下） |
| 测试 | 自用验收套件（PowerShell + CDP **真实输入**），`tools/m*/run.ps1` |

## 本地跑起来 / Getting started

### 前置

- **Windows 10/11**（只在这上面认真跑过）
- **Node 20+**、**Rust stable**（含 `cargo`）
- 打安卓包才需要：**Android SDK + NDK 26**；`CARGO_TARGET_DIR` 必须是**英文路径**（中文路径会让链接崩）

### 桌面（开发）

```powershell
npm install
npm run tauri dev
```

### 桌面（出包）

```powershell
npm run tauri build -- --bundles nsis
# 产物：src-tauri/target/release/notes-app.exe
#       src-tauri/target/release/bundle/nsis/东方摩耶堂_<版本>_x64-setup.exe
```

> ⚠️ 出包必须走 `tauri build`，**别**直接用 `cargo build`（前端资源不会被打进去，会白屏）。

### 安卓（APK）

```powershell
npx tauri android init                       # 第一次
npx tauri android build --apk --target aarch64
# 产物：src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

**签名**：仓库里**不含任何密钥**。自用侧载时 `app/build.gradle.kts` 的 release 复用 Android 工具链的 **debug keystore**（`~/.android/debug.keystore`）——能覆盖安装，但**不能**用于应用商店。要正式签名就自己 `keytool -genkeypair`，改 `signingConfig`，并**备份好那把钥匙**（丢了就永远不能升级同一个包）。

**数据目录**：Windows 默认 `D:\东方摩耶堂`；**作者机器上这个老路径存在时会继续用它**（升级不搬家）。换目录：

```powershell
$env:MOYETANG_DATA_DIR = "D:\my-notes"
```

新用户没有老路径时，默认落在 `%USERPROFILE%\Documents\东方摩耶堂`。

## 目录结构 / Layout

```
src/                    前端
  pages/                七个区 + 小窗 / 专注窗 / 挂件
  features/             notes tree todos schedule skills sync countdown …
  mobile/               手机版外壳与八个区（按真机 393×873）
  store/               data.ts（数据与动作）· ui.ts（视图/主题/Toast）
  components/          AssetImage（图不在出占位）· FloatingMenu …
src-tauri/              Rust 后端
  src/commands.rs      所有 #[tauri::command]（在 lib.rs 注册）
  src/store/           note tree todo info reminder archive awards mottos daily
                       countdown annotations assets backup safety atomic
                       sync_merge（纯规则）· sync_apply（落地）· sync_proto / sync_server
  src/                 window tray scheduler focus shortcuts marker models
  gen/android/         安卓工程（不含构建产物与 jniLibs）
tools/                 自用验收套件（m4 树 / m5 执行区 / m15 档案 / m19 手机 …）+ cdp.ps1
docs/                  设计文档 + 两份使用说明
```

## 数据在哪 / Data

| 路径 | 内容 |
|---|---|
| `notes/<id>.json` | 笔记（`doc` 文本 / `tree` 树） |
| `notes/_trash/` · `notes/_archive/` | 删除的（留后路，不硬删）· 收进档案的 |
| `todos.json` · `info.jsonl` · `reminders.json` | 待办 / 信息 / 提醒 |
| `awards.json` · `mottos.json` · `archive.json` · `countdowns.json` · `annotations.json` | 奖状 / 格言 / 档案 / 倒计时 / 批注 |
| `assets/` | 图片（uuid 文件名，**原图永不删**） |
| `backups/` | 删除留档、同步前快照、导入前备份 |
| `config.json` | 设置 |

写文件一律「**原子写 + `.bak`**」；**删除笔记 = 挪进 `_trash/`**，不是硬删。

## 已知限制 / Known limitations

- **自用为主**：没有账号、没有云端多端同步（只在同一 WiFi 下手动同步）；界面文案以中文为主。
- **Windows 优先**：macOS / Linux 没测过；安卓是"能日常用"的程度，不是商店级。
- **release APK 用 debug 签名**（自用侧载）；上架必须换自己的 keystore，且**换了就覆盖不了旧包**。
- **技能树没做**（入口已删）；信息/格言/档案/倒计时的"删除"不跨端，只有奖状支持删除跨端。
- 验收脚本依赖 **CDP + 9222 端口**与作者的数据目录约定，开箱不能直接跑全套（见 `tools/` 注释）。

## 文档 / Docs

- [`docs/手机版使用说明.md`](docs/手机版使用说明.md) —— 装包、同 WiFi 同步、导出换机、文件关联
- [`docs/电脑版使用说明.md`](docs/电脑版使用说明.md) —— 装法、数据在哪、窗口/托盘、同步、备份、排错
- [`docs/M4-树状图画布方案.md`](docs/M4-树状图画布方案.md) —— 树画布的设计与实现记录

## License

[MIT](LICENSE) © 2026 moyetang
