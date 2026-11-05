/** 稳定的 53 位字符串哈希，仅用于生成配置目录名 */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Windows 路径大小写不敏感：统一分隔符并转小写，避免同一个库生成两个目录 */
function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/**
 * 由数据库连接信息生成配置目录标识：
 * SQLite 按文件路径，MySQL 按 主机:端口/库名；
 * 同一目标每次启动得到相同值，不同库互不影响。
 */
export function profileKey(config) {
  if (!config) return '';
  if (config.type === 'mysql') {
    const mysql = config.mysql || {};
    const host = String(mysql.host || '').trim().toLowerCase();
    const port = Number(mysql.port) || 3306;
    const database = String(mysql.database || '').trim().toLowerCase();
    return `mysql-${cyrb53(`${host}:${port}/${database}`)}`;
  }
  const path = normalizePath(config.sqlite && config.sqlite.path);
  return path ? `sqlite-${cyrb53(path)}` : '';
}
