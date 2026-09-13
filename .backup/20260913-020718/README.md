# dsh-reel

在 dsh 的端口上开一个图片 / 视频浏览页：同端口、同源，无新进程、无构建，对用户文件只读。两种模式：**列表模式**（目录树 + 网格/列表 + 图片查看器）和**刷视频模式**（一屏一条的纵向流）。视频走 HTTP 范围响应，拖动进度条即时起播。

```
http://127.0.0.1:3080/reel
```

## 安装

从 npm：

```powershell
dsh plugin --profile web add dsh-reel
dsh web
```

不是 `npm install`：插件要注册进 profile 的 bundle 列表才会被 dsh 加载，这条命令（转给 pnpm 装包 + 注册）一并完成。

从 Git（不等发版）：

```powershell
dsh plugin --profile web add "github:lsjspl/dsh-reel"
dsh plugin --profile web add "git+https://github.com/lsjspl/dsh-reel.git#main"   # # 后跟分支/tag
```

本地开发（软链，改源码立即生效）：

```powershell
dsh plugin --profile web add "link:C:\path\to\dsh-reel"
```

卸载：

```powershell
dsh plugin --profile web remove dsh-reel
```

## 指定目录

两处入口，数据是同一份（`settings.yaml` 的 `reel` 命名空间），改动热生效：

- **dsh 设置 → 插件 → 插件配置 → Reel 媒体浏览**：卡片里增删目录、配置缓存目录；顶部有「打开 Reel」按钮和项目 GitHub 链接。
- **profile 的 `cordis.patch.yml`**（组合行配置）：

```yaml
- id: reel
  config:
    roots:
      - D:\Photos
      - E:\电影
    # cacheDir: 'D:\dsh-cache'   # 视频封面/悬停动画缓存，缺省在系统临时目录
```

也可以用 `REEL_ROOTS` 环境变量（`;` 分隔，仅在没有其他配置时生效）。都没有时回退 `$DSH_HOME/media`。

浏览页自身没有目录配置入口，接口里也没有媒体目录之外的目录列举能力；缓存目录别放在媒体根里面——缓存文件会出现在浏览页，插件会记一条警告。

## 功能

**列表模式**

- 左侧目录树，每个配置的目录都是一个根，子目录按需加载
- 两个开关：内容（全部 / 视频 / 图片）、视图（网格 / 列表）；列出范围是独立的一枚「本层 / 所有层级」（快捷键 `A`），切目录不会把它关掉
- 路径行和右边的按钮同一行：点名字直接进那一层，`▾` 挑这一层的子文件夹，`‹` 回上一级（`Backspace`）；路径深了自动把中间层级收成一枚 `…`，点开才摊平
- 视频封面取中间帧，悬停播放 4 秒静音小动画（需 ffmpeg，没有则退化）
- 加载全程静默，续页滚到底自动拉
- 图片查看器：滚轮缩放、拖动平移、`←/→` 翻页
- 快捷键：`V` 网格/列表 · `S` 排序 · `A` 范围 · `R` 重载 · `B` 收起目录树 · `/` 筛选

**刷视频模式**

- 纵向 scroll-snap 吸附，滚轮 / 触摸 / `↑` `↓` 切换
- 视频静音自动播放、循环；图片 6 秒自动前进
- 只挂载当前条前后各一条 `<video>`，长列表不爆解码器
- `M` 静音 · `空格` 暂停 · `Esc` 回列表

**播放器**

- 即时拖动起播，断点续传
- 0.25×–3× 倍速、长按 2× 快进、续播、连播
- 自动加载同名字幕（SRT / ASS），截图、下载、统计面板
- `空格`/`K` 播放暂停 · `←/→` 5 秒 · `J`/`L` 10 秒 · `C` 字幕 · `F` 全屏

**手机端**

- 双指捏合缩放、横滑翻图、上下滑切视频，safe-area 适配
- 局域网访问：`dsh web --host 0.0.0.0`，手机先打开启动输出的带 token 地址完成信任，再进 `/reel`

## 安全

- 路径包含性经 `realpath` 验证，`..` 与外部软链出不去
- 页面只见配置过的目录：没有任何媒体根之外的目录列举或搜索接口
- 对媒体目录只读，缩略图缓存在系统临时目录或配置的缓存目录
- 默认复用 dsh 的浏览器信任闸门，LAN 访问需先过信任

## 侵入面

组合树一行、只占 `/reel` 与 `/reel/*` 路由、零依赖、无构建。详见 `cordis.patch.yml`。

## 测试

```powershell
node tests/run.mjs   # 独立用例，不需要 dsh
```

其余（live / mobile / layout / verify-ui）针对运行中的实例，见 `tests/` 目录。

## 项目

源码与问题反馈：<https://github.com/lsjspl/dsh-reel>

## License

MIT
