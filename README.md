# roycode-dsh-pack

把 roycode-studio 里好用的功能移植为 DSH（DeepSeek Harness）插件的可复用安装包。
已在 Windows + dsh web profile 上实测通过（2026-08-15）。

## 包含内容

| 类别 | 名称 | 说明 |
|---|---|---|
| Skill ×4 | github-workflow / magic-docs / output-styles / scheduled-prompts | 热加载，无需重启 |
| MCP ×3 | lsp（9 个工具：诊断/定义/引用/实现/hover/符号/重命名）、secret-scan（2）、browser（2） | 需重启 dsh web |
| Cordis 插件 ×3 | roycode-hooks v2（**可编程事件引擎**：session 事件→shell 命令，4 个运行时管理工具 hooks_rule_add/confirm/remove/list + JSON 持久化 + 会话事件审计）、roycode-teams v0.4（**12 个工具**：成员读游标 + unread + limit + since 覆盖、team_archive 幂等归档（默认保留 200 条）、**team_history 归档回读（since/limit 分页，审计闭环）**、内存上限 50 + memoryHistory、team_memory_clear）、dsh-schedule（原生定时提醒：schedule_create/list/delete，scheduled-prompts 技能的引擎） | 需重启 dsh web |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 新机器若还没装 typescript 会自动 npm install typescript@5（可加 -SkipNpm 跳过）
# 跳过自动验证：-SkipVerify
```

前提：
- node + npm 在 PATH
- `dsh web` 至少启动过一次（生成 profiles/web/node_modules）
- 装完**重启 dsh web**（MCP 与 cordis 插件启动时加载；skills 热加载即时生效）

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 结构与原理

- `skills/<name>/SKILL.md` → `~/.dsh/skills/<name>/`
- `mcp/<server>/server.mjs` → `~/.dsh/mcp-servers/<server>/`（纯手写 MCP stdio，零框架依赖）
- `plugins/<name>/` → `~/.dsh/profiles/web/node_modules/<name>/`（cordis 插件：`{name, inject, Config, apply}` + `ctx.tools.register(defineTool(...))`）
- `install.ps1` 在 `cordis.patch.yml` 里维护一段标记块（`roycode-dsh-pack-begin/end`），重复安装幂等；旧版无标记块会自动迁移。安装前自动备份为 `cordis.patch.yml.bak-roycode`

## 注意

- LSP 依赖 `typescript@5.x`（不要装 7.x——Go 原生版没有 `ts.sys` API）
- **hooks v2 动态规则**：Agent 可在会话中调用 `hooks_rule_add` 添加规则（如"每次提交前跑 secret 扫描"→ 添加 `tool/result` 规则）；新规则默认 **pending**，必须用户确认（`hooks_rule_confirm`）后才武装；已确认规则持久化到 `~/.dsh/roycode-hooks.json`，重启保留；`hooks_rule_list` 全量可见（origin: config/agent）
- hooks 默认规则：turn/end 时把一行时间戳追加到 `~/.dsh/hooks.log`；想改静态种子编辑 patch 里 `roycode-hooks.config.rules`（或重跑 install.ps1 前先改包内模板）
- 常用事件名：turn/start、turn/end、step/end、tool/call、tool/result、user/message、assistant/message、session/created
- **事件投递语义（实测）**：`session/event` 对监听器是**回合边界派发**——回合内的 tool/result、step/end 等事件不会实时到达，随 turn/end 批量投递；turn/start、user/message 在回合开始即时到达。所以"提交前扫描"这类场景建议监听 tool/result 或 turn/end（回合结束时触发），而不是期望回合中途触发
- 每次触发都会往 session 追加 `hook/invoked` + `hook/result` 审计事件（data 为 JSON，log-only 不进入消息历史）
- teams 数据存在 `~/.dsh/roycode-teams.json`
- 测试脚本：`tests/verify-hooks-v2.mjs`（17 项全流程 mock 验证）