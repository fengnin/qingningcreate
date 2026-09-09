# 时光川行 · 青柠创作平台

一个由通义千问驱动的互动故事创作应用。用户从一个模糊念头出发，依次确认故事困境、开端与结尾，并通过关键选择推进故事，最后生成完整正文。

## 功能概览

- 根据创作念头生成三种故事困境，并可补充偏好后重新生成。
- 生成故事开端、高潮和结尾的组合，固定故事目标与代价。
- 以分支选择推进故事路径，并保存已确认的剧情事实与行动。
- 根据确认的路径生成完整故事、故事节拍和一致性检查结果。
- 在本地持久化故事会话，刷新页面或重启后端后仍可继续创作。

## 技术组成

- 前端：React 18、TypeScript、Vite。
- 后端：Express、TypeScript。
- AI 服务：阿里云 DashScope 的 OpenAI 兼容接口，默认模型为 `qwen-plus`。

## 环境要求

- Node.js 18 或更高版本，推荐 Node.js 20 或 22。
- npm。
- 一个可用的 DashScope API Key。

在 Windows PowerShell 中，如果直接运行 `npm` 出现“禁止运行脚本”错误，请使用本文命令中的 `npm.cmd`。macOS、Linux 或未受该限制的终端可将 `npm.cmd` 替换为 `npm`。

## 本地运行

### 1. 获取代码并安装依赖

```powershell
git clone https://github.com/fengnin/qingningcreate.git
cd qingningcreate

cd backend
npm.cmd install

cd ../frontend
npm.cmd install

cd ..
```

### 2. 配置后端环境变量

从示例文件创建本地配置：

```powershell
Copy-Item backend/.env.example backend/.env
```

打开 `backend/.env`，至少填入 DashScope API Key：

```dotenv
DASHSCOPE_API_KEY=your-dashscope-api-key
QWEN_MODEL=qwen-plus
PORT=8787
```

`.env` 已被 Git 忽略，请不要提交真实密钥。`backend/.env.example` 只保留可公开的配置模板。

### 3. 启动后端

在第一个终端中运行：

```powershell
cd backend
npm.cmd run dev
```

服务默认监听 `http://127.0.0.1:8787`。可另开一个终端检查服务和密钥是否已加载：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

返回结果中的 `configured` 应为 `true`。

### 4. 启动前端

在第二个终端中运行：

```powershell
cd frontend
npm.cmd run dev
```

打开终端显示的地址，默认是 `http://localhost:5173`。

开发模式下，Vite 会将前端的 `/api` 请求转发到 `http://127.0.0.1:8787`，因此前后端都需要保持运行。

## 可选：直接测试故事接口

后端启动并配置好密钥后，可从项目根目录运行：

```powershell
cd backend
npm.cmd run request:directions -- -Idea "放学铃响前三分钟，一个学生发现最好的朋友开始刻意躲着自己"
```

该命令会请求 `POST /api/story-directions` 并将生成结果输出到终端。

## 构建

分别构建前后端：

```powershell
cd backend
npm.cmd run build

cd ../frontend
npm.cmd run build
```

构建产物分别位于 `backend/dist` 与 `frontend/dist`。后端生产启动命令为：

```powershell
cd backend
npm.cmd run start
```

前端产物是静态文件。部署时需要让 Web 服务器将 `/api` 反向代理至后端服务；Vite 中的开发代理只在 `npm.cmd run dev` 时生效。不要把 `DASHSCOPE_API_KEY` 放入前端环境变量或静态文件中。

## 环境变量

| 变量 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | 无 | DashScope API Key。 |
| `QWEN_MODEL` | 否 | `qwen-plus` | 使用的通义千问模型。 |
| `PORT` | 否 | `8787` | 后端监听端口。修改后需同步调整 `frontend/vite.config.ts` 的代理目标。 |
| `DASHSCOPE_BASE_URL` | 否 | DashScope 兼容接口地址 | 用于切换兼容 API 地址。 |
| `STORY_TURN_GROUNDING_REVIEW` | 否 | `false` | 是否启用剧情回合的额外事实校验。 |
| `STORY_BODY_CONSISTENCY_REVIEW` | 否 | `true` | 是否在生成完整故事后执行一致性检查。 |
| `STORY_SESSION_STORE_PATH` | 否 | `backend/data/story-sessions.json` | 自定义本地故事会话存储路径。 |

## 项目结构

```text
.
├── backend/              # Express API、通义千问调用与故事会话存储
│   ├── src/
│   ├── scripts/
│   └── .env.example
├── frontend/             # React + Vite 用户界面
│   └── src/
├── shared/               # 前后端共享的数据契约与类型
└── README.md
```

## 本地数据与 Git

- `backend/data/story-sessions.json` 保存本地创作会话，由后端首次写入时自动创建，已被 Git 忽略。
- `node_modules/`、构建产物、日志和 `.env` 均不应提交。
- `package-lock.json`、源代码、共享类型与 `.env.example` 应提交，确保其他开发者可复现运行环境。

## 常见问题

**页面提示无法连接故事服务**

确认后端已在 `8787` 端口运行，并访问 `http://127.0.0.1:8787/health` 检查服务状态。若修改了 `PORT`，还需要修改 `frontend/vite.config.ts` 中的代理端口。

**接口提示尚未配置 Qwen API Key**

确认 `backend/.env` 存在、变量名为 `DASHSCOPE_API_KEY`，然后重启后端开发服务。健康检查中的 `configured` 应为 `true`。

**PowerShell 无法运行 npm**

使用 `npm.cmd install`、`npm.cmd run dev` 等带 `.cmd` 的命令；这是 PowerShell 执行策略造成的，不影响项目本身。
