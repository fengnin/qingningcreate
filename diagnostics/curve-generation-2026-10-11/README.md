# 曲线生成阻断诊断（2026-10-11）

## 根因和边界

初始 HEAD：370d77a69dc10b2e586c8703237a2a127e53c73f。原有未提交内容包括 .gitignore、backend/src/storyService.ts（690 行增加、148 行删除）、backend/src/storyService.test.ts、已删除 tmp 文件及两份私有文档；本轮未修改或提交这些内容。

前端 npm.cmd run dev（Vite）正在 localhost:5173 监听，进程命令指向当前仓库 frontend/node_modules/vite。vite.config.ts 默认将 /api 代理到 http://127.0.0.1:8787；前端目录没有 .env 覆盖文件。后端 npm.cmd run dev 对应 tsx watch src/server.ts；初始虽然 npm/tsx watcher 进程存在，8787 没有监听。

直接 GET http://127.0.0.1:8787/health 失败：ECONNREFUSED。POST http://localhost:5173/api/story/co-create/start 的诊断请求返回 HTTP 500、Content-Type: text/plain、正文长度 0。这发生在模型调用和业务合同解析之前。前端 readJson 的 response.json() 抛错，产生“故事服务返回了无法读取的内容，请重试。”，曲线页随后显示“曲线没有生成”。这不是观察到的模型生成失败、有效 JSON 合同不一致或旧会话迁移错误。

初始诊断请求为 {idea: 放学铃响相关示例, brief: {}}，但 Windows PowerShell stdin 管道把中文编码成 28 个问号，实际发送的 idea 为 "????????????????????????????"。该请求仅证明代理空错误正文；它没有到达后端，不能作为业务输入验收。用户历史操作的具体想法、选项、浏览器会话和日志未提供，本轮没有声称取得其历史请求。

后端 node_modules/tsx/dist/cli.mjs 和 node_modules/.bin 缺失，npm.cmd run dev 报 tsx 不存在，直接运行报 MODULE_NOT_FOUND。npm.cmd ci 按现有锁文件恢复 85 个包；没有改 package.json 或锁文件。恢复依赖后启动当前源码，/health 返回 {ok:true,model:"qwen-plus",configured:true}，实际生成成功。依赖为什么缺失以及旧 watcher 何时停止工作，没有历史日志证明，不能追溯归因。

代码运行路径不依赖已删除的 tmp 文件。默认会话路径是 backend/data/story-sessions.json，只有显式 STORY_SESSION_STORE_PATH 才会改路径；本地 .env 没有该覆盖。已删除的 tmp-debug-server.cmd 等没有被 package.json 或业务代码引用。因此不能将本次故障归因于删除 tmp。

## 最小修复

恢复锁文件依赖并后台启动当前后端开发服务，保持现有前端入口和代理目标。后端日志写到本轮新建的 tmp-backend.stdout.log / tmp-backend.stderr.log，stdout 为 Story API listening on http://127.0.0.1:8787，stderr 为空。初始请求没有后端关联日志，因为目标端口连接被拒绝；当前后端不记录成功请求正文，成功请求证据由浏览器网络响应保存。

frontend/src/story/storyApi.ts 仅增加非 JSON 失败响应分类：500/502/503/504 显示服务不可用和启动检查提示；其他非 JSON HTTP 错误保留状态码。有效 JSON 后端错误仍保留原始错误码和文案；200 HTML/空正文仍判定 INVALID_RESPONSE；非预期 JSON 仍执行原合同校验。本轮没有更改模型提示、事实校验、成功判定、fallback 或原测试期望。

## 实际浏览器请求

使用独立干净 Edge headless 浏览器上下文访问现有 http://localhost:5173/；没有接管用户已有浏览器 profile 或旧 localStorage。页面输入“青柠想去游乐园玩”，选择成长、反差，点击“生成暂定故事曲线”。

请求为 POST /api/story/co-create/start：

```json
{"generationMode":"review-actions","idea":"青柠想去游乐园玩","brief":{"tones":["growth"],"dramaticForces":["contrast"],"allowSystemNamedCharacters":false},"operationId":"op-2c2620ae-0645-4439-ab8d-7713cee62879"}
```

HTTP 200、application/json; charset=utf-8；storyId 为 story-919e5f5e-4be1-4456-a3f4-604032e9505d。curve.generation.origin 为 model，preparation.status 为 needs-review、beats 为 []，符合当前“先审阅提案”的流程，不是生成曲线失败。刷新 GET /api/story/session/:storyId 返回 200，同一提案恢复。

点击“采用这个方向”，POST /api/story/preparation/accept，提交 storyId、revision:0、curveId、acceptedCandidateIds:["c1"] 和页面显示的 authorReview。HTTP 200、application/json; charset=utf-8，revision 为 1，返回 current-state/trigger/resolution 三个节点。页面实际显示三节点，刷新再次 GET 同一会话返回 200，节点仍在。完整 URL、payload、HTTP 状态、Content-Type 和完整正文见 requests.json。

后端配置为 qwen-plus，生成没有设置 STORY_DISABLE_MODEL，使用实际 DashScope 调用；HTTP/合同验收使用的 stub 属于另外的隔离服务，不是本次浏览器请求的模型来源。

错误页面检查单独使用 Playwright 回放观测到的 500 text/plain 空正文，仅作为 UI 故障注入。页面显示准确错误和“再试一次”；点击后没有拦截模型请求，真实 qwen-plus 返回 HTTP 200 并展示提案。见 retry.json，明确区分故障注入与真实重试。

## 验证与剩余风险

工程检查通过：双端 npm.cmd run build；111/111 storyService 测试；24/24 preparation、initial reasoning、legacy fallback、interaction contract 相关测试；新增 test-story-api-errors.mjs；accept-preparation.mjs（22 次隔离 stub 调用）；accept-interaction-contract.mjs（包含历史形状、重启和旧页面 revision 合同）。git diff --check 通过。

实际路径通过：真实 qwen-plus 提案、采用后生成三节点、提案和曲线刷新恢复、错误提示和真实模型重试。

真实内容质量未通过全面验收：模型提案将“去游乐园”转成“用纸和彩笔制作通行证、在客厅想象游园”，新增物件、地点及行为，且与原始目标有偏移；它们仍标记为系统提案，未作为已执行事实。本轮只修复连接与错误解释阻断，没有扩展为内容策略改造，也没有用工程通过替代内容通过。

用户原有浏览器会话未接管，因此其特定旧会话仍未逐条实测；旧形状与 revision 冲突只由隔离合同测试覆盖。新服务是开发进程，退出或重启机器后仍需按 README 同时启动前后端。npm ci 报告现有依赖 2 项 critical audit 问题，本轮未扩大范围更换依赖。

本轮新建的 tmp-browser 和 tmp-backend 日志只是诊断产物，可移除，不是产品运行依赖。requests.json 与 retry.json 保存在此非 tmp 目录，不含密钥。
