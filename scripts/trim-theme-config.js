'use strict';

/**
 * 主题默认配置里的数组会按索引和用户配置合并:
 * 用户少写几项时,尾部的默认项会残留(例如首页分类块多出一个「生活」)。
 * 这里在生成前把合并后的数组截断到用户实际配置的长度。
 */

hexo.extend.filter.register('before_generate', function () {
  const userConfig = this.config.theme_config;
  const themeConfig = this.theme.config;
  if (!userConfig || !themeConfig) return;

  const trim = (themeValue, userValue) => {
    if (Array.isArray(themeValue) && Array.isArray(userValue) && themeValue.length > userValue.length) {
      themeValue.length = userValue.length;
    }
  };

  trim(
    themeConfig.home_top && themeConfig.home_top.category,
    userConfig.home_top && userConfig.home_top.category
  );
});
