# 喜悦 Voice 控制台

喜悦 Voice 的音箱管理页面。从音箱的 HTTPS 地址打开，可配置 ASR、大模型、TTS、对话语言与外部 Agent，管理已启用能力，查看设备状态、第三方用量和对话记录。

- **能力中心**管理远程听音、计时、闹钟、外语陪练、Home Assistant 及自定义 HTTP 工具。
- **自动化**配置触发条件、执行步骤，查看运行结果。
- **系统配置 → 外部访问**为其他应用签发可撤销的设备能力令牌。了解 [接口契约](https://github.com/jinuljt/xiyue-agent/blob/main/docs/capability-api.md)。

## 本地开发

需要同级目录中的 [xiyue-agent](https://github.com/jinuljt/xiyue-agent)。由 Agent 提供静态资源和后端接口。

```sh
cd ../xiyue-agent
go run ./cmd/xiyue-agent -console ../xiyue-console/web
```

启动后访问 [本地控制台](http://127.0.0.1:8765/)。

| 路径 | 内容 |
| --- | --- |
| [`web/index.html`](web/index.html) | 控制台页面 |
| [`web/app.js`](web/app.js) · [`web/style.css`](web/style.css) | 页面交互与样式 |
| [`web/help.html`](web/help.html) · [`web/help.js`](web/help.js) | 控制台内的分类配置指南 |

在本仓库运行 `node --check web/app.js` 和 `node --check web/help.js` 检查脚本语法。
