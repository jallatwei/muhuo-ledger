/**
 * 路由链接静态校验
 * ============================================================
 * 为什么需要这个检查：
 *
 *   前端跳转写错路径是个**静默失败**：
 *     点了按钮 → URL 变了 → 页面一片空白。
 *   用户会理解成"这个功能没做"，排查方向从一开始就偏了。
 *   实际发生过一次：发票仓库的「去导入单据」跳 `/recognition`，
 *   而真实路由是 `/vouchers/recognition`。
 *
 *   这类错误 TypeScript 查不出来（字符串就是字符串），
 *   跑起来也不报错，只有人点到才发现。
 *   所以在构建期做一次静态扫描：把代码里所有字面量路径
 *   拿去和路由表比对，对不上就直接失败。
 *
 * 检查三类写法：
 *   ① router.push('/literal')
 *   ② router.push({ name: 'x' })   → 校验 name 存在
 *   ③ <el-menu-item index="/literal">  → 侧边栏菜单项
 *   ④ router.push({ path: '/literal' })
 *
 * 用法：node tools/check-routes.mjs      （退出码非 0 表示有错）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, '../apps/web/src');

/**
 * 兜底路由（`/:pathMatch(.*)*`）不算有效目标。
 *
 * ★ 从字面上它能匹配**任何**路径，如果把它算进可匹配集合，
 *   这个检查器就永远报不出错 —— 写错的路径也会被认成合法路由。
 *   兜底路由的语义恰恰是"这里没有真正的路由"。
 */
const isCatchAll = (p) => p.includes('*') || p.includes('pathMatch');

// ── 1. 从路由表提取「声明的路径」与「命名路由」 ────────────────────────────
//
// ★ 为什么不再用正则抓 `path: '...'`：
//   路由现在是**嵌套**的（登录页与主界面各套一层布局），
//   子路由写的是相对路径 `'vouchers/new'`，它本身不是可访问的 URL。
//   正则抓出来的是 `vouchers/new`、`dashboard` 这类片段，
//   跟真实的 `/vouchers/new`、`/dashboard` 对不上 —— 检查器会全线误报。
//   所以这里改成把 routes 数组**真的求值**一遍，再按父子关系拼出完整路径。
//
//   求值的安全性：文件是我们自己的源码，且在构建期本地执行；
//   组件用 `() => import(...)` 在求值时不会触发，import 语句被剔除。
const routerFile = join(webSrc, 'router/index.ts');
const routerSrc = readFileSync(routerFile, 'utf8');

/** 把路由表求值成真实数组（component 等字段置空，只保留路径结构） */
function evaluateRoutes(src) {
  const start = src.indexOf('const routes');
  if (start < 0) throw new Error('router/index.ts 里找不到 `const routes`，检查脚本需要同步更新');

  const eq = src.indexOf('=', start);
  const open = src.indexOf('[', eq);
  if (open < 0) throw new Error('`const routes` 后面没有找到数组字面量');

  // 括号配平地截取整个数组字面量
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('routes 数组没有闭合的 ]');

  const literal = src
    .slice(open, end + 1)
    // 动态 import 不求值，替换成占位函数，读起来仍是合法的 JS
    .replace(/\(\)\s*=>\s*import\([^)]*\)/g, '() => null');

  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

/**
 * 把嵌套路由展开成完整路径集合。
 *
 * 注意子路由的路径是**相对**父级的：父 '/' + 子 'vouchers/new' = '/vouchers/new'。
 * 绝对子路径（以 / 开头）要直接采用，这是 vue-router 的规则。
 */
function flattenRoutes(list, parentPath = '', out = { paths: [], names: [] }) {
  for (const r of list) {
    if (!r || typeof r.path !== 'string') continue;

    const full = r.path.startsWith('/')
      ? r.path
      : `/${[parentPath, r.path].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/');

    /*
     * ★ 必须把「兜底路由」排除在可匹配集合之外：
     *   `/:pathMatch(.*)*` 从字面上能匹配**任何**路径，如果把它算进去，
     *   这个检查器就永远报不出错 —— 它会把写错的路径也认成合法路由。
     *   兜底路由的语义恰恰是"这里没有真正的路由"，不能当有效目标。
     */
    if (!isCatchAll(full)) out.paths.push(full.replace(/\/$/, '') || '/');
    if (typeof r.name === 'string') out.names.push(r.name);

    if (Array.isArray(r.children)) flattenRoutes(r.children, full, out);
  }
  return out;
}

const flattened = flattenRoutes(evaluateRoutes(routerSrc));
const declaredPaths = new Set(flattened.paths);
const declaredNames = new Set(flattened.names);

if (declaredPaths.size === 0) {
  console.error('✗ 没能从 router/index.ts 里解析出任何路由 —— 检查脚本的正则是否过时');
  process.exit(1);
}

// 动态段（:id）与通配段用于匹配真实链接
function pathMatches(link) {
  if (declaredPaths.has(link)) return true;

  for (const decl of declaredPaths) {
    if (!decl.includes(':')) continue;
    if (isCatchAll(decl)) continue;
    // 把 :param 换成"匹配一段非斜杠字符"来比对
    const re = new RegExp(
      '^' + decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[^/]+/g, '[^/]+') + '$',
    );
    if (re.test(link)) return true;
  }
  return false;
}

/**
 * 链接清洗：`/login?redirect=/x` 与 `/x#frag` 的真实路由部分只有 `/login`。
 * 不剥掉查询串的话，凡带参数的跳转都会被误报成"路由不存在"。
 */
function routePartOf(link) {
  return link.split('?')[0].split('#')[0] || '/';
}

// ── 2. 扫描所有源文件里的跳转写法 ──────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(vue|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

const problems = [];
let checkedPaths = 0;
let checkedNames = 0;

for (const file of walk(webSrc)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(webSrc, file).replace(/\\/g, '/');

  // ① router.push('/x') / router.replace('/x')
  for (const m of src.matchAll(/router\.(?:push|replace)\(\s*'(\/[^']*)'/g)) {
    const link = m[1];
    checkedPaths += 1;
    if (!pathMatches(routePartOf(link))) {
      problems.push({ file: rel, kind: '路径', value: link, hint: '没有匹配的路由声明' });
    }
  }

  // ② router.push({ name: 'x' })
  for (const m of src.matchAll(/router\.(?:push|replace)\(\s*\{\s*name:\s*'([^']+)'/g)) {
    const name = m[1];
    checkedNames += 1;
    if (!declaredNames.has(name)) {
      problems.push({ file: rel, kind: '命名路由', value: name, hint: 'name 不存在' });
    }
  }

  // ③ router.push({ path: '/x' })
  for (const m of src.matchAll(/router\.(?:push|replace)\(\s*\{\s*path:\s*'(\/[^']*)'/g)) {
    const link = m[1];
    checkedPaths += 1;
    if (!pathMatches(routePartOf(link))) {
      problems.push({ file: rel, kind: '路径', value: link, hint: '没有匹配的路由声明' });
    }
  }

  // ④ 侧边栏菜单项 index="/x"（el-menu-item / el-sub-menu）
  for (const m of src.matchAll(/<el-(?:menu-item|sub-menu)[^>]*\bindex="(\/[^"]*)"/g)) {
    const link = m[1];
    checkedPaths += 1;
    if (!pathMatches(routePartOf(link))) {
      problems.push({ file: rel, kind: '菜单项', value: link, hint: '菜单指向不存在的路由' });
    }
  }
}

// ── 3. 反向检查：声明了但从未被引用的路由（只提示，不算失败） ──────────────
const allSrc = walk(webSrc)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const unreferenced = [...declaredPaths].filter((p) => {
  if (p.includes(':') || isCatchAll(p) || p === '/') return false;
  // 菜单或跳转里出现过即可
  return !allSrc.includes(`'${p}'`) && !allSrc.includes(`"${p}"`);
});

// ── 4. 输出 ────────────────────────────────────────────────────────────────
console.log('路由链接检查');
console.log(`  路由声明    : ${declaredPaths.size} 条路径 / ${declaredNames.size} 个命名路由`);
console.log(`  检查链接    : ${checkedPaths} 处路径 + ${checkedNames} 处命名路由`);

if (unreferenced.length > 0) {
  console.log(`  ⚠ 未被任何菜单或跳转引用的路由（仅提示）: ${unreferenced.join(', ')}`);
}

if (problems.length === 0) {
  console.log('  ✓ 全部链接都能匹配到路由\n');
  process.exit(0);
}

console.error(`\n✗ 发现 ${problems.length} 处链接指向不存在的路由：\n`);
for (const p of problems) {
  console.error(`  ${p.file}`);
  console.error(`    ${p.kind}: ${p.value}  →  ${p.hint}`);
}
console.error(
  '\n这类错误 TypeScript 查不出来、运行也不报错，只有用户点到才发现（页面空白）。',
);
console.error('修掉它，或者把目标路由加到 apps/web/src/router/index.ts。\n');
process.exit(1);
