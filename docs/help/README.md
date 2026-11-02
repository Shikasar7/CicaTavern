# CicaTavern 帮助资料

给用户看的帮助，也是交流群答疑机器人回答问题时查的资料。按功能、按报错一节一节写，每节开头写清在哪里、哪个平台有、从哪个版本开始有。

| 文件 | 内容 |
| --- | --- |
| [overview.md](overview.md) | 简介：是什么、支持哪些平台、最新版本和下载、数据存在哪、收费和隐私、怎么反馈问题 |
| [features.md](features.md) | 功能：开头是功能清单，后面每个功能一节，写有没有、在哪开、怎么用 |
| [errors.md](errors.md) | 报错：报错原文（中英文）、什么时候出现、原因、怎么解决 |
| [faq.md](faq.md) | 常见问题：安装、启动、更新、数据，和 SillyTavern 有什么不同 |
| [versions.md](versions.md) | 每个版本改了什么（完整记录在 [CHANGELOG.md](../../CHANGELOG.md)） |

资料照着代码写，每次发版时更新；`node scripts/help-coverage.mjs` 检查有没有漏写的报错和设置项。发现写错了，欢迎提 Issue。
