'use strict';

/**
 * 把 /archives/ 的默认时间线替换成按分类分组的文件夹视图。
 * 数据直接取自 Hexo 的文章集合,新增分类/文章后无需手动维护。
 */

const FOLDER_ICON = `<svg class="folder-archive-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" fill="#f3e2bf" stroke="#c99a4a" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

const CHEVRON_ICON = `<svg class="folder-archive-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function urlFor(path) {
  return encodeURI('/' + String(path).replace(/^\/+/, ''));
}

function postDate(post) {
  return post.date.format('YYYY-MM-DD');
}

function renderPost(post) {
  return `<li class="folder-archive-post"><a href="${urlFor(post.path)}"><span class="folder-archive-post-title">${escapeHtml(post.title || '(无标题)')}</span><time class="folder-archive-post-date">${postDate(post)}</time></a></li>`;
}

function renderFolder(folder) {
  return `<details class="folder-archive-item">
  <summary class="folder-archive-head">
    ${FOLDER_ICON}
    <span class="folder-archive-name">${escapeHtml(folder.name)}</span>
    <span class="folder-archive-count">${folder.posts.length} 篇</span>
    ${CHEVRON_ICON}
  </summary>
  <ul class="folder-archive-posts">
    ${folder.posts.map(renderPost).join('')}
  </ul>
</details>`;
}

function buildArchiveHtml(posts) {
  const folders = new Map();

  posts.forEach(post => {
    const categories = post.categories && post.categories.toArray ? post.categories.toArray() : [];
    const entries = categories.length ? categories : [{ name: '未分类', path: null }];
    entries.forEach(category => {
      const key = category.path || category.name;
      if (!folders.has(key)) {
        folders.set(key, { name: category.name, posts: [] });
      }
      folders.get(key).posts.push(post);
    });
  });

  // 最近有更新的分类排前面
  const list = [...folders.values()].sort((a, b) => {
    const diff = b.posts[0].date.valueOf() - a.posts[0].date.valueOf();
    return diff || a.name.localeCompare(b.name, 'zh-CN');
  });

  const body = list.length
    ? list.map(renderFolder).join('')
    : '<p class="folder-archive-empty">还没有发布文章。</p>';

  return `<div class="folder-archive">
  <h1 class="folder-archive-title">归档</h1>
  <p class="folder-archive-hint">共 ${list.length} 个文件夹、${posts.length} 篇文章 · 点击展开</p>
  ${body}
</div>`;
}

function redirectPage(target) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>归档</title>
  <link rel="canonical" href="${target}">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0;url=${target}">
  <script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
  <p>正在前往 <a href="${target}">归档</a>…</p>
</body>
</html>`;
}

hexo.extend.filter.register('after_render:html', function (str, data) {
  // 年份/月份归档页已经没有用了,直接回 /archives/ 的文件夹视图
  if (data && /^archives\/\d{4}(\/\d{2})?\/index\.html$/.test(data.path)) {
    const root = (this.config.root || '/').replace(/\/?$/, '/');
    return redirectPage(encodeURI(root + 'archives/'));
  }

  // 只处理 /archives/ 第一页
  if (!data || data.path !== 'archives/index.html') {
    return str;
  }

  const startMarker = '<div id="archive">';
  const asideMarker = '<div class="aside-content" id="aside-content">';
  const start = str.indexOf(startMarker);
  const aside = str.indexOf(asideMarker);
  if (start === -1 || aside === -1 || aside < start) {
    return str;
  }

  const posts = this.locals.get('posts').toArray()
    .filter(post => post.published !== false)
    .sort((a, b) => b.date.valueOf() - a.date.valueOf());

  const archiveHtml = `<div id="archive">${buildArchiveHtml(posts)}</div>`;
  return str.slice(0, start) + archiveHtml + str.slice(aside);
});
