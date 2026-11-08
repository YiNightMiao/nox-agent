# Nox

给 **Dopamine rootless** 用的设备端编码代理。界面按 Codex 那套工作台来：项目、对话、审查、终端、文件。目标系统是 **iOS 18.3.1**，安装前缀 `/var/jb`。

这不是越狱工具。手机需要已经用 Dopamine 进入 rootless 状态。Dopamine 3 在 A12/A13 上覆盖 iOS 16.6–18.7.1，18.3.1 在这个范围内。A14 及更新的芯片目前到不了 18.3.1。

## 缓存命中

命中率按 `cached_tokens / prompt_tokens` 算，界面上直接显示。

做法：

- 系统提示和工具 schema 冻住。不放时间，不放文件列表。文件一变，前缀就废了。
- 对话只往后追加。助手消息把 `reasoning_content` 原样带回，避免推理模型从回答处断开缓存。
- 每个线程固定请求头 `x-grok-conv-id: nox-<线程 id>`，让同一段前缀粘在同一台服务器上。这是 xAI 文档里的粘滞路由。
- 本地用一棵 **Radix 前缀树**。边分裂的匹配方式和 [SGLang RadixAttention](https://github.com/sgl-project/sglang)（Apache-2.0）一样，这里是独立写的字符串缓存，没有拷它的源码。整段提示完全命中时不再打模型，这一轮按 100% 计入。

首轮一定是未命中。从第二轮开始，缓存 token 应该盖住系统提示和更早的消息。

## 编译

在装了 Theos 和 iOS SDK 的 Mac 上：

```sh
make package THEOS_PACKAGE_SCHEME=rootless
```

`Makefile` 里已经写了 `THEOS_PACKAGE_SCHEME = rootless`，架构是 `arm64 arm64e`，包架构 `iphoneos-arm64`。deb 在 `packages/`。用 Sileo 或 Zebra 安装。装完主屏幕会出现 Nox。

打开后点左上角「设」，填 `https://api.x.ai/v1`、模型 `grok-4.5` 和你自己的 key。Key 只写进这台手机的 `NSUserDefaults`，不会进仓库。

## 权限

- 文件只允许待在工作区里。优先 `/var/mobile/Documents/Nox`；这个目录不可写时退回 App 的 Documents。
- `..`、绝对路径、钥匙串和系统分区都拒。
- shell 默认要你点「运行」。`rm -rf /`、重启、写块设备这类命令直接拒绝。
- 只读自动模式只放行 `pwd` / `ls` / `cat` / `head` / `echo`。

## 布局

`Resources/www` 是界面。原生壳负责没有 CORS 的模型流、文件和 shell。
