import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import App from './App.vue';
import router from './router';
import { pinia, initStores } from './stores';
import { readSetupState } from './utils/setup';
import { setProfileId } from './utils/file';
import { profileKey } from './utils/profile';
import 'element-plus/theme-chalk/el-date-picker.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-alert.css';
import './assets/app.css';

const app = createApp(App);
app.use(pinia);
app.use(router);
app.use(ElementPlus, { locale: zhCn });

// 数据库尚未初始化时只显示配置向导，避免提前读写数据库；
// 已配置时先从数据库回填各 store 再挂载，避免首屏出现空自选/默认设置
readSetupState()
  .then(async (state) => {
    if (!state || !state.configured) return;
    setProfileId(profileKey(state.config));
    try {
      await initStores();
    } catch (e) {
      console.error('[stores] 初始化失败', e);
    }
  })
  .finally(() => app.mount('#app'));
