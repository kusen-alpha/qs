import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Setup from '@/views/Setup.vue';

const mocks = vi.hoisted(() => ({
  state: {
    configured: false,
    saved: false,
    error: '',
    default_sqlite_path: 'C:\\data\\stocks.db',
    config: {
      type: 'sqlite',
      sqlite: { path: '' },
      mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: 'root' },
    },
  },
  replace: vi.fn(),
  initStores: vi.fn(),
  markConfigured: vi.fn(),
  setProfileId: vi.fn(),
  profileKey: vi.fn(),
  testDbConnection: vi.fn(),
  configureDb: vi.fn(),
  openDialog: vi.fn(),
  listSqliteFiles: vi.fn(),
  prepareSqlite: vi.fn(),
}));

vi.mock('@/utils/db', () => ({
  getDbSetupState: vi.fn(async () => mocks.state),
  testDbConnection: mocks.testDbConnection,
  configureDb: mocks.configureDb,
  listSqliteFiles: mocks.listSqliteFiles,
  prepareSqlite: mocks.prepareSqlite,
}));
vi.mock('@/utils/env', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
}));
vi.mock('@/utils/setup', () => ({ markConfigured: mocks.markConfigured }));
vi.mock('@/utils/file', () => ({ setProfileId: mocks.setProfileId }));
vi.mock('@/utils/profile', () => ({ profileKey: mocks.profileKey }));
vi.mock('@/stores', () => ({ initStores: mocks.initStores }));
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useRouter: () => ({ replace: mocks.replace }) };
});

function mountSetup() {
  return mount(Setup, { global: { plugins: [ElementPlus] } });
}

async function mountReady() {
  const wrapper = mountSetup();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.initStores.mockReset();
  mocks.markConfigured.mockReset();
  mocks.setProfileId.mockReset();
  mocks.profileKey.mockReset();
  mocks.profileKey.mockReturnValue('sqlite-abc123');
  mocks.testDbConnection.mockReset();
  mocks.configureDb.mockReset();
  mocks.openDialog.mockReset();
  mocks.openDialog.mockResolvedValue(null);
  mocks.listSqliteFiles.mockReset();
  mocks.listSqliteFiles.mockResolvedValue([]);
  mocks.prepareSqlite.mockReset();
  mocks.prepareSqlite.mockResolvedValue({ ok: true, message: '数据库已就绪' });
});

describe('Setup · 启动数据库配置向导', () => {
  it('默认选中 SQLite 并回填默认数据库文件路径', async () => {
    const wrapper = await mountReady();
    expect(wrapper.find('.setup-title').text()).toBe('初始化设置');
    expect(wrapper.find('input[type="radio"]').element.checked).toBe(true);
    const display = wrapper.find('.path-display');
    expect(display.text()).toBe('C:\\data\\stocks.db');
    expect(display.attributes('title')).toBe('C:\\data\\stocks.db');
  });

  it('右上角有关闭按钮', async () => {
    const wrapper = await mountReady();
    const close = wrapper.find('.close-button');
    expect(close.exists()).toBe(true);
    expect(close.attributes('title')).toBe('关闭');
  });

  it('选择按钮选择目录，目录中有 stocks.db 时直接使用', async () => {
    mocks.openDialog.mockResolvedValue('D:\\data\\qs');
    mocks.listSqliteFiles.mockResolvedValue(['old.db', 'stocks.db']);
    const wrapper = await mountReady();
    await wrapper.find('.path-pick-btn').trigger('click');
    await flushPromises();
    expect(mocks.openDialog).toHaveBeenCalledWith({ title: '选择数据库所在目录', directory: true });
    expect(mocks.listSqliteFiles).toHaveBeenCalledWith('D:\\data\\qs');
    expect(wrapper.find('.path-display').text()).toBe('D:\\data\\qs\\stocks.db');
    expect(mocks.prepareSqlite).toHaveBeenCalledWith('D:\\data\\qs\\stocks.db');
    expect(wrapper.find('.setup-feedback.info').text()).toBe('已使用目录中的 stocks.db');
  });

  it('目录中只有其它数据库文件时沿用第一个', async () => {
    mocks.openDialog.mockResolvedValue('D:\\data\\qs\\');
    mocks.listSqliteFiles.mockResolvedValue(['legacy.sqlite3']);
    const wrapper = await mountReady();
    await wrapper.find('.path-pick-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('.path-display').text()).toBe('D:\\data\\qs\\legacy.sqlite3');
    expect(mocks.prepareSqlite).toHaveBeenCalledWith('D:\\data\\qs\\legacy.sqlite3');
    expect(wrapper.find('.setup-feedback.info').text()).toBe('已使用目录中的 legacy.sqlite3');
  });

  it('空目录会立即新建 stocks.db 并提示', async () => {
    mocks.openDialog.mockResolvedValue('D:\\data\\empty');
    mocks.listSqliteFiles.mockResolvedValue([]);
    const wrapper = await mountReady();
    await wrapper.find('.path-pick-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('.path-display').text()).toBe('D:\\data\\empty\\stocks.db');
    expect(mocks.prepareSqlite).toHaveBeenCalledWith('D:\\data\\empty\\stocks.db');
    expect(wrapper.find('.setup-feedback.info').text()).toBe('已新建 stocks.db');
  });

  it('新建数据库失败时显示后端返回的错误', async () => {
    mocks.openDialog.mockResolvedValue('D:\\data\\locked');
    mocks.prepareSqlite.mockResolvedValue({
      ok: false,
      message: 'SQLite 初始化失败: unable to open database file',
    });
    const wrapper = await mountReady();
    await wrapper.find('.path-pick-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('.setup-feedback.error').text()).toBe(
      'SQLite 初始化失败: unable to open database file',
    );
  });

  it('取消选择目录时保持原路径不变', async () => {
    const wrapper = await mountReady();
    await wrapper.find('.path-pick-btn').trigger('click');
    await flushPromises();
    expect(mocks.listSqliteFiles).not.toHaveBeenCalled();
    expect(wrapper.find('.path-display').text()).toBe('C:\\data\\stocks.db');
  });

  it('切换到 MySQL 后显示连接信息表单', async () => {
    const wrapper = await mountReady();
    await wrapper.findAll('input[type="radio"]')[1].setValue();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('主机 / 端口');
    expect(text).toContain('数据库名');
    expect(text).toContain('用户名');
    expect(text).toContain('密码');
    expect(text).not.toContain('（本地文件）');
    expect(text).not.toContain('（远程数据库）');
    expect(wrapper.find('.port-input input').element.value).toBe('3306');
  });

  it('SQLite 路径为空时提示校验错误，不调用保存接口', async () => {
    mocks.state.config.sqlite.path = '';
    mocks.state.default_sqlite_path = '';
    const wrapper = await mountReady();
    await wrapper.findAll('.setup-actions button')[1].trigger('click');
    await flushPromises();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(wrapper.find('.setup-feedback.error').text()).toContain('请选择 SQLite 数据库文件路径');
    mocks.state.default_sqlite_path = 'C:\\data\\stocks.db';
  });

  it('MySQL 缺少主机时提示错误', async () => {
    const wrapper = await mountReady();
    await wrapper.findAll('input[type="radio"]')[1].setValue();
    await flushPromises();
    await wrapper.findAll('.setup-form input')[0].setValue('');
    await wrapper.findAll('.setup-actions button')[0].trigger('click');
    await flushPromises();
    expect(mocks.testDbConnection).not.toHaveBeenCalled();
    expect(wrapper.find('.setup-feedback.error').text()).toContain('请填写主机和数据库名');
  });

  it('MySQL 用户名密码留空时仍可测试连接', async () => {
    mocks.testDbConnection.mockResolvedValue({ ok: true, message: '连接成功' });
    const wrapper = await mountReady();
    await wrapper.findAll('input[type="radio"]')[1].setValue();
    await flushPromises();
    await wrapper.findAll('.setup-form input')[3].setValue('');
    await flushPromises();
    await wrapper.findAll('.setup-actions button')[0].trigger('click');
    await flushPromises();
    expect(mocks.testDbConnection).toHaveBeenCalledWith({
      type: 'mysql',
      mysql: {
        host: '127.0.0.1',
        port: 3306,
        database: 'qushi',
        username: '',
        password: '',
      },
    });
    expect(wrapper.find('.setup-feedback.ok').text()).toBe('连接成功');
  });

  it('测试连接展示后端返回的信息', async () => {
    mocks.testDbConnection.mockResolvedValue({ ok: true, message: '连接成功' });
    const wrapper = await mountReady();
    await wrapper.findAll('.setup-actions button')[0].trigger('click');
    await flushPromises();
    expect(mocks.testDbConnection).toHaveBeenCalledWith({
      type: 'sqlite',
      sqlite: { path: 'C:\\data\\stocks.db' },
    });
    expect(wrapper.find('.setup-feedback.ok').text()).toBe('连接成功');
  });

  it('保存成功后才初始化 store 并进入主界面', async () => {
    mocks.configureDb.mockResolvedValue({ ok: true, message: '已初始化' });
    const wrapper = await mountReady();
    await wrapper.findAll('.setup-actions button')[1].trigger('click');
    await flushPromises();
    expect(mocks.configureDb).toHaveBeenCalledWith({
      type: 'sqlite',
      sqlite: { path: 'C:\\data\\stocks.db' },
    });
    expect(mocks.markConfigured).toHaveBeenCalledTimes(1);
    expect(mocks.profileKey).toHaveBeenCalledWith({
      type: 'sqlite',
      sqlite: { path: 'C:\\data\\stocks.db' },
    });
    expect(mocks.setProfileId).toHaveBeenCalledWith('sqlite-abc123');
    expect(mocks.initStores).toHaveBeenCalledTimes(1);
    expect(mocks.setProfileId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initStores.mock.invocationCallOrder[0],
    );
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/');
    expect(mocks.initStores.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replace.mock.invocationCallOrder[0],
    );
  });

  it('保存失败时停留在向导并展示错误', async () => {
    mocks.configureDb.mockResolvedValue({ ok: false, message: '建库失败' });
    const wrapper = await mountReady();
    await wrapper.findAll('.setup-actions button')[1].trigger('click');
    await flushPromises();
    expect(mocks.markConfigured).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(wrapper.find('.setup-feedback.error').text()).toBe('建库失败');
  });

  it('启动连接失败时展示警告条', async () => {
    mocks.state.error = 'MySQL 连接超时';
    const wrapper = await mountReady();
    expect(wrapper.find('.setup-alert').exists()).toBe(true);
    expect(wrapper.find('.setup-alert').text()).toContain('MySQL 连接超时');
    mocks.state.error = '';
  });
});
