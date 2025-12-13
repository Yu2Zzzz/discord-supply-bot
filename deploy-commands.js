// deploy-commands.js（Guild 版 Slash Commands，立即生效）
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!APP_ID || !GUILD_ID || !TOKEN) {
  console.error('❌ 请在 .env 中配置 DISCORD_APP_ID / DISCORD_GUILD_ID / DISCORD_TOKEN');
  process.exit(1);
}

// 要注册到服务器的 Slash 指令
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('测试 Bot 是否在线'),
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('生成供应链全站深度报告（预警/订单/库存）'),
  new SlashCommandBuilder()
    .setName('import-suppliers')
    .setDescription('批量导入供应商（上传 Excel）')
    .addAttachmentOption(option =>
      option
        .setName('file')
        .setDescription('Excel 文件，需包含供应商编码、名称等列')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('import-materials')
    .setDescription('批量导入物料（上传 Excel）')
    .addAttachmentOption(option =>
      option
        .setName('file')
        .setDescription('Excel 文件，需包含物料编码、名称等列')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('import-products')
    .setDescription('批量导入产品（上传 Excel）')
    .addAttachmentOption(option =>
      option
        .setName('file')
        .setDescription('Excel 文件，需包含产品编码、名称等列')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('开始向指定服务器注册 Slash Commands...');
    console.log('APP_ID:', APP_ID);
    console.log('GUILD_ID:', GUILD_ID);

    // 只在某个服务器注册（guild commands），几乎秒生效
    await rest.put(
      Routes.applicationGuildCommands(APP_ID, GUILD_ID),
      { body: commands }
    );

    console.log('✅ Slash Commands 注册成功：/ping, /report（Guild 级，立即生效）');
  } catch (error) {
    console.error('❌ 注册失败：', error);
  }
})();
