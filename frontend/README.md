# Story Lens 前端原型

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
2. 点击“开始展开”。
3. 在三个故事方向中选择一个，或点击“我有另一个方向”自行填写。
4. 继续选择激励事件和高潮结局，或自行填写头尾。
5. 浏览情境节点、冲突升级曲线和起承转合结构。
6. 在两处关键岔路中选择分支，或写下自己的选择。
7. 点击“生成完整剧情”，查看根据已选内容拼出的剧情和结构验证结果。

## 说明

- 目前所有故事提案、节点和验证结果都是模拟数据。
- 后续接入后端后，页面会把这些模拟数据替换为 HTTP API 返回的数据。
- 修改 `src/App.tsx` 后，Vite 会自动刷新浏览器页面。
