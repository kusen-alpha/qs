import { beforeEach, describe, expect, it } from 'vitest';
import { applyDragRegion, calcTableWidth } from '@/utils/layout';

describe('layout · 拖拽区域与表格宽度', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('applyDragRegion 默认选择器都打上 data-tauri-drag-region', () => {
    document.body.innerHTML =
      '<div class="el-card"></div><div class="cell"></div><div class="el-col"></div>';
    applyDragRegion();
    for (const selector of ['.el-card', '.cell', '.el-col']) {
      expect(
        document.querySelector(selector).getAttribute('data-tauri-drag-region'),
      ).toBe('true');
    }
  });

  it('applyDragRegion 只处理自定义选择器', () => {
    document.body.innerHTML = '<div class="custom-drag"></div><div class="el-card"></div>';
    applyDragRegion(['custom-drag']);
    expect(
      document.querySelector('.custom-drag').getAttribute('data-tauri-drag-region'),
    ).toBe('true');
    expect(
      document.querySelector('.el-card').getAttribute('data-tauri-drag-region'),
    ).toBeNull();
  });

  it('calcTableWidth 最小宽度 300', () => {
    expect(calcTableWidth(100, 100, {}, 'small')).toBe(300);
    expect(calcTableWidth(0, 0, { price: true, name: false }, 'small')).toBe(300);
  });

  it('small 尺寸：窄字段 62，其余字段 76', () => {
    const fields = { price: true, high: true, name: true, range: true };
    expect(calcTableWidth(0, 0, fields, 'small')).toBe(75 + 62 + 62 + 76 + 76 + 10);
  });

  it('default / large 尺寸累加更多', () => {
    const fields = { price: true, name: true, range: true };
    expect(calcTableWidth(0, 0, fields, 'default')).toBe(75 + 72 + 86 + 86 + 10);
    expect(calcTableWidth(0, 0, fields, 'large')).toBe(75 + 82 + 96 + 96 + 10);
  });
});
