// index.js
require('dotenv').config();
console.log('SUPPLY_LOGIN_URL =', process.env.SUPPLY_LOGIN_URL);
console.log('BOT_USERNAME =', process.env.BOT_USERNAME);
// 千万不要打印密码
// console.log('BOT_PASSWORD =', process.env.BOT_PASSWORD && '***');
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const { getAuthHeader, resetToken } = require('./tokenManager');

// ========== Groq (OpenAI 兼容接口) ==========
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ========== 邮件发送工具 ==========
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: false, // 587 一般是 false（TLS）
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendEmailReport(subject, text) {
  if (!process.env.EMAIL_TO) {
    console.log('未配置 EMAIL_TO，跳过发送邮件');
    return;
  }

  try {
    await transporter.sendMail({
      from: `"Supply Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject,
      text,
    });
    console.log('📧 已发送邮件报告');
  } catch (err) {
    console.error('❌ 发送邮件失败：', err.message);
  }
}

// ========== Discord 客户端 ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,         // 使用 Slash 指令必须要这个
    GatewayIntentBits.GuildMessages,  // 用于发频道消息
  ],
});

// ========== 1. 从 Railway 后端获取预警数据 ==========
async function fetchSupplyAlerts() {
  try {
    // 1. 拿 Authorization 头（自动处理登录 & 刷新）
    const authHeader = await getAuthHeader();

    // 2. 用这个 header 调用你的预警接口
    const res = await axios.get(process.env.SUPPLY_API_URL, {
      headers: {
        ...authHeader,
      },
    });

    let body = res.data;

    console.log('预警接口 HTTP 状态码：', res.status);

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.error('解析 body 字符串为 JSON 失败：', e.message);
        return [];
      }
    }

    console.log('预警接口原始返回（已解析）：', JSON.stringify(body, null, 2));

    if (!body || body.success !== true || !Array.isArray(body.data)) {
      console.log('⚠ 预警接口返回结构异常或 data 不是数组');
      return [];
    }

    const raw = body.data;
    console.log('解析后的预警条目数：', raw.length);
    if (!raw.length) return [];

    const alerts = raw.map((item) => ({
      id: item.id,
      level: item.level,
      sku: item.materialCode,
      name: item.materialName,
      buyer: item.buyer,
      warningType: item.warningType,
      message: item.message,
      createdAt: item.createdAt,
    }));

    return alerts;
  } catch (err) {
    console.error('❌ 获取库存预警失败：', err.response?.status, err.message);

    // 如果是 401，重置 token，下次会强制重新登录
    if (err.response && err.response.status === 401) {
      console.warn('收到 401，重置本地 token，下次将重新登录');
      resetToken();
    }

    if (err.response) {
      console.error('响应内容：', JSON.stringify(err.response.data, null, 2));
    }
    return [];
  }
}

// ========== 2. 用 Groq LLM 生成预警报告 ==========
async function generateSupplyReport() {
  const alerts = await fetchSupplyAlerts();

  if (!alerts || alerts.length === 0) {
    return '当前没有检测到任何库存或交期预警。';
  }

  if (!process.env.GROQ_API_KEY) {
    let lines = ['【库存/交期预警（简易版，无 LLM）】'];
    for (const a of alerts) {
      lines.push(
        `- [${a.level}] ${a.sku} | ${a.name} | 类型：${a.warningType} | 采购：${a.buyer} | 提示：${a.message}`
      );
    }
    lines.push('（提示：配置 GROQ_API_KEY 后，将自动生成更智能的采购与行动建议。）');
    return lines.join('\n');
  }

  const prompt = `
你是供应链计划员。下面是从系统抓取到的库存/交期预警列表（JSON 数组）：
${JSON.stringify(alerts, null, 2)}

字段含义：
- level: "RED"（高风险）、"ORANGE"（中风险）、"YELLOW"（低风险）
- sku: 物料编码
- name: 物料名称
- buyer: 采购负责人
- warningType: 
    - "stock_shortage" = 库存不足 / 低于安全库存
    - "delivery_delay" = 供应商交期可能延期
- message: 文本描述，可能包含类似“库存不足，当前8000，需求45000”的信息
- createdAt: 预警创建时间

请你用中文输出一份清晰的供应链预警报告，要求：

1. 总体概览：
   - 按 level 统计各级别预警数量（高/中/低风险各多少条）。
   - 简要评估当前供应链整体风险情况。

2. 【需要优先处理的物料清单】：
   - 按风险从高到低列出预警物料。
   - 每条包括：level、物料编码、名称、buyer、warningType、简要说明（可参考 message）。
   - 对于 warningType = "stock_shortage" 的条目：
       - 如果 message 中包含“当前库存、需求量”等数字，请尝试读出来并用自然语言描述。
   - 对于 warningType = "delivery_delay" 的条目：
       - 说明可能的影响（订单延误、排产受影响等）。

3. 【行动建议】：
   - 给出 3 条左右的行动建议。

4. 输出格式：
   - 使用 Markdown，以小标题和列表形式展示。
  `;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
    });

    return (completion.choices[0].message.content || '').trim();
  } catch (err) {
    console.error('生成 LLM 报告失败：', err.message);
    let lines = ['生成智能报告失败，以下为原始预警数据：'];
    for (const a of alerts) {
      lines.push(
        `- [${a.level}] ${a.sku} | ${a.name} | 类型：${a.warningType} | 采购：${a.buyer} | 提示：${a.message}`
      );
    }
    return lines.join('\n');
  }
}

// ========== 3. Bot 上线时 ==========
client.once('clientReady', () => {
  console.log(`已登录为 ${client.user.tag}`);

  // 每周一早上 9 点（服务器时间）发送频道消息 + 邮件
  cron.schedule('0 0 9 * * 1', async () => {
    try {
      const report = await generateSupplyReport();

      if (process.env.DISCORD_CHANNEL_ID) {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        await channel.send(report);
        console.log('已在频道发送每周库存预警报告');
      } else {
        console.log('未配置 DISCORD_CHANNEL_ID，无法在频道发送每周报告');
      }

      await sendEmailReport('每周库存预警报告', report);
    } catch (err) {
      console.error('发送定时报告失败：', err.message);
    }
  });
});

// ========== 4. 处理 Slash 指令：/ping 和 /report ==========
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply('pong! 🏓');
      return;
    }

    if (interaction.commandName === 'report') {
      // 先告诉 Discord 我在处理，避免 3 秒超时
      await interaction.deferReply();

      const report = await generateSupplyReport();
      await interaction.editReply(report);
      console.log('已通过 /report 返回预警报告');
      return;
    }
  } catch (err) {
    console.error('处理命令失败：', err);

    const errorMsg = '生成报告时出错了，请稍后再试。';

    // 如果之前已经 deferReply 或回复过，就用 editReply
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply(errorMsg)
        .catch((e) => console.error('编辑回复失败：', e));
    } else if (interaction.isRepliable()) {
      // 否则就直接 reply 一次
      await interaction
        .reply({ content: errorMsg, ephemeral: true })
        .catch((e) => console.error('回复交互失败：', e));
    }
  }
});

// ========== 5. 登录 ==========
client.login(process.env.DISCORD_TOKEN);
