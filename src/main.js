import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import App from './App.vue';
import router from './router';
import { pinia, initStores } from './stores';
import { readSetupState } from './utils/setup';
import 'element-plus/theme-chalk/el-date-picker.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-alert.css';
import './assets/app.css';

const app = createApp(App);
app.use(pinia);
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');

// 数据库尚未初始化时只显示配置向导，避免提前读写数据库
readSetupState().then((state) => {
  if (state && state.configured) initStores();
});
