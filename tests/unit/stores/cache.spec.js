import { beforeEach, describe, expect, it } from 'vitest';
import { useCacheStore } from '@/stores/cache';
import { concept, freshPinia, stock } from '../../helpers';

describe('cache store · 两级概念', () => {
  let cache;

  beforeEach(() => {
    freshPinia();
    cache = useCacheStore();
    cache.group = [
      concept(0, '自选', [stock('600519', '贵州茅台')]),
      concept(1, '行业', [], [concept(2, '白酒', [stock('000858', '五粮液')])]),
    ];
    cache.selectGroup = 0;
  });

  it('allConcepts 把一级和二级拍平', () => {
    expect(cache.allConcepts().map((g) => g.name)).toEqual(['自选', '行业', '白酒']);
  });

  it('findConceptById / findConceptByName 能命中二级概念', () => {
    expect(cache.findConceptById(2).name).toBe('白酒');
    expect(cache.findConceptByName('白酒').id).toBe(2);
    expect(cache.findConceptById(999)).toBeNull();
    expect(cache.findConceptByName('不存在')).toBeNull();
  });

  it('addConcept 新增一级概念，id 全局唯一且字段齐全', () => {
    expect(cache.addConcept('板块')).toBe(true);
    const created = cache.group.at(-1);
    expect(created).toMatchObject({
      name: '板块',
      id: 3,
      id_str: '3',
      symbols: [],
      children: [],
    });
    expect(cache.nextConceptId()).toBe(4);
  });

  it('概念名全局唯一：与一级或二级重名都会失败', () => {
    expect(cache.addConcept('行业')).toBe(false);
    expect(cache.addConcept('白酒')).toBe(false);
    expect(cache.group).toHaveLength(2);
  });

  it('自选（id=0）不能增加二级概念', () => {
    expect(cache.addSubConcept(0, '白酒2')).toBe(false);
    expect(cache.group[0].children).toEqual([]);
  });

  it('addSubConcept 在一级概念下新增二级概念', () => {
    expect(cache.addSubConcept(1, '啤酒')).toBe(true);
    expect(cache.group[1].children.map((c) => c.name)).toEqual(['白酒', '啤酒']);
    expect(cache.group[1].children[1].id_str).toBe('3');
  });

  it('二级概念同一一级概念下不可重名，不同一级概念之间可以重名', () => {
    expect(cache.addSubConcept(1, '白酒')).toBe(false);
    expect(cache.group[1].children).toHaveLength(1);

    cache.group.push(concept(3, '板块'));
    expect(cache.addSubConcept(3, '白酒')).toBe(true);
    expect(cache.group[2].children.map((c) => c.name)).toEqual(['白酒']);
  });

  it('moveSubConceptToParent 把二级概念移动到另一个一级概念末尾', () => {
    cache.group.push(concept(3, '板块', [], [concept(4, '水泥')]));
    expect(cache.moveSubConceptToParent(2, 3)).toBe(true);
    expect(cache.group[2].children.map((c) => c.id)).toEqual([4, 2]);
    expect(cache.group[1].children).toEqual([]);
    expect(cache.moveSubConceptToParent(2, 0)).toBe(false);
    expect(cache.moveSubConceptToParent(999, 3)).toBe(false);
  });

  it('moveSubConceptToParent 目标已有同名二级概念时不移动', () => {
    cache.group.push(concept(3, '板块', [], [concept(4, '白酒')]));
    expect(cache.moveSubConceptToParent(2, 3)).toBe(false);
    expect(cache.group[1].children.map((c) => c.id)).toEqual([2]);
  });

  it('二级概念不能再挂三级（最多两级）', () => {
    expect(cache.addSubConcept(2, '三级')).toBe(false);
    expect(cache.findConceptById(2).children || []).toHaveLength(0);
  });

  it('moveConcept 调整一级概念顺序，自选固定在最前', () => {
    cache.group.push(concept(3, '板块'));
    expect(cache.moveConcept(1, -1)).toBe(false);
    expect(cache.moveConcept(3, -1)).toBe(true);
    expect(cache.group.map((g) => g.id)).toEqual([0, 3, 1]);
    expect(cache.moveConcept(1, 1)).toBe(false);
  });

  it('moveSubConcept 只在所属一级概念内调整二级顺序', () => {
    cache.group[1].children.push(concept(3, '啤酒'));
    expect(cache.moveSubConcept(1, 3, -1)).toBe(true);
    expect(cache.group[1].children.map((c) => c.id)).toEqual([3, 2]);
    expect(cache.moveSubConcept(1, 3, -1)).toBe(false);
    expect(cache.moveSubConcept(1, 2, -1)).toBe(true);
    expect(cache.group[1].children.map((c) => c.id)).toEqual([2, 3]);
    expect(cache.moveSubConcept(999, 2, 1)).toBe(false);
  });

  it('changeGroupName 重命名二级概念：同组重名不生效，跨一级概念允许重名', () => {
    cache.group.push(concept(3, '板块', [], [concept(4, '水泥')]));
    cache.changeGroupName(2, '白酒改');
    expect(cache.findConceptById(2).name).toBe('白酒改');

    cache.group[1].children.push(concept(5, '啤酒'));
    cache.changeGroupName(2, '啤酒');
    expect(cache.findConceptById(2).name).toBe('白酒改');

    cache.changeGroupName(2, '水泥');
    expect(cache.findConceptById(2).name).toBe('水泥');
    expect(cache.findConceptById(4).name).toBe('水泥');

    cache.changeGroupName(1, '水泥');
    expect(cache.findConceptById(1).name).toBe('行业');
  });

  it('deleteGroup 删除一级概念会连带删除其二级概念', () => {
    cache.selectGroup = 2;
    cache.deleteGroup(1);
    expect(cache.allConcepts().map((g) => g.name)).toEqual(['自选']);
    expect(cache.selectGroup).toBe(0);
  });

  it('deleteGroup 删除二级概念只影响自身，并回落到首个一级概念', () => {
    cache.selectGroup = 2;
    cache.deleteGroup(2);
    expect(cache.group[1].children).toEqual([]);
    expect(cache.group).toHaveLength(2);
    expect(cache.selectGroup).toBe(0);
  });

  it('删除后选中项仍存在时保持选中不变', () => {
    cache.selectGroup = 2;
    cache.deleteGroup(0);
    // 自选不可删（界面上 disabled），这里只验证选中项存在时不被改写
    expect(cache.selectGroup).toBe(2);
  });

  it('addSymbol 按概念名命中二级概念，delSymbol 按概念 id 命中', () => {
    const zs = stock('600036');
    cache.addSymbol(zs, '白酒');
    expect(cache.findConceptByName('白酒').symbols.map((s) => s.symbol)).toEqual([
      '000858',
      '600036',
    ]);
    cache.addSymbol(zs, '白酒');
    expect(cache.findConceptByName('白酒').symbols).toHaveLength(2);
    cache.delSymbol(zs, 2);
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual(['000858']);
  });

  it('不同一级概念下有同名二级概念时，删除只作用于指定 id 的概念', () => {
    cache.group.push(concept(3, '板块', [], [concept(4, '白酒', [stock('601318')])]));
    cache.deleteSymbols([stock('601318')], 4);
    expect(cache.findConceptById(4).symbols).toEqual([]);
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual(['000858']);
  });

  it('copySymbols 把股票复制到目标二级概念', () => {
    cache.copySymbols([stock('600036')], '白酒');
    expect(cache.findConceptByName('白酒').symbols.map((s) => s.symbol)).toContain('600036');
    expect(cache.findConceptByName('自选').symbols).toHaveLength(1);
  });

  it('addSymbols 按 secid 去重后批量添加到二级概念', () => {
    const added = cache.addSymbols(
      [stock('600036'), stock('600036'), stock('601318')],
      2,
    );
    expect(added).toBe(2);
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual([
      '000858',
      '600036',
      '601318',
    ]);
    expect(cache.addSymbols([stock('000858')], 2)).toBe(0);
    expect(cache.addSymbols([stock('600036')], 999)).toBe(0);
  });

  it('deleteSymbols 批量删除', () => {
    cache.findConceptById(2).symbols.push(stock('600036'), stock('601318'));
    cache.deleteSymbols([stock('000858'), stock('600036')], 2);
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual(['601318']);
  });
});

describe('cache store · 设置与盈亏', () => {
  let cache;

  beforeEach(() => {
    freshPinia();
    cache = useCacheStore();
  });

  it('初始值', () => {
    expect(cache.group).toEqual([]);
    expect(cache.selectGroup).toBe(0);
    expect(cache.tableSize).toBe('small');
    expect(cache.fixedWidth).toBe(380);
    expect(cache.totoal_profit).toBe(0);
    expect(cache.shortcutBoss).toEqual(['Ctrl', 'Q']);
  });

  it('initSettings 同步设置项', () => {
    cache.initSettings({
      tableSize: 'default',
      updownColor: 'redDownGreenUp',
      viewOpacity: 20,
      viewGray: 30,
      watchFields: { price: false },
      isFixWidth: false,
      fixedWidth: 420,
      isEdgeFold: true,
      isOpenWithSystem: false,
      shortcutBoss: ['Alt', 'Q'],
    });
    expect(cache.tableSize).toBe('default');
    expect(cache.updownColor).toBe('redDownGreenUp');
    expect(cache.fixedWidth).toBe(420);
    expect(cache.watchFields).toEqual({ price: false });
  });

  it('updateProfit 写入四个盈亏字段', () => {
    cache.updateProfit({
      total_profit: 100,
      total_profit_rate: 0.1,
      today_profit: 10,
      today_profit_rate: 0.01,
    });
    expect(cache.totoal_profit).toBe(100);
    expect(cache.totoal_profit_rate).toBe(0.1);
    expect(cache.today_profit).toBe(10);
    expect(cache.today_profit_rate).toBe(0.01);
  });

  it('updateAlertQueue：首次入队、20 分钟内不重复、超时后再次提醒', () => {
    const now = Date.now();
    const alert = { secid: '1.600519', trigger: '大于', state: '价格', dt: now };

    expect(cache.updateAlertQueue([alert])).toHaveLength(1);
    expect(cache.alertQueue).toHaveLength(1);
    expect(cache.alertQueue[0]).toEqual({ data: alert });

    const repeat = { ...alert, dt: now + 1000 };
    expect(cache.updateAlertQueue([repeat])).toHaveLength(0);

    const later = { ...alert, dt: now + 1200001 };
    expect(cache.updateAlertQueue([later])).toHaveLength(1);
    expect(cache.alertQueue).toHaveLength(1);
  });

  it('updateAlertQueue：静默窗口外的旧记录会被清理，队列不会无限增长', () => {
    const now = Date.now();
    cache.alertQueue = [
      { data: { secid: '1.600519', trigger: '大于', state: '价格', dt: now - 1300000 } },
    ];
    expect(cache.updateAlertQueue([])).toEqual([]);
    expect(cache.alertQueue).toHaveLength(0);
  });
});
