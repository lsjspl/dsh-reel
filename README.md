# dsh-reel

给 dsh Web 加一个媒体库页面：把若干本地目录挂进来，浏览其中的图片与视频。

```
http://127.0.0.1:3080/reel
```

- 与 dsh Web 同端口、同 origin；宿主侧只新增一行组合配置和 `/reel` 前缀下的只读路由，不启动新进程、无构建步骤
- 对媒体目录只读；目录列举与文件读取都限制在配置的目录内
- 视频以 HTTP Range 响应流式传输，拖动进度条即时起播
- 浏览器不支持的容器由服务端用同一个 ffmpeg 转封装为 fragmented MP4 边转边发，不写盘
- 可选依赖：装了 ffprobe 由服务端探测时长与分辨率，装了 ffmpeg 生成封面帧和悬停预览，都没有则退化为浏览器自行取帧
- 自带 ffmpeg / ffprobe：作为普通依赖随插件一起装好（`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe`，无安装脚本），开箱即用；系统上已有的话优先用系统的（见「配置 → ffmpeg / ffprobe」）

## 安装

```powershell
dsh plugin --profile web add dsh-reel
```

重启 `dsh web`，打开 <http://127.0.0.1:3080/reel>。

安装未发布版本、或本地改源码时：

```powershell
dsh plugin --profile web add "github:lsjspl/dsh-reel"
dsh plugin --profile web add "link:C:\path\to\dsh-reel"   # 软链，改完刷新页面即可
```

卸载：`dsh plugin --profile web remove dsh-reel`。

## 配置

配置写在 `settings.yaml` 的 `reel` 命名空间下，两个入口等价，改动热生效、无需重启：

- **dsh 设置 → 插件 → 插件配置 → 媒体库**：增删媒体目录、指定缓存目录、设置全屏壁纸
- profile 的 `cordis.patch.yml`：

```yaml
- id: reel
  config:
    roots:
      - D:\Photos
      - E:\电影
    # cacheDir: 'D:\dsh-cache'   # 封面帧与悬停预览的缓存目录，默认在系统临时目录
    # ffmpegPath: 'D:\ffmpeg\bin\ffmpeg.exe'   # 手动指定 ffmpeg；不填则自动查找
```

`roots` 为空时依次回退到 `REEL_ROOTS` 环境变量（`;` 分隔）与 `$DSH_HOME/media`。缓存目录应位于媒体目录之外，否则缓存文件会出现在列表中。

### ffmpeg / ffprobe

插件**自带一份**：`@ffmpeg-installer/ffmpeg` 与 `@ffprobe-installer/ffprobe` 是普通依赖，随 `dsh plugin add` 一起装好，二进制在各自的平台子包里（没有 postinstall 脚本，pnpm 默认拦构建脚本也拦不到），所以开箱即有封面帧、悬停预览与老容器转封装。

这两个包自带的构建**偏旧**——里面是 2018 年底的 ffmpeg 4.1，包本身 2021 年后没再更新。要新版本就按系统方式装一份，插件会优先用它：

```powershell
winget install ffmpeg      # 或 brew install ffmpeg / apt install ffmpeg
```

不指定 `ffmpegPath` 时的查找顺序：

1. 配置里的 `ffmpegPath`
2. `$DSH_HOME/reel/bin/`（想手动放一份就在这里）
3. PATH 上的 `ffmpeg`；Linux / macOS 再看 `/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`；Windows 再看 WinGet Links、scoop shims、chocolatey bin、`%LOCALAPPDATA%\Programs\ffmpeg\bin`、`C:\ffmpeg\bin`，以及 WinGet `Packages` 下带哈希的那一层
4. 依赖自带的那份（兜底）

`ffprobe` 优先取与所选 ffmpeg 同目录的那份（版本对得上），其次依赖自带，最后 PATH。全都没有时：仍可浏览与播放浏览器原生支持的格式，封面退化为浏览器自行取帧，但不会有服务端探测的时长与分辨率、没有悬停预览，AVI / WMV / FLV / RMVB 这类容器也无法转封装播放。

## 使用

### 列表页

左侧为目录树：顶层「库」聚合全部配置目录（选中即递归列举整个库），其下是各配置目录的根，子目录按需加载。

内容有三种模式，按 `G` 轮换：

| 模式 | 列举范围 |
|---|---|
| 当前 | 仅当前这一层 |
| 全部 | 递归整个子树，平铺 |
| 分组 | 递归整个子树，按目录折叠为嵌套分组 |

- 视图在网格与列表之间切换；网格有三档瓦片尺寸，窄屏下「大」为单列
- 类型过滤：全部 / 视频 / 图片
- 上方路径行：点目录名进入该层，`▾` 选择子目录，`‹` 返回上一级（`Backspace`）；层数过深时中间层级折叠为 `…`
- 搜索框只过滤当前这一层；列表滚动到底自动续页
- 顶栏「看视频」：打乱当前列表，以页内全屏打开播放器，从随机一条开始连播

### 图片查看器

点封面打开：滚轮缩放、拖动平移、`←/→` 翻页。默认以窗口形式打开，可切换为页内全屏。

### 播放器

- 触屏 / 窄屏打开即为页内全屏；上下滑动切换上一条 / 下一条，桌面端为 `↑` `↓` 或 `⏮` `⏭`，播完自动续播
- 播放顺序为顺序或随机（控制条 ⇄）。随机在打开时打乱一次且当前条目置顶，之后的滑动与连播都按该次序；选择持久化在本地
- 连播列表是当前列表中的全部可播条目（视频与音频），跟随所在层级、过滤与排序
- 倍速 0.25×–3×、长按 2× 快进、播放位置记忆、同名字幕自动加载、截图、下载
- 容器不受浏览器支持时（AVI / WMV / FLV / RMVB 等）由服务端转封装为 fragmented MP4 边转边播；拖动进度条会从目标时间重新开一条流

### 全屏壁纸

查看器与播放器上的壁纸按钮把当前条目设为整页背景，图片与视频均可（视频静音循环，页面不可见时暂停）。壁纸层位于界面之下且不接收指针事件，界面各层转为半透明以透出壁纸。再次点击同一按钮取消。设置中的壁纸是所有设备的默认值，页面内设定只作用于本机。

### 移动端与局域网

图片查看器支持双指捏合缩放与横滑翻页，含 safe-area 适配。局域网访问需以 `dsh web --host 0.0.0.0` 启动，先用启动输出中带 token 的地址完成信任，之后访问 `/reel`。

### 快捷键

| 列表页 | 播放器 |
|---|---|
| `G` 内容模式 | `空格` / `K` 播放暂停 |
| `V` 网格 / 列表 | `←` `→` 后退 / 前进 5 秒 |
| `S` 排序 | `J` / `L` 后退 / 前进 10 秒 |
| `R` 重载 | `C` 字幕 |
| `B` 收起目录树 | `F` 全屏 |
| `/` 筛选 | |

## License

MIT · <https://github.com/lsjspl/dsh-reel>
