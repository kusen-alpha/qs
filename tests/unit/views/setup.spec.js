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
  testDbConnection: vi.fn(),
  configureDb: vi.fn(),
}));

vi.mock('@/utils/db', () => ({
  getDbSetupState: vi.fn(async () => mocks.state),
  testDbConnection: mocks.testDbConnection,
  configureDb: mocks.configureDb,
}));
vi.mock('@/utils/setup', () => ({ markConfigured: mocks.markConfigured }));
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
  mocks.testDbConnection.mockReset();
  mocks.configureDb.mockReset();
});

describe('Setup · 首次启动数据库配置向导', () => {
  it('默认选中 SQLite 并回填默认数据库文件路径', async () => {
    const wrapper = await mountReady();
    expect(wrapper.find('.setup-title').text()).toBe('初始化设置');
    expect(wrapper.find('input[type="radio"]').element.checked).toBe(true);
    expect(wrapper.find('.path-row input').element.value).toBe('C:\\data\\stocks.db');
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
    expect(wrapper.find('.port-input input').element.value).toBe('3306');
  });

  it('SQLite 路径为空时提示校验错误，不调用保存接口', async () => {
    const wrapper = await mountReady();
    await wrapper.find('.path-row input').setValue('   ');
    await wrapper.findAll('.setup-actions button')[1].trigger('click');
    await flushPromises();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(wrapper.find('.setup-feedback.error').text()).toContain('请选择 SQLite 数据库文件路径');
  });

  it('MySQL 缺少必填项时提示错误', async () => {
    const wrapper = await mountReady();
    await wrapper.findAll('input[type="radio"]')[1].setValue();
    await flushPromises();
    await wrapper.findAll('.setup-form input')[0].setValue('');
    await wrapper.findAll('.setup-actions button')[0].trigger('click');
    await flushPromises();
    expect(mocks.testDbConnection).not.toHaveBeenCalled();
    expect(wrapper.find('.setup-feedback.error').text()).toContain('请填写主机、数据库名和用户名');
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
    expect(mocks.initStores).toHaveBeenCalledTimes(1);
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
