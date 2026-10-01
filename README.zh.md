# 插件市场

插件市场为 DeepSeek Harness 增加一个 **Market** 页面：从 npm 注册表和 GitHub 检索 DSH 插件，
展示每个插件是做什么的、作者提供的界面截图，并在安装前用模型做一次风险审查。

两个入口都能打开：

- 侧边栏的 **插件市场** 图标（官方「插件」按钮旁边）
- **设置 → 内置插件 → 市场** 页签

插件装上之后由官方 **插件** 页面接管——启用、配置、卸载都在那里，市场只提供一个跳转入口。

## 安装

**从 DSH 里装。** 打开 **插件 → 添加插件**，填入包名并确认：

```
dsh-plugin-market
```

或直接指向仓库地址（npm 还没发布时也能用）：

```
github:OWNER/dsh-plugin-market
```

**手动安装**，在 profile 的 `package.json` 里加两项：

```json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-plugin-market"] } },
  "dependencies": { "dsh-plugin-market": "link:/path/to/dsh-plugin-market" }
}
```

然后重新安装 profile 依赖并重启 DSH。

宿主半边在启动时加载，所以**必须重启**；浏览器半边在 DSH 运行期间会自行热重载。

---

## 写给插件作者

你的插件**什么都不做也会出现在市场里**：npm 上带 `dsh-plugin` 关键词的包、以及 GitHub 上的
仓库都会被检索到；没有额外资料时，市场会退回到读你的 `README.md` 取截图、读 `package.json`
取名称和描述。

下面全部是**可选的**。它决定的是你的插件页**准不准**——logo 对不对、介绍有没有说清插件到底做什么、
截图是不是真实的界面。

### 新建一个文件夹：`dsh-market/`

把市场要展示的东西都放进仓库根目录下的这一个文件夹：

```text
your-plugin/
├─ package.json          ← "icon" 指向文件夹里的 logo
├─ README.md
└─ dsh-market/
   ├─ market.json        ← 介绍、开发者、截图清单
   ├─ logo.svg           ← 你的 logo
   └─ screenshots/
      ├─ dashboard.png
      └─ settings.png
```

放一个文件夹的好处是仓库根目录保持干净，想撤掉资料时删掉整个文件夹就行。
如果你更愿意只加一个文件，根目录的 `dsh-market.json` 同样有效；两者同时存在时以
`dsh-market/market.json` 为准。

### 一、logo

用标准清单字段声明，官方「插件」页读的也是这个字段：

```json
{
  "icon": "./dsh-market/logo.svg"
}
```

| 规则 | 取值 |
|---|---|
| 格式 | `.svg`、`.png`、`.jpg`、`.jpeg`、`.webp` |
| 大小上限 | 256 KiB |
| 位置 | 解析后必须仍在你的包目录内 |
| 形状 | 正方形，按 36×36 画布绘制 |

官方图标看起来是**实心填充路径 + `userSpaceOnUse` 线性渐变**，图形占画布约 50–58%。
对比之下，用细 `stroke` 画的线框会明显偏轻、跟周围不是一套。想让自己的图标自然融进去，
可以把 DSH 安装目录里的某个图标拿来对照它的画法。

### 二、`dsh-market/market.json`

所有字段都是可选的；每个文本字段既可以写普通字符串，也可以写分语言的对象
（`{"zh": "…", "en": "…"}`）。没写的字段会退回到你的 `package.json` 与 `README.md`。

```json
{
  "schemaVersion": 1,
  "displayName": { "zh": "上下文面板", "en": "Context Panel" },
  "developer": { "name": "你的名字", "url": "https://github.com/you" },
  "summary": {
    "zh": "在会话里查看上下文占用与工具调用细节。",
    "en": "Inspect context usage and tool-call detail inside a session."
  },
  "description": {
    "zh": "较长的一段介绍，显示在详情页的正文位置。",
    "en": "The longer introduction, shown as the detail page body."
  },
  "homepage": "https://example.com",
  "license": "MIT",
  "screenshots": [
    { "url": "dsh-market/screenshots/dashboard.png", "caption": { "zh": "主面板", "en": "Dashboard" } },
    { "url": "dsh-market/screenshots/settings.png", "caption": { "zh": "设置页", "en": "Settings" } }
  ]
}
```

| 字段 | 作用 |
|---|---|
| `displayName` | 卡片与详情页的标题（默认取你的包名） |
| `developer.name` / `developer.url` | 开发者一行（默认取 `package.json` 的 author，再退到仓库所有者） |
| `summary` | 标题下面那一两行简介 |
| `description` | 详情页的正文长介绍 |
| `homepage`、`license` | 详情页的信息行 |
| `screenshots[].url` | 仓库内相对路径，或受支持域名上的绝对地址 |
| `screenshots[].caption` | 图片下方的图注，全屏查看时也显示 |
| `logo` | 可选；只覆盖市场里显示的 logo，不影响 `package.json` 的 `icon` |

### 三、截图

`url` 指向你自己仓库里的文件即可，写相对于仓库根目录的路径最省事：

```json
"screenshots": [{ "url": "dsh-market/screenshots/dashboard.png" }]
```

**完全没有描述文件也没关系**：市场会去读你已经嵌在 `README.md` 里的图（markdown 与
HTML 两种写法都认）。把最好的截图放在 README 靠前的位置效果更好，因为靠前的图排序更优先。

展示之前，市场会检查：

| 规则 | 原因 |
|---|---|
| 域名必须是 `raw.githubusercontent.com`、`user-images.githubusercontent.com`、`objects.githubusercontent.com` 或 `avatars.githubusercontent.com`，且为 https | 展示放在别处的图，等于把每个读者的 IP 暴露给那台服务器 |
| 文件必须真的能解码为 PNG / JPEG / GIF / WebP / SVG | 返回 `200` 不等于有图——错误页和 1×1 追踪像素也会返回 200 |
| 最短边 ≥ 240px、最长边 ≤ 5000px、不超过 6 MiB | 挡掉图标、横幅和无谓的大文件 |
| 最多展示 6 张 | 列表是概览，不是图库 |
| 徽章、logo、二维码、群聊海报、社交预览卡按文件名过滤 | 它们从来不是界面截图 |

README 这条路径下，`.svg` **只有**在文件名或 alt 文字表明它是界面时才考虑
（`preview-en.svg` 要，`logo-en.svg`、`architecture.svg` 不要），因为 README 旁边的矢量图
通常是 logo 或示意图。

截图可以点开全屏查看：点一下放大，再点一下在「适应窗口」与「原始大小」之间切换。

### 四、语言

`summary` 与 `description` 用你顺手的语言写就行。读者语言不同时，市场会调用模型翻译**一次**
并缓存，缓存键是原文——所以**只有你改动描述才会触发重新翻译**，其它任何情况都不会。译文一律
标注「机翻」，你的原文保留在悬停提示里。

你也可以自己提供译文，写了就以你的为准：

```json
"summary": { "zh": "……", "en": "……" }
```

你的 `README.md` 始终按原文展示，**不做机器翻译**。

---

## 配置

| 环境变量 | 作用 |
|---|---|
| `DSH_MARKET_GITHUB_TOKEN` | 检索用的 GitHub Token。不设时 GitHub 检索受未认证配额限制（10 次/分钟）。也会读 `GITHUB_TOKEN`、`GH_TOKEN`。 |
| `DSH_MARKET_CACHE_DIR` | 翻译缓存目录。默认 `<DSH_HOME>/cache/dsh-market`。 |

## 隐私与安全

- **每个请求都经过鉴权。** 页面通过 `/api` 通道上的一条精确路由访问本插件，该通道由连接层
  套上 Host/Origin 校验与浏览器 cookie 鉴权；未授权请求返回 `401`。
- **图片只从代码托管域名加载**，浏览列表不会把你的存在暴露给第三方；图片以
  `referrerPolicy="no-referrer"` 渲染。
- **没有审查就不会安装。** 点击安装会先跑一遍确定性规则扫描，再用模型审查插件的清单与入口代码，
  展示结论并需要你明确确认。该确认是审查签发的**一次性凭据**，直接调用路由无法绕过检查。
- **第三方代码按不可信数据处理。** 审查不会听从插件源码里的任何指令，插件自称安全也不会降低它
  自己的风险判定。
- **构建脚本永不自动批准。** pnpm 拦截 `postinstall` 之类脚本时，只会把脚本名报给你，由你决定
  批不批。
- **译文只缓存在本地**，除调用你自己配置的模型外不会发往别处。

## 许可证

[MIT](LICENSE)。
