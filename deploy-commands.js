// deploy-commands.js（CommonJS 版本）
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// 定义要注册的全局 Slash 指令
const commands = [
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('生成并显示当前供应链预警报告'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('测试机器人是否在线'),
].map(cmd => cmd.toJSON());

// 使用 Bot Token 初始化 REST 客户端
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('开始注册 Slash Commands...');

    // 全局指令：所有加入这个应用的服务器都会有 /report 和 /ping
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_APP_ID),
      { body: commands }
    );

    console.log('✅ Slash Commands 注册成功：/report, /ping');
  } catch (error) {
    console.error('❌ 注册失败：', error);
  }
})();
