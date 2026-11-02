# AGENTS.md

## 项目概览

- 桌面端行情/自选工具：Tauri v2（Windows）+ Vue 3 + Pinia，构建工具 Vite 4。
- 前端源码在 `src/`，单元测试在 `tests/`（vitest + jsdom）。
- 数据层：Rust 单文件 `src-tauri/src/main.rs`，同时支持 SQLite（默认 `%APPDATA%/com.daic.qushi/data/stocks.db`）与 MySQL；连接配置存于 `%APPDATA%/com.daic.qushi/db_config.json`（MySQL 密码加密），首次启动由 `src/views/Setup.vue` 向导写入。表结构版本记录在 `meta.schema_version`；表结构变更必须走 `init_sqlite` / `MYSQL_SCHEMA_SQL` 中的幂等迁移。

## 开发调试规范

### 1. 保持一个后台调试程序

- 开发期间后台始终保留一个运行中的调试实例，不要反复启停；命令在后台执行：

  ```powershell
  npm run tauri dev
  ```

- 同一时间只保留一个调试实例；需要重启（改 Rust 代码等）时先停止旧进程再启动，避免占用数据库连接与端口。
- 前端改动由 Vite 热更新，无需重启；Rust 改动需重启该调试实例。
- 调试实例运行期间不要用脚本直接改写 `stocks.db`，数据库操作一律通过应用内的迁移/命令完成。

### 2. 新增功能必须补回归测试

- 每次新增功能，都要在同一次提交内增加对应的回归测试用例，覆盖主流程与关键边界。
- 用例放在 `tests/unit/<层>/` 下（`utils` / `stores` / `components` / `views` / `api`），沿用现有写法（vitest + `@vue/test-utils`，公共夹具见 `tests/helpers.js`）。
- 后端（Rust）新增命令或迁移时，同步在 `src-tauri` 侧验证（`cargo check`），涉及 SQL 的行为需在真实库副本上验证结果。

### 3. 修改功能必须同步审查回归用例

- 修改既有功能时，先审查相关回归测试用例是否仍与新行为一致：断言、夹具字段、文案、数据结构都要跟随变更更新。
- 若原有语义被取代，更新或删除过时用例，不要靠删断言让测试变绿。
- 提交前必须运行相关回归用例，并保证全量通过：

  ```powershell
  npx vitest run tests/unit/... # 相关用例
  npm test                     # 全量回归
  ```

### 4. 完成标准

- `npm test` 全部通过，`cargo check` 无报错（改动了 Rust 时）。
- 新功能有用例、改动有对应用例、后端迁移在真实库上验证过，方可视为完成。
