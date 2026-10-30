/**
 * 原产物 y1()：给若干选择器批量加 data-tauri-drag-region，
 * 让无边框窗口在表格 / 卡片区域都能拖动。
 */
export function applyDragRegion(selectors) {
  const list = [
    'el-card__body',
    'el-card',
    'el-tabs__nav-scroll',
    'el-header',
    'header-row',
    'head-border',
    'group-footer',
    'el-table__cell',
    'cell',
    'el-table__empty-block',
    'el-table__empty-text',
    'el-tabs__nav-scroll',
    'el-col',
  ];
  const all = selectors && selectors.length ? selectors : list;
  for (const selector of all) {
    const nodes = document.getElementsByClassName(selector);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('data-tauri-drag-region', 'true');
    }
  }
}

/** 原产物 xt()：按显示字段和表格尺寸计算固定宽度 */
export function calcTableWidth(offsetWidth, offsetHeight, fields, tableSize) {
  const narrow = ['price', 'high', 'low', 'position_num', 'position_price', 'position_profit'];
  let width = 75;
  for (const key in fields) {
    if (narrow.includes(key) && fields[key]) {
      width += tableSize === 'small' ? 62 : tableSize === 'default' ? 72 : 82;
    } else if (!narrow.includes(key) && fields[key]) {
      width += tableSize === 'small' ? 76 : tableSize === 'default' ? 86 : 96;
    }
  }
  let total = width + 10;
  if (total < 300) total = 300;
  return total;
}
