# Mia 的技术博客

Hexo + Butterfly 主题,部署在 GitHub Pages。

## 写新文章

1. 在 `source/_posts/` 里新建 `.md` 文件(或 `hexo new "标题"`)
2. 提交并推送:

```bash
git add -A
git commit -m "文章: 标题"
git push
```

推送后 GitHub Actions 会自动构建并发布,约 1 分钟后线上可见。
线上地址:https://ava051213.github.io/

## 本地预览

```bash
npm run server   # http://localhost:4000
```

## 注意

- `public/`、`node_modules/`、`db.json` 均不需要提交(已在 .gitignore)
- 主题通过 npm 安装(`hexo-theme-butterfly`),主题配置在根目录 `_config.butterfly.yml`
- 不再需要手动 `hexo clean && hexo g && hexo d`,push 即发布
