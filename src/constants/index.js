/** 交易所类型 */
export const Exchange = {
  STOCK_CN: 0,
  STOCK_US: 1,
  STOCK_HK: 2,
  FUTURES_CN: 3,
  FUTURES_OTHER: 4,
  CRYPTO: 5,
  FOREX: 6,
  INDEX: 7,
  FUND: 8,
  ETF: 9,
  BOND: 10,
};

/** 提醒状态 */
export const AlertState = {
  RANGE: '涨幅',
  PRICE: '价格',
};

/** 提醒触发方向 */
export const AlertTrigger = {
  GREATER: '大于',
  LESS: '小于',
  CROSSUP: '上穿',
  CROSSDOWN: '下穿',
};

/** 自选列表变更事件 */
export const MonitorEvent = {
  addWatchList: 'addWatchList',
  deleteWatchList: 'deleteWatchList',
  // 落库失败回滚：分组窗口据此恢复被同步剪掉的草稿内容
  rollbackWatchList: 'rollbackWatchList',
};

/** 跨窗口事件 */
export const StoreEvent = {
  REALTIME_EAST: 'REALTIME_EAST',
};

export const DetailPanel = {
  CHART: 'CHART',
  SETTING: 'SETTING',
};

/** 设置项变更事件 */
export const SettingEvent = {
  watchFieldsChange: 'watchFieldsChange',
  isEdgeFoldChange: 'isEdgeFoldChange',
  isOpenWithSystemChange: 'isOpenWithSystemChange',
  isFixWidthChange: 'isFixWidthChange',
  fixedWidthChange: 'fixedWidthChange',
  tableSizeChange: 'tableSizeChange',
  updownColorChange: 'updownColorChange',
  viewOpacityChange: 'viewOpacityChange',
  viewGrayChange: 'viewGrayChange',
  shortcutBossChange: 'shortcutBossChange',
};

/** 涨跌配色方案 */
export const UpdownColor = {
  redUpGreenDown: 'redUpGreenDown',
  redDownGreenUp: 'redDownGreenUp',
};

/** 设置页菜单 */
export const SettingMenu = {
  GENERAL: { id: '0', name: '通用设置' },
  VIEW: { id: '1', name: '显示设置' },
  SHORTCUT: { id: '2', name: '快捷键' },
};

/** 默认关注字段 */
export const defaultWatchFields = {
  price: true,
  range: true,
  price_diff: true,
  high: false,
  low: false,
  turn: true,
  macd: true,
  concept_l1: false,
  concept_l2: false,
  concept_ths: false,
  position_num: false,
  position_price: false,
  position_value: false,
  position_profit: false,
  position_profit_rate: false,
};
