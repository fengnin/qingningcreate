# 时光川行 · 青柠创作平台

由通义千问驱动的故事共创应用。从一句想法出发，先整理材料、设计故事，再由作者确认主线，逐段展开正文。每段都可以手动修改、提出局部重写意见，确认采用后继续写作。

## 目标用户与实际痛点

面向希望把零散灵感发展成完整故事，同时希望保留创作决定权的创作者。

- **故事发展难以把控**：一次生成整篇故事，很难在情节定型前参与方向选择和主线调整。
- **作者想法容易被覆盖**：系统补充的设定或情节，可能与创作者原本提供的事实和边界混在一起。
- **局部修改牵动全文**：只想调整某个节点或段落时，往往需要反复重写，难以逐步完成作品。

时光川行将创作拆成方向选择、故事设计和逐段写作。AI 提供可编辑的故事建议，作者审阅、修改并决定采用什么，在保留创作控制的同时逐步完成作品。

## 项目介绍

时光川行面向希望把零散灵感发展成完整故事的创作者，将方向构思、主线设计和正文写作放在同一个工作流中。AI 提供可编辑的故事建议，作者决定采用什么，并逐步完成自己的作品。

## 核心功能

- **灵感构思**：根据想法和创作要求生成候选故事方向，帮助找到值得展开的冲突与困境。
- **故事地图**：在写作前查看故事的开端、发展与收束，编辑节点或重新生成局部设计。
- **逐段共创**：按确认的主线展开正文，支持手动编辑和带意见的局部重写。
- **作者确认**：由作者审阅和采用设计、正文，控制故事走向与表达。
- **会话恢复**：在本地保存创作进度，支持刷新后继续创作及恢复故事设计版本。

## 使用流程

1. **准备材料**：输入创作想法与要求，比较故事方向，编辑困境及其推演解释。
2. **故事设计**：审阅故事地图，修改开端、发展与结尾；系统补充的内容作为提案，由作者决定是否采用。
3. **确认主线**：处理原始材料和待审设计后确认故事主线。确认设计不会自动开始剧情。
4. **逐段写作**：按故事设计展开一段正文，审阅、手动修改或填写意见局部重写，保存修改后再采用并继续。
5. **整理成稿**：完成段落审阅，整理为完整故事。

## 技术栈

- 前端：React 18、TypeScript、Vite。
- 后端：Express、TypeScript。
- 模型：DashScope 的 OpenAI 兼容接口，默认使用 `qwen-plus`。
- 存储：本地 JSON 会话文件。

## 架构

```text
创作者
  │
  ▼
前端（React、TypeScript）
  │ HTTP API
  ▼
后端（Express、TypeScript） ── DashScope / Qwen
  │
  ├── JSON 会话存储
  └── shared/ 前后端共享的数据契约与规则
```

## 快速开始

建议使用 Node.js 22 LTS 与 npm，并准备可用的 DashScope API Key。

以下命令适用于 Windows PowerShell。macOS、Linux 可将 `npm.cmd` 替换为 `npm`。

### 安装依赖

```powershell
git clone https://github.com/fengnin/qingningcreate.git
cd qingningcreate
cd backend
npm.cmd ci
cd ../frontend
npm.cmd ci
cd ..
```

### 配置模型

```powershell
Copy-Item backend/.env.example backend/.env
```

编辑 `backend/.env`，填入自己的密钥：

```dotenv
DASHSCOPE_API_KEY=your-dashscope-api-key
QWEN_MODEL=qwen-plus
PORT=8787
```

真实密钥仅放在后端，不能写入前端代码或上传到仓库。

### 启动服务

在一个终端启动后端：

```powershell
cd backend
npm.cmd run dev
```

在另一个终端启动前端：

```powershell
cd frontend
npm.cmd run dev
```

打开前端终端显示的地址，默认是 `http://localhost:5173`。开发服务器会将 `/api` 请求代理到 `http://127.0.0.1:8787`。

可访问 `http://127.0.0.1:8787/health` 检查后端状态。

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 无 | 后端调用模型所需的密钥 |
| `QWEN_MODEL` | `qwen-plus` | 模型名称 |
| `PORT` | `8787` | 后端监听端口 |
| `DASHSCOPE_BASE_URL` | DashScope 兼容接口地址 | 自定义兼容服务地址 |
| `STORY_SESSION_STORE_PATH` | `backend/data/story-sessions.json` | 本地会话存储路径 |

配置示例见 [`backend/.env.example`](backend/.env.example)。

如修改后端端口，可在 `frontend/.env.local` 中设置开发代理目标，然后重启前端：

```dotenv
VITE_STORY_API_TARGET=http://127.0.0.1:9193
```

## 构建与部署

分别构建前后端：

```powershell
cd backend
npm.cmd run build
cd ../frontend
npm.cmd run build
```

后端构建后可在 `backend` 目录执行 `npm.cmd start`；前端构建后可使用 `npm.cmd run preview` 查看静态产物。

前端静态产物位于 `frontend/dist`。部署时需要配置 Web 服务器，将 `/api` 转发到后端；Vite 开发代理不会随静态产物部署。

## 项目结构

```text
backend/
  src/          API、模型调用、故事设计与会话逻辑
  .env.example  后端配置模板
frontend/
  src/          页面、组件与创作会话状态
shared/         前后端共享的数据契约和规则
```

## 数据保存

故事会话默认写入 `backend/data/story-sessions.json`。请自行备份需要保留的创作内容。

当前会话保存在运行后端的机器上，不提供云端同步。浏览器保存当前故事标识，用于重新打开会话。调用模型时，相关创作材料会发送至配置的模型服务。
