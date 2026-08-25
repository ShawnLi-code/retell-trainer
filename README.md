# 复述训练场

每天一张高质量内容卡 → 开口复述 → AI 当听众追问 → 收尾报告 + 词库沉淀。

## 启动

```bash
npm install
# 复制 .env.example 为 .env，填入 LLM_API_KEY（DeepSeek 等 OpenAI 兼容接口）
npm start
```

打开 http://localhost:3025 （默认端口 3025，可在 .env 改 PORT）。

> 没有配置 .env 时服务也能启动，但练习页的 AI 追问会提示"请检查 LLM 配置"。

## 使用流程

1. 卡片库页：手动添加一张卡，或用"AI 按主题生成"
2. 首页点"开始练习" → 读卡 → 点"开始复述"用语音转写（或直接打字）→ "讲完了"
3. AI 听众追问漏掉的要点，直到说清楚（最多 6 轮）
4. 收尾报告：要点总结 + 用词反馈，替换词自动进词库
5. 词库页、历史页随时回看

## 内容供给（两个现成入口）

- **内置 10 张经典卡**：项目已自带种子卡片（愚公移山、塞翁失马、田忌赛马、背影节选等，公共领域）。清库后想恢复：
  ```bash
  node seed_cards.js
  ```
- **一键抓料**（从 RSS 抓正文 → AI 筛选 → 自动入库）：
  ```bash
  node --env-file-if-exists=.env fetch_cards.js            # 抓取并入库
  node --env-file-if-exists=.env fetch_cards.js --dry-run  # 只看筛选结果
  ```
  源在 `fetch_cards.js` 顶部的 `FEEDS` 里增删；长期使用建议自建 RSSHub（`docker run -p 1200:1200 diygod/rsshub`）并启用 `localhost:1200` 的路由。未配置 Key 时脚本会跳过 AI 筛选直接入库。

## 调优

- 提示词全部在 `prompts.js`，改这里不动代码
- 追问轮数上限在 `server.js` 的 `MAX_TURNS`
