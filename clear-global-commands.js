// 清除全局 Slash Commands（避免重复）
require('dotenv').config();
const { REST, Routes } = require('discord.js');

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('🚮 开始清除全局 Slash Commands...');

    await rest.put(
      Routes.applicationCommands(APP_ID),
      { body: [] } // empty array = delete all global commands
    );

    console.log('✅ 全局 Slash Commands 已全部清除！');
  } catch (error) {
    console.error('❌ 清除失败：', error);
  }
})();
