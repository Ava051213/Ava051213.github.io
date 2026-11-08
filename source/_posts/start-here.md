---
title: 开始写笔记吧 — 使用指南
date: 2026-11-08 12:00:00
tags:
  - 使用指南
categories:
  - 指南
math: true
---

欢迎来到你的小站。这篇是使用指南,等你写了几篇真实笔记之后,**随时可以删除它**(它只是一篇普通的 Markdown 文件)。

## 写一篇新笔记的三步

1. 在 `D:/Develop/my-blog/source/_posts/` 里新建一个 `.md` 文件(建议英文文件名,URL 会用到)
2. 文件开头写上 front matter:

```markdown
---
title: 笔记标题
date: 2026-11-08 12:00:00
tags:
  - 标签
categories:
  - 分类
math: true
---
```

3. 提交推送,约 1 分钟后自动上线:

```bash
git add -A && git commit -m "Add post: 标题" && git push
```

## 写作能力速查

- **代码块**:三个反引号 + 语言名,自带高亮和复制按钮
- **数学公式**:`$...$` 行内,`$$...$$` 独立成行(KaTeX 已开启)
- **本地预览**:`npx hexo server`,浏览器打开 `http://localhost:4000`

## 小习惯

- 文章里写死 `date:`,URL 就永远不会变
- 标签用小写英文或中文都行,分类建议最多一级
