<p align="center">
  <img src="lib/assets/brand.svg" alt="dsh-reel logo" width="128" height="128" />
</p>

<h1 align="center">dsh-reel</h1>

<p align="center">
  <strong>专为 dsh Web 打造的现代化流媒体库与沉浸式画廊插件</strong>
</p>

<p align="center">
  本地多媒体目录聚合 · HTTP Range 流式秒播 · 服务端边转边播 · 动态全屏壁纸 · 触控手势连播
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <a href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1"><img src="https://img.shields.io/badge/dsh-%3E%3D_v0.1.5--rc.1-0066FF?style=for-the-badge" alt="dsh >= v0.1.5-rc.1" /></a>
  <img src="https://img.shields.io/badge/Cordis-Plugin-18B26B?style=for-the-badge" alt="Cordis" />
  <img src="https://img.shields.io/badge/FFmpeg-Included-007808?style=for-the-badge&logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/lsjspl/dsh-reel?style=flat-square&color=ffd33d&logo=github" alt="Stars" />
  <img src="https://img.shields.io/github/forks/lsjspl/dsh-reel?style=flat-square&color=8957e5&logo=github" alt="Forks" />
  <img src="https://img.shields.io/github/last-commit/lsjspl/dsh-reel?style=flat-square&color=3fb950" alt="Last commit" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" />
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

---

<p align="center">
  <img src="doc/screenshot/home.png" alt="dsh-reel 媒体库主界面" width="960" />
</p>

## 简介

**dsh-reel** 为 [dsh Web](https://github.com/deepseek-ai)（要求 dsh 最低版本为 [v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)）提供了一站式的媒体库浏览与沉浸式影音播放体验。无需启动独立的流媒体服务或新端口，只需一条命令挂载多个本地磁盘目录，即可立即在浏览器中畅享高性能的图片画廊与流媒体播放器。

项目地址与快速访问：
```
http://127.0.0.1:3080/reel
```

---

## 核心特性

- **零额外进程，轻量内嵌**：与 dsh Web 同端口、同 origin；宿主侧仅新增一行 Cordis 组合配置与 `/reel` 前缀下的只读路由，不启动新守护进程，无需额外打包构建步骤。
- **严格安全沙箱**：对本地媒体目录严格只读；所有目录枚举与文件读取均限制在白名单根路径内，杜绝路径穿越风险。
- **多目录聚合 & 多维视图**：
  - 顶层「库」智能聚合所有已挂载的磁盘目录，层级按需惰性加载。
  - **当前**、**全部**（递归平铺）、**分组**（按目录折叠）三种浏览模式随心切换。
  - 网格布局（小 / 中 / 大三档尺寸自适应）与紧凑列表视图。
- **HTTP Range 流式秒开**：视频原生采用 HTTP Range 响应流式分发，任意拖拽进度条即时起播，不阻塞带宽。
- **服务端边转边播**：对于 AVI、WMV、FLV、RMVB 等浏览器无法原生解码的老旧容器，服务端由 ffmpeg 实时转封装为 fragmented MP4 边转边发，内存管道直出，零磁盘临时占用；拖动进度条自动从目标时间重新建立流。
- **悬停预览与精准帧截取**：进度条悬停即时展示缩略图预览与时间戳；内置 FFmpeg / FFprobe 支持，自动提取视频时长、分辨率与高质量封面海报。
- **沉浸式全屏动态壁纸**：
  - 任意图片或视频一键设为全站全局动态壁纸（视频静音循环，失焦自动暂停节能）。
  - 全屏半透明毛玻璃质感 UI 交互，视觉体验拉满。
- **触控手势连播 & 移动端全适配**：
  - 手机端与窄屏自适应布局，支持上下滑动切换上一条 / 下一条（类似 Reels / 抖音短视频跟手滑动交互）。
  - 支持顺序连播、随机洗牌播放、播放位置记忆、长按 2× 快进、外挂同名字幕自动加载与当前帧截图导出。
- **dsh 原生可视化设置**：完全集成于 dsh 设置面板，增删媒体目录、设定缓存与壁纸热更新即刻生效。

---

## 界面预览

### 沉浸式动态壁纸模式
将喜欢的视频或图片一键设为全站背景，界面组件自动转为通透的毛玻璃半透明层：
<p align="center">
  <img src="doc/screenshot/home2.png" alt="沉浸式全屏动态壁纸" width="960" />
</p>

### 专业级视频播放器
页内全屏播放器，支持进度条悬停缩略图、元数据探查、倍速切换、截图与循环连播：
<p align="center">
  <img src="doc/screenshot/play1.png" alt="专业级全功能视频播放器" width="960" />
</p>

### 竖屏视频与移动端短视频连播
无论是在桌面端还是移动设备，竖屏视频均自适应居中或铺满，支持滑动手势畅快刷剧：
<p align="center">
  <img src="doc/screenshot/play2.png" alt="竖屏视频氛围光播放" width="580" />
  &nbsp;&nbsp;
  <img src="doc/screenshot/play3.png" alt="移动端触控滑动连播" width="340" />
</p>

### 移动端响应式画廊
针对手机触控优化，单列自适应卡片与手势放大浏览：
<p align="center">
  <img src="doc/screenshot/home1.png" alt="移动端自适应网格列表" width="460" />
</p>

### dsh 设置中心原生集成
在 dsh 设置中轻松配置媒体目录、指定缓存位置并管理全局壁纸：
<p align="center">
  <img src="doc/screenshot/setting.png" alt="dsh 原生设置面板" width="800" />
</p>

---

## 安装指南

### 前置要求

- **dsh**：要求最低版本为 [v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) 及以上
- **Node.js**：`>= 20`

### 标准安装

在 dsh 运行环境下，执行以下命令安装插件：

```powershell
dsh plugin --profile web add dsh-reel
```

重启 `dsh web`，在浏览器打开：
```
http://127.0.0.1:3080/reel
```

### 安装未发布版本 / 源码本地开发

```powershell
# 从 GitHub 仓库直接安装最新开发版
dsh plugin --profile web add "github:lsjspl/dsh-reel"

# 本地源码调试软链模式（修改代码后直接刷新页面生效）
dsh plugin --profile web add "link:C:\path\to\dsh-reel"
```

### 卸载插件

```powershell
dsh plugin --profile web remove dsh-reel
```

---

## 配置说明

配置存储在 `settings.yaml` 的 `reel` 命名空间下。修改后热生效，无需重启服务。

### 方式一：可视化界面配置（推荐）

打开 **dsh 设置 → 插件 → 插件配置 → Reel 媒体浏览**：
- **媒体目录**：点击「添加目录」添加多个本地文件夹（如 `D:\Photos`、`E:\Videos`）。
- **缓存目录**：指定视频封面帧与悬停预览的缓存磁盘位置。
- **全屏壁纸**：配置全站默认壁纸（可填文件绝对路径或库相对 key）。

### 方式二：配置文件 / `cordis.patch.yml`

在 profile 的 `cordis.patch.yml` 或 `settings.yaml` 中声明：

```yaml
- id: reel
  config:
    roots:
      - D:\Photos
      - E:\电影
    # cacheDir: 'D:\dsh-cache'              # 缩略图与悬停动画缓存目录，留空使用系统临时目录
    # wallpaper: 'D:\Photos\wallpaper.jpg'  # 全局默认壁纸路径
    # ffmpegPath: 'D:\ffmpeg\bin\ffmpeg.exe' # 手动指定 ffmpeg 路径；留空自动探查
    # requireTrustedRequest: true           # 局域网访问信任拦截，设为 false 允许非回环直连
    # maxScanEntries: 20000                 # 单次扫描目录条目上限 (50 ~ 200000)
```

> [!NOTE]
> - 当 `roots` 为空时，将依次回退至环境变量 `REEL_ROOTS`（多路径用 `;` 分隔）以及 `$DSH_HOME/media`。
> - `cacheDir` 请务必放置在媒体目录之外，避免生成的缩略图文件被误扫入媒体库中。

---

## FFmpeg / FFprobe 智能探查

插件默认引入了 `@ffmpeg-installer/ffmpeg` 和 `@ffprobe-installer/ffprobe` 作为开箱即用的内置兜底，**无需手动安装任何外部依赖**即可享受封面抓取与视频转封装。

如果需要支持更多现代硬件解码与最新编码特性，建议在系统中安装一份新版 ffmpeg：

```powershell
# Windows (WinGet / Scoop / Chocolatey)
winget install ffmpeg

# macOS (Homebrew)
brew install ffmpeg

# Linux (Debian / Ubuntu)
sudo apt update && sudo apt install ffmpeg
```

### 运行时探查优先级：
1. 配置项中显式指定的 `ffmpegPath`；
2. `$DSH_HOME/reel/bin/` 目录；
3. 系统环境 PATH 变量及系统标准目录（WinGet Links、Scoop shims、`/usr/local/bin` 等）；
4. 插件自带的依赖包版本（保底）。

---

## 功能深度详解

### 1. 媒体库浏览
- **目录树**：左侧展示各目录根节点与子树，层级惰性加载；点击最顶层「库」可直接聚合全库内容。
- **三种模式（快捷键 G）**：
  - **当前**：仅浏览当前文件夹内容；
  - **全部**：递归平铺展示子树下的所有媒体文件；
  - **分组**：递归扫描并按文件夹折叠聚合，结构层次分明。
- **面包屑导航**：顶部路径栏支持点击跳转各级目录，`▾` 展开兄弟目录，`‹` 或 `Backspace` 快速返回上级。
- **搜索与过滤**：按 `/` 即刻定位搜索框，实时匹配名称；支持按「全部 / 视频 / 图片」分类筛选。

### 2. 影音播放体验
- **滑动刷剧**：触屏设备上下滑动手势即时切换上一条 / 下一条；桌面端支持键盘 `↑` `↓` 或鼠标滚轮切换。
- **智能连播**：支持列表顺序连播与随机打乱连播（点击控制条 `⇄` 切换）；顶栏「看视频」按钮可一键随机起播整个当前视图。
- **精准取帧与微缩预览**：鼠标划过进度条时实时浮现对应时间的画面缩略图与精确时间。
- **播放进度记忆**：自动记录播放时间点，再次打开即刻续播。
- **更多工具**：支持 0.25× ~ 3× 倍速（长按画面 2× 极速快进）、自动关联并挂载同名 `.vtt` / `.srt` 字幕、当前帧高清截图导出、原片极速下载。

### 3. 图片查看器
- 点击网格封面平滑弹出图片查看器；
- 支持鼠标滚轮无级缩放、双击 2× 放大/还原、按住拖拽平移画面；
- 键盘 `←` / `→` 键即时翻页，移动端支持双指捏合缩放与横滑切图。

### 4. 沉浸式动态壁纸
- 在播放器或图片查看器中点击「设为壁纸」按钮，即可将当前音视频或美图固定为全页面背景；
- 视频壁纸自动静音无缝循环播放；当浏览器标签页处于后台时智能暂停，丝毫不占系统性能。

---

## 快捷键速查表

### 列表页 / 画廊

| 按键 | 功能说明 |
|:---:|:---|
| <kbd>G</kbd> | 轮换内容模式（当前层级 → 递归全部 → 折叠分组） |
| <kbd>V</kbd> | 切换视图（网格 Grid ⇄ 列表 List） |
| <kbd>S</kbd> | 切换排序规则（最新优先、名称、大小等） |
| <kbd>R</kbd> | 重新加载刷新媒体库 |
| <kbd>/</kbd> | 聚焦并激活顶部搜索框 |
| <kbd>Backspace</kbd> / <kbd>Ctrl</kbd>+<kbd>↑</kbd> | 返回上一层目录 |
| <kbd>Esc</kbd> | 关闭图片查看器 / 取消搜索框聚焦 |

### 视频播放器

| 按键 | 功能说明 |
|:---:|:---|
| <kbd>Space</kbd> / <kbd>K</kbd> | 播放 / 暂停 |
| <kbd>←</kbd> / <kbd>→</kbd> | 后退 / 前进 5 秒 |
| <kbd>J</kbd> / <kbd>L</kbd> | 后退 / 前进 10 秒 |
| <kbd>↑</kbd> / <kbd>↓</kbd> | 音量微调 (±5%) |
| <kbd>M</kbd> | 静音 / 取消静音 |
| <kbd>F</kbd> | 网页全屏 / 退出全屏 |
| <kbd>Q</kbd> | 开启 / 关闭画中画 (PiP) |
| <kbd>C</kbd> | 打开 / 关闭字幕选择菜单 |
| <kbd>I</kbd> | 显示详细统计信息 (Stats for nerds) |
| <kbd>U</kbd> | 切换单曲循环 / 列表连播 |
| <kbd>P</kbd> | 截取当前视频帧并保存为 PNG 图片 |
| <kbd>D</kbd> | 下载当前播放的原媒体文件 |
| <kbd>[</kbd> / <kbd>]</kbd> | 降低 / 提高播放倍速 (0.25× ~ 3×) |
| <kbd>0</kbd> | 还原为 1.0× 正常播放倍速 |
| <kbd>Home</kbd> / <kbd>End</kbd> | 跳转到视频片头 / 片尾 |
| <kbd>Esc</kbd> | 退出全屏 / 关闭二级菜单 / 关闭播放器 |
| **鼠标左键长按** | 2.0× 临时极速快进 (松开立即恢复原速) |
| **鼠标滚轮 / 触摸屏上下滑** | 切换上一条 / 下一条视频 (短视频式跟手切换) |

---

## 友情链接

- [linux.do](https://linux.do/) - 新的理想型社区。

---

## 开源许可

本项目基于 [MIT License](LICENSE) 协议开源。

欢迎提交 [Issue](https://github.com/lsjspl/dsh-reel/issues) 反馈建议或发起 [Pull Request](https://github.com/lsjspl/dsh-reel/pulls)！
