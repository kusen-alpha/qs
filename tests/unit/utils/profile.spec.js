import { describe, expect, it } from 'vitest';
import { profileKey } from '@/utils/profile';

describe('数据库配置目录标识 · profileKey', () => {
  it('SQLite 同一路径忽略大小写与分隔符差异，得到相同标识', () => {
    const a = profileKey({ type: 'sqlite', sqlite: { path: 'C:\\Data\\stocks.db' } });
    const b = profileKey({ type: 'sqlite', sqlite: { path: 'c:/data/stocks.db/' } });
    expect(a).toBe(b);
    expect(a).toMatch(/^sqlite-/);
  });

  it('不同 SQLite 文件生成不同标识', () => {
    const a = profileKey({ type: 'sqlite', sqlite: { path: 'C:\\a.db' } });
    const b = profileKey({ type: 'sqlite', sqlite: { path: 'C:\\b.db' } });
    expect(a).not.toBe(b);
  });

  it('空路径或空配置返回空标识', () => {
    expect(profileKey({ type: 'sqlite', sqlite: { path: '   ' } })).toBe('');
    expect(profileKey(null)).toBe('');
  });

  it('MySQL 按 主机:端口/库名 生成标识，用户名与密码不影响', () => {
    const a = profileKey({
      type: 'mysql',
      mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: 'root', password: 'x' },
    });
    const b = profileKey({
      type: 'mysql',
      mysql: { host: '127.0.0.1', port: '3306', database: 'QUSHI', username: 'other' },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^mysql-/);
  });

  it('MySQL 不同库名生成不同标识', () => {
    const a = profileKey({ type: 'mysql', mysql: { host: 'h', port: 3306, database: 'a' } });
    const b = profileKey({ type: 'mysql', mysql: { host: 'h', port: 3306, database: 'b' } });
    expect(a).not.toBe(b);
  });
});
