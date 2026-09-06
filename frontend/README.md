# 时光川行青柠创作平台前端原型

这是 AI 故事创作产品的可点击前端原型。目前使用固定模拟数据，不会调用后端或真实 AI。

## 在 VS Code 中运行

1. 用 VS Code 打开项目文件夹：`E:\QingningComic\qingning-chuangzuo`
2. 点击顶部菜单的“终端” -> “新建终端”。
3. 输入以下命令进入前端目录：

```powershell
cd frontend
```

4. 第一次运行前，安装依赖：

```powershell
npm.cmd install
```

5. 启动网页：

```powershell
npm.cmd run dev
```

6. 终端会显示一个本地地址，通常是：

```text
http://localhost:5173/
```

按住 `Ctrl` 并点击该地址，或将它复制到浏览器地址栏打开。

## 如果 npm 命令报 PowerShell 权限错误

这台电脑的 PowerShell 可能会阻止 `npm` 脚本。请始终使用带 `.cmd` 的写法：

```powershell
npm.cmd install
npm.cmd run dev
```

不要使用：

```powershell
npm install
npm run dev
```

## 如何停止网页服务

在正在运行 `npm.cmd run dev` 的终端中按：

```text
Ctrl + C
```

## 当前可以验证的流程

1. 输入一句模糊想法，或点击“换个示例”。
2. 选择一个故事取向，点击“创建故事地图”。
3. 阅读当前剧情，并在三个带有明确收益和风险的行动中做出选择。
4. 观察选择立即写入故事地图、最新风险、线索和结构验证。
5. 随时撤销上一次选择，或写下一个自定义行动。
6. 完成四次关键选择后，查看当前路径的故事梗概与可定位的结构验证证据。

## 说明

- 目前故事提案、剧情文本和验证结果都是模拟数据，但选择会在前端状态中真实写入后续节点和结果页面。
- 后续接入后端后，页面会把这些模拟数据替换为 HTTP API 返回的数据。
- 修改 `src/App.tsx` 后，Vite 会自动刷新浏览器页面。
