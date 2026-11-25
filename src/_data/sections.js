// 内容板块：页眉导航按此顺序列出，group 区分玩家野史与官方内容，以细竖线分隔。
// collection：eleventy.config.js 里的集合名；集合为空时不进导航（板块搭好、还没写内容时不露空页）。
export default [
  { name: '列传', url: '/', collection: 'people', accent: 'gold', group: 'yeshi' },
  { name: '战役', url: '/battles/', collection: 'battles', accent: 'blue', group: 'yeshi' },
  { name: '军团', url: '/corps/', collection: 'corps', accent: 'zhu', group: 'yeshi' },
  { name: '天书', url: '/news/', collection: 'news', accent: 'tianshu', group: 'official' },
  { name: '正史', url: '/lore/', collection: 'lore', accent: 'lore', group: 'official' },
  { name: '折扣', url: '/deals/', collection: 'deals', accent: 'deals', group: 'official' },
];
