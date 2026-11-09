'use strict';

/**
 * 重写中控台内容:最近文章 + 标签 + 归档/关于入口。
 * 主题默认的中控台是「评论卡 + 固定宽高的标签/归档卡」,没接评论、
 * 文章又少时整块面板既空又死板。这里直接用站点数据拼一块宽幅面板。
 */

const ICON_CLOCK = `<svg class="console-tile-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const ICON_TAG = `<svg class="console-tile-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>`;
const ICON_ARROW = `<svg class="console-tile-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

const MAX_POSTS = 5;
const MAX_TAGS = 24;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function plainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(post) {
  const text = plainText(post.excerpt || post.content);
  if (!text) return '';
  return text.length > 72 ? `${text.slice(0, 72).trimEnd()}…` : text;
}

function renderPostRow(post, index, urlFor) {
  const title = escapeHtml(post.title || '(无标题)');
  const excerpt = escapeHtml(excerptOf(post));
  const excerptHtml = excerpt ? `<span class="console-post-excerpt">${excerpt}</span>` : '';
  return `<li><a href="${urlFor(post.path)}">
    <span class="console-post-index">${String(index + 1).padStart(2, '0')}</span>
    <span class="console-post-main">
      <span class="console-post-title">${title}</span>
      ${excerptHtml}
    </span>
    <time class="console-post-date">${post.date.format('MM-DD')}</time>
  </a></li>`;
}

function renderTagPill(tag, urlFor) {
  return `<a href="${urlFor(tag.path)}">${escapeHtml(tag.name)}<sup>${tag.count}</sup></a>`;
}

function buildConsoleHtml(posts, tags, urlFor, site) {
  const postCount = posts.length;
  const recent = posts.slice(0, MAX_POSTS);
  const topTags = tags.slice(0, MAX_TAGS);

  const postList = recent.length
    ? `<ol class="console-post-list">${recent.map((post, i) => renderPostRow(post, i, urlFor)).join('')}</ol>`
    : '<p class="console-tile-empty">还没有发布文章。</p>';

  const tagPills = topTags.length
    ? topTags.map(tag => renderTagPill(tag, urlFor)).join('')
    : '<span class="console-tile-empty">还没有标签。</span>';

  return `<div class="console-card-group"><div class="console-panel">
  <div class="console-panel-head">
    <div class="console-panel-heading">
      <span class="console-panel-title">中控台</span>
      <span class="console-panel-meta">${postCount} 篇文章 · ${tags.length} 个标签</span>
    </div>
    <span class="console-panel-site">${escapeHtml(site.title || '')}</span>
  </div>
  <div class="console-panel-grid">
    <section class="console-tile console-tile-posts">
      <div class="console-tile-head">${ICON_CLOCK}<span>最近写</span></div>
      ${postList}
    </section>
    <section class="console-tile console-tile-tags">
      <div class="console-tile-head">${ICON_TAG}<span>标签</span></div>
      <div class="console-tag-pills">${tagPills}</div>
    </section>
    <a class="console-tile console-tile-link console-tile-archive" href="${urlFor('archives/')}">
      <span class="console-stat">${postCount}</span>
      <span class="console-stat-text"><strong>篇文章</strong><em>按分类浏览</em></span>
      ${ICON_ARROW}
    </a>
    <a class="console-tile console-tile-link console-tile-about" href="${urlFor('about/')}">
      <span class="console-tile-label">关于</span>
      <span class="console-tile-desc">${escapeHtml(site.subtitle || site.description || '')}</span>
      ${ICON_ARROW}
    </a>
  </div>
</div></div>`;
}

hexo.extend.filter.register('after_render:html', function (str, data) {
  if (!data || !data.path) {
    return str;
  }

  const root = (this.config.root || '/').replace(/\/?$/, '/');
  const urlFor = path => encodeURI(root + String(path).replace(/^\/+/, ''));

  const consoleStart = str.indexOf('<div id="console">');
  const groupStart = str.indexOf('<div class="console-card-group">', consoleStart);
  const groupEnd = str.indexOf('<div class="button-group">', groupStart);
  if (consoleStart === -1 || groupStart === -1 || groupEnd === -1) {
    return str;
  }

  const posts = this.locals.get('posts').toArray()
    .filter(post => post.published !== false)
    .sort((a, b) => b.date.valueOf() - a.date.valueOf());

  const tagMap = new Map();
  posts.forEach(post => {
    const postTags = post.tags && post.tags.toArray ? post.tags.toArray() : [];
    postTags.forEach(tag => {
      const key = tag.path || tag.name;
      if (!tagMap.has(key)) {
        tagMap.set(key, { name: tag.name, path: tag.path, count: 0 });
      }
      tagMap.get(key).count += 1;
    });
  });
  const tags = [...tagMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));

  const site = this.config;
  return str.slice(0, groupStart) + buildConsoleHtml(posts, tags, urlFor, site) + str.slice(groupEnd);
});
