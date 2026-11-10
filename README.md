# Cutroom · 绿幕影像工作台

浏览器里完成绿幕抠像、选段、静态图裁切和 Lottie 素材导出的本地工作台。没有后端，素材不上传，所有处理都在本机 Canvas / WebCodecs 里完成。

## 打开方式

直接双击 `index.html`，或在本目录起一个静态服务器：

```bash
python -m http.server 8080
# 打开 http://localhost:8080
```

页面按相对路径加载同目录的 JS、CSS 和 `vendor/`，移动或改名时请整个目录一起搬。

## 目录

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构与内联样式入口 |
| `studio.css` | 界面样式 |
| `keylight.js` | 抠像核心：取色、发丝优先、遮罩生成 |
| `frame-timeline.js` | 时间轴、四秒选段、播放头与逐帧步进 |
| `packed-mp4.js` | 拼接 MP4（左彩色黑底 / 右白色遮罩）编码导出 |
| `static-images.js` | 商详图 / 封面图 / 收藏柜图三张透明 PNG |
| `lottie-template.js` | 内置 Lottie 模板与打包 |
| `material-export.js` | ZIP 组装与命名规则 |
| `batch-tasks.js` | 批量素材队列 |
| `studio-ui.js` | 界面小工具 |
| `vendor/` | mediabunny（MP4 封装），含许可证与 NOTICE |
| `显示范围-独立素材/` | 娃娃固定显示范围的遮罩、定位参考与坐标说明 |

功能与输出规范见 [拼接MP4说明.md](拼接MP4说明.md)。

## 输出规范摘要

- 拼接视频 2272×1424、H.264、无音频，左右各 1136×1424
- 单侧区域 (62,307) 1014×1052，动作范围等比缩放至 90% 后居中
- 静态图取选段首帧，按主体最大连通范围裁切、等比适配居中
- 命名统一去掉扩展名、"绿幕"和末尾的"的视频/视频"

## 许可

本仓库代码归项目作者所有。`vendor/mediabunny-1.65.2.min.js` 遵循其自带许可证，详见 `vendor/LICENSE-mediabunny.txt` 与 `vendor/NOTICE.txt`。
