import { loreColumn } from '../../../scripts/news-lore.mjs';

// 正史板块：lore 站文章（格式见 scripts/news-lore.mjs）。上级 news.11tydata.js 的计算字段照样生效，这里覆盖不适用的几项。
export default {
  layout: 'lore.njk',
  eleventyComputed: {
    permalink: d => `/lore/${d.page.fileSlug}/`,
    newsCat: () => null,
    sourceZh: () => null,
    loreColumn: d => loreColumn(d.column),
  },
};
