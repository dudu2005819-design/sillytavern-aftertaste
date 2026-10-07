# Aftertaste · 余味 v0.1

面向 SillyTavern 1.14.0 的轻量长期 RP 关系状态扩展。

## 它做什么
- 不建立第二套全文记忆库。
- 每 N 楼只分析最近少量消息，把“事件留下的关系/心理结果”压缩成一个小状态。
- 生成前用 SillyTavern `setExtensionPrompt` 注入，默认硬预算约 400 tokens。
- 每个聊天独立保存状态。
- 可以查看/编辑当前状态和“本轮实际注入”。
- 删除/回退到已分析来源之前时，宁可清空余味要求重算，也不保留幽灵状态。

## API
v0.1 支持 OpenAI-compatible Chat Completions：
- API Base URL：可填 `https://站点地址` 或 `https://站点地址/v1`
- API Key
- Model ID

请求端点会自动组成 `/v1/chat/completions`。

注意：v0.1 是纯 UI Extension，API 请求由浏览器发出。如果公益站没有允许浏览器 CORS，请求会被浏览器拦截。遇到这种情况不要关闭浏览器安全机制；后续版本可改用安全代理/Server Plugin 方案。

## 推荐初始设置
- 每 N 楼分析：5
- 最近消息数：8
- 注入预算：400 tokens
- 注入深度：2
- 分析温度：0.2

## 安装
SillyTavern → 扩展 → 安装扩展 → 输入你上传本目录后的 Git 仓库 URL → `Install just for me`。

仓库根目录必须直接包含：
- `manifest.json`
- `index.js`
- `style.css`
- `README.md`

## 隐私/安全
- 日志不会打印 API Key。
- API Key 当前保存在 SillyTavern 扩展设置中；不要把自己的设置文件公开分享。
- 扩展只把“最近消息 + 当前余味状态”发送给你配置的分析 API，不会主动把一千多楼完整聊天发送过去。

## v0.1 已知限制
1. OpenAI-compatible API 必须允许浏览器跨域（CORS）。
2. token 数为字符近似值，不是模型 tokenizer 的精确计数；预算设计偏保守。
3. swipe/编辑后的精确增量回滚在 v0.1 采取保守策略；消息回退越过状态来源时直接清空当前余味，避免幽灵记忆。
4. 当前不会读取其他记忆插件的内部数据库，以避免耦合和重复召回。
