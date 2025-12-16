// index.js
require('dotenv').config();
console.log('SUPPLY_LOGIN_URL =', process.env.SUPPLY_LOGIN_URL);
console.log('BOT_USERNAME =', process.env.BOT_USERNAME);
// 千万不要打印密码
// console.log('BOT_PASSWORD =', process.env.BOT_PASSWORD && '***');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const { getAuthHeader, resetToken } = require('./tokenManager');

// ========== Groq (OpenAI 兼容接口) ==========
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// 根据配置推断 /data 接口地址（默认把 /warnings 替换成 /data）
function resolveDataUrl() {
  if (process.env.SUPPLY_DATA_URL) return process.env.SUPPLY_DATA_URL;
  if (process.env.SUPPLY_API_URL) {
    return process.env.SUPPLY_API_URL.replace(/warnings(\?.*)?$/i, 'data');
  }
  return null;
}

// 推断 API 基础地址，用于调用 /suppliers
function resolveApiBase() {
  if (process.env.SUPPLY_BASE_URL) {
    return process.env.SUPPLY_BASE_URL
      .replace(/\/api\/api$/i, '/api')
      .replace(/\/api\/$/i, '/api')
      .replace(/\/$/, '');
  }
  if (process.env.SUPPLY_API_URL) {
    try {
      const u = new URL(process.env.SUPPLY_API_URL);
      // 将 /api/warnings → /api
      u.pathname = u.pathname.replace(/\/warnings.*/i, '/api');
      return u
        .toString()
        .replace(/\/api\/api$/i, '/api')
        .replace(/\/api\/$/i, '/api')
        .replace(/\/$/, '');
    } catch (e) {
      return null;
    }
  }
  if (process.env.SUPPLY_LOGIN_URL) {
    try {
      const u = new URL(process.env.SUPPLY_LOGIN_URL);
      // 将 /api/auth/login → /api
      u.pathname = u.pathname.replace(/\/auth\/login.*/i, '/api');
      return u
        .toString()
        .replace(/\/api\/api$/i, '/api')
        .replace(/\/api\/$/i, '/api')
        .replace(/\/$/, '');
    } catch (e) {
      return null;
    }
  }
  return null;
}

// 编码/文本规整
function cleanCode(val) {
  return String(val || '').trim().replace(/\.0$/, '');
}
function cleanText(val) {
  return String(val || '').trim();
}

// 通过编码获取或创建，并返回 id（物料/产品通用）
async function getOrCreateByCode(apiBase, type, code, payload) {
  const normCode = cleanCode(code);
  const authHeader = await getAuthHeader();
  const keyword = encodeURIComponent(normCode);
  const url = `${apiBase}/${type}?page=1&pageSize=1&keyword=${keyword}`;
  const res = await axios.get(url, { headers: { ...authHeader } }).catch(() => null);
  const list = res?.data?.data?.list || res?.data?.list || res?.data || [];
  if (Array.isArray(list) && list.length) {
    return list[0].id || list[0].materialId || list[0].productId || list[0].product_id || list[0].material_id;
  }

  try {
    const createRes = await axios.post(`${apiBase}/${type}`, {
      ...payload,
      materialCode: payload.materialCode || normCode,
      productCode: payload.productCode || normCode,
    }, { headers: { ...authHeader } });
    return createRes.data?.data?.id || createRes.data?.id;
  } catch (err) {
    // 再查一遍，避免并发创建导致 409
    const res2 = await axios.get(url, { headers: { ...authHeader } }).catch(() => null);
    const list2 = res2?.data?.data?.list || res2?.data?.list || res2?.data || [];
    if (Array.isArray(list2) && list2.length) {
      return list2[0].id || list2[0].materialId || list2[0].productId || list2[0].product_id || list2[0].material_id;
    }
    throw err;
  }
}

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

// ========== 构造库存预警 Embed（带公司专属 Emoji） ==========
function buildSupplyEmbed(reportText) {
  // Discord Embed 描述最长 4096 字，做一下安全截断
  const MAX_DESC = 4000;
  let desc = reportText || '（报告内容为空）';
  if (desc.length > MAX_DESC) {
    desc = desc.slice(0, MAX_DESC) + '\n\n…（内容过长，已截断）';
  }

  return new EmbedBuilder()
    .setTitle('<:BHR:1447442981152882793>  供应链深度报告')
    .setDescription(desc)
    .setColor(0x00a2ff)
    .setTimestamp();
}

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

// ========== 1.1 获取全量业务数据（仪表板 /data） ==========
async function fetchDashboardData() {
  const dataUrl = resolveDataUrl();
  if (!dataUrl) {
    console.log('未配置 SUPPLY_DATA_URL，且无法从 SUPPLY_API_URL 推断 /data 路径，跳过全量数据抓取');
    return null;
  }

  try {
    const authHeader = await getAuthHeader();
    const res = await axios.get(dataUrl, {
      headers: {
        ...authHeader,
      },
    });

    let body = res.data;
    console.log('全量数据接口 HTTP 状态码：', res.status);

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.error('解析全量数据 body 字符串为 JSON 失败：', e.message);
        return null;
      }
    }

    if (!body || typeof body !== 'object') {
      console.log('⚠ 全量数据接口返回结构异常');
      return null;
    }

    const summary = {
      orders: Array.isArray(body.orders) ? body.orders.length : 0,
      orderLines: Array.isArray(body.orderLines) ? body.orderLines.length : 0,
      materials: Array.isArray(body.mats) ? body.mats.length : 0,
      purchaseOrders: Array.isArray(body.pos) ? body.pos.length : 0,
      suppliers: Array.isArray(body.suppliers) ? body.suppliers.length : 0,
      products: Array.isArray(body.products) ? body.products.length : 0,
      bom: Array.isArray(body.bom) ? body.bom.length : 0,
    };
    console.log('全量数据集概览：', summary);

    return { raw: body, summary };
  } catch (err) {
    console.error('❌ 获取全量数据失败：', err.response?.status, err.message);

    if (err.response && err.response.status === 401) {
      console.warn('收到 401，重置本地 token，下次将重新登录');
      resetToken();
    }

    if (err.response) {
      console.error('响应内容：', JSON.stringify(err.response.data, null, 2));
    }
    return null;
  }
}

// ========== 2. 用 Groq LLM 生成预警报告 ==========
async function generateSupplyReport() {
  const [alerts, dashboard] = await Promise.all([
    fetchSupplyAlerts(),
    fetchDashboardData(),
  ]);

  const safeAlerts = alerts || [];
  const fullData = dashboard?.raw || null;
  const dataSummary = dashboard?.summary || null;

  // ⚠️ LLM 调用限流：截断上下文，避免超出 6000 TPM
  const truncatedAlerts = safeAlerts.slice(0, 50); // 预警最多 50 条
  const truncatedDataStr = (() => {
    const str = JSON.stringify(fullData || {}, null, 2);
    if (str.length > 2000) return str.slice(0, 2000) + '\n...（截断）';
    return str;
  })();

  if (!process.env.GROQ_API_KEY) {
    let lines = ['【库存/交期预警（简易版，无 LLM）】'];
    if (dataSummary) {
      lines.push(
        `- 订单 ${dataSummary.orders} 条 / 行项目 ${dataSummary.orderLines} 条 / 采购单 ${dataSummary.purchaseOrders} 条`,
        `- 物料 ${dataSummary.materials} 个 / 供应商关系 ${dataSummary.suppliers} 条 / 产品 ${dataSummary.products} 个 / BOM 行 ${dataSummary.bom} 条`
      );
    } else {
      lines.push('- 未能获取全量数据接口，已仅使用预警信息。');
    }

    if (safeAlerts.length) {
      for (const a of safeAlerts) {
        lines.push(
          `- [${a.level}] ${a.sku} | ${a.name} | 类型：${a.warningType} | 采购：${a.buyer} | 提示：${a.message}`
        );
      }
    } else {
      lines.push('- 当前没有检测到任何库存或交期预警。');
    }

    lines.push('（提示：配置 GROQ_API_KEY 后，将自动生成更智能的全站深度解读。）');
    return lines.join('\n');
  }

  const prompt = `
你是供应链计划员。下面是从系统抓取到的全站业务数据（JSON 对象）：
${truncatedDataStr}

这里是预警列表（JSON 数组，可能为空表示没有预警）：
${JSON.stringify(truncatedAlerts, null, 2)}

请输出一份“全站深度解读报告”，要求：
1. 总体概览：订单、物料、采购单、供应商等规模；按预警 level 给出数量。
2. 库存与采购风险：指出库存低于安全库存、在途量不足、BOM 中关键物料风险，并关联对应采购单或供应商。
3. 订单交付风险：关注交期临近且存在物料风险或供应商延迟的订单。
4. 供应商表现：结合 on-time/quality 指标，标出主要供应商及潜在隐患。
5. BOM/产品：如数据包含 BOM，指出关键物料依赖，提示缺料对产品的影响。
6. 预警解读：逐条说明高/中风险预警的业务影响。
7. 行动建议：给出 3-5 条可以直接执行的动作（补货、催交、切换供应商、沟通客户等）。
8. 口径：如数据缺失请说明，不要编造。
9. 输出格式（非常重要）：纯中文文本，不要使用 Markdown 语法、表格或反引号；可用数字或短横线列点；控制在 3400 字以内，适合放入 Discord Embed 描述。
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
    for (const a of safeAlerts) {
      lines.push(
        `- [${a.level}] ${a.sku} | ${a.name} | 类型：${a.warningType} | 采购：${a.buyer} | 提示：${a.message}`
      );
    }
    return lines.join('\n');
  }
}

// ========== 2.1 从 Excel 附件批量导入供应商 ==========
function normalizeSupplierRow(row = {}) {
  const aliases = {
    supplierCode: ['suppliercode', 'supplier_code', 'code', '编码', '供应商编码'],
    name: ['name', '供应商名称', '供应商'],
    category: ['category', '类目'],
    productName: ['productname', 'product_name', '品名', '产品名', '产品'],
    unitPrice: ['unitprice', 'unit_price', '单价', '价格'],
    paymentMethod: ['paymentmethod', 'payment_method', '付款方式', '支付方式'],
    contactPerson: ['contactperson', 'contact_person', '联系人'],
    phone: ['phone', '电话', '手机号', 'mobile'],
    email: ['email', '邮箱', 'mail'],
    address: ['address', '地址'],
    onTimeRate: ['ontimerate', 'on_time_rate', '准时率', '及时率'],
    qualityRate: ['qualityrate', 'quality_rate', '质量率', '合格率'],
    remark: ['remark', '备注'],
    status: ['status', '状态'],
  };

  const lowerRow = {};
  for (const [k, v] of Object.entries(row)) {
    lowerRow[String(k).toLowerCase().trim()] = v;
  }

  const result = {};
  for (const [target, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      if (lowerRow[key] !== undefined && lowerRow[key] !== null && lowerRow[key] !== '') {
        result[target] = lowerRow[key];
        break;
      }
    }
  }

  if (result.unitPrice !== undefined) {
    const num = Number(result.unitPrice);
    result.unitPrice = Number.isFinite(num) ? num : null;
  }
  if (result.onTimeRate !== undefined) {
    const num = Number(result.onTimeRate);
    result.onTimeRate = Number.isFinite(num) ? num : undefined;
  }
  if (result.qualityRate !== undefined) {
    const num = Number(result.qualityRate);
    result.qualityRate = Number.isFinite(num) ? num : undefined;
  }

  return result;
}

async function importSuppliersFromExcel(attachmentUrl) {
  const apiBase = resolveApiBase();
  if (!apiBase) {
    throw new Error('无法推断后端 API 基础地址，请配置 SUPPLY_BASE_URL 或 SUPPLY_API_URL');
  }

  // 下载文件
  const fileRes = await axios.get(attachmentUrl, { responseType: 'arraybuffer' });
  const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 文件没有工作表');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) throw new Error('Excel 中没有数据行');

  const candidates = rows.map(normalizeSupplierRow).filter(r => r.supplierCode && r.name);
  if (!candidates.length) {
    throw new Error('未找到包含供应商编码与名称的有效行，请确认表头/列名');
  }

  const authHeader = await getAuthHeader();
  const summary = {
    total: candidates.length,
    success: 0,
    failed: 0,
    messages: [],
  };

  for (const item of candidates) {
    try {
      await axios.post(`${apiBase}/suppliers`, {
        supplierCode: item.supplierCode,
        name: item.name,
        category: item.category || null,
        productName: item.productName || null,
        unitPrice: item.unitPrice || null,
        paymentMethod: item.paymentMethod || null,
        contactPerson: item.contactPerson || null,
        phone: item.phone || null,
        email: item.email || null,
        address: item.address || null,
        onTimeRate: item.onTimeRate,
        qualityRate: item.qualityRate,
        remark: item.remark || null,
        status: item.status || 'active',
      }, {
        headers: {
          ...authHeader,
        },
      });
      summary.success += 1;
      summary.messages.push(`✅ ${item.supplierCode} ${item.name}`);
    } catch (err) {
      summary.failed += 1;
      const msg = err.response?.data?.message || err.message;
      summary.messages.push(`❌ ${item.supplierCode || ''} ${item.name || ''} -> ${msg}`);
      if (err.response && err.response.status === 401) {
        resetToken();
      }
    }
  }

  return summary;
}

// ========== 2.3 从 Excel 附件批量导入产品 ==========
function normalizeProductRow(row = {}) {
  const aliases = {
    productCode: ['productcode', 'product_code', 'code', '编码', '产品编码', 'sku'],
    name: ['name', '产品名称', '品名'],
    unit: ['unit', '单位'],
    price: ['price', '单价'],
    category: ['category', '类目'],
    status: ['status', '状态'],
    remark: ['remark', '备注'],
  };

  const lowerRow = {};
  for (const [k, v] of Object.entries(row)) {
    lowerRow[String(k).toLowerCase().trim()] = v;
  }

  const result = {};
  for (const [target, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      if (lowerRow[key] !== undefined && lowerRow[key] !== null && lowerRow[key] !== '') {
        result[target] = lowerRow[key];
        break;
      }
    }
  }

  if (result.price !== undefined) {
    const num = Number(result.price);
    result.price = Number.isFinite(num) ? num : null;
  }

  return result;
}

async function importProductsFromExcel(attachmentUrl) {
  const apiBase = resolveApiBase();
  if (!apiBase) {
    throw new Error('无法推断后端 API 基础地址，请配置 SUPPLY_BASE_URL 或 SUPPLY_API_URL');
  }

  const fileRes = await axios.get(attachmentUrl, { responseType: 'arraybuffer' });
  const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 文件没有工作表');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) throw new Error('Excel 中没有数据行');

  const candidates = rows.map(normalizeProductRow).filter(r => r.productCode && r.name);
  if (!candidates.length) throw new Error('未找到包含产品编码与名称的有效行，请确认表头/列名');

  const authHeader = await getAuthHeader();
  const summary = { total: candidates.length, success: 0, failed: 0, messages: [] };

  for (const item of candidates) {
    try {
      await axios.post(`${apiBase}/products`, {
        productCode: item.productCode,
        name: item.name,
        unit: item.unit || 'PCS',
        price: item.price ?? null,
        category: item.category || null,
        status: item.status || 'active',
        remark: item.remark || null,
      }, { headers: { ...authHeader } });

      summary.success += 1;
      summary.messages.push(`✅ ${item.productCode} ${item.name}`);
    } catch (err) {
      summary.failed += 1;
      const msg = err.response?.data?.message || err.message;
      summary.messages.push(`❌ ${item.productCode || ''} ${item.name || ''} -> ${msg}`);
      if (err.response && err.response.status === 401) resetToken();
    }
  }

  return summary;
}

// ========== 2.2 从 Excel 附件批量导入物料 ==========
function normalizeMaterialRow(row = {}) {
  const aliases = {
    materialCode: ['materialcode', 'material_code', 'code', '编码', '物料编码', 'sku'],
    name: ['name', '物料名称', '品名'],
    spec: ['spec', '规格'],
    unit: ['unit', '单位'],
    price: ['price', '单价'],
    safeStock: ['safestock', 'safe_stock', '安全库存', '安全量'],
    leadTime: ['leadtime', 'lead_time', '交期', '周期'],
    buyer: ['buyer', 'purchaser', '采购员', '采购人'],
    category: ['category', '类目'],
    status: ['status', '状态'],
  };

  const lowerRow = {};
  for (const [k, v] of Object.entries(row)) {
    lowerRow[String(k).toLowerCase().trim()] = v;
  }

  const result = {};
  for (const [target, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      if (lowerRow[key] !== undefined && lowerRow[key] !== null && lowerRow[key] !== '') {
        result[target] = lowerRow[key];
        break;
      }
    }
  }

  if (result.price !== undefined) {
    const num = Number(result.price);
    result.price = Number.isFinite(num) ? num : null;
  }
  if (result.safeStock !== undefined) {
    const num = Number(result.safeStock);
    result.safeStock = Number.isFinite(num) ? num : undefined;
  }
  if (result.leadTime !== undefined) {
    const num = Number(result.leadTime);
    result.leadTime = Number.isFinite(num) ? num : undefined;
  }

  return result;
}

async function importMaterialsFromExcel(attachmentUrl) {
  const apiBase = resolveApiBase();
  if (!apiBase) {
    throw new Error('无法推断后端 API 基础地址，请配置 SUPPLY_BASE_URL 或 SUPPLY_API_URL');
  }

  const fileRes = await axios.get(attachmentUrl, { responseType: 'arraybuffer' });
  const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 文件没有工作表');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) throw new Error('Excel 中没有数据行');

  const candidates = rows.map(normalizeMaterialRow).filter(r => r.materialCode && r.name);
  if (!candidates.length) throw new Error('未找到包含物料编码与名称的有效行，请确认表头/列名');

  const authHeader = await getAuthHeader();
  const summary = { total: candidates.length, success: 0, failed: 0, messages: [] };

  for (const item of candidates) {
    try {
      await axios.post(`${apiBase}/materials`, {
        materialCode: item.materialCode,
        name: item.name,
        spec: item.spec || null,
        unit: item.unit || 'PCS',
        price: item.price ?? null,
        safeStock: item.safeStock,
        leadTime: item.leadTime,
        buyer: item.buyer || item.purchaser || null,
        category: item.category || null,
        status: item.status || 'active',
      }, { headers: { ...authHeader } });

      summary.success += 1;
      summary.messages.push(`✅ ${item.materialCode} ${item.name}`);
    } catch (err) {
      summary.failed += 1;
      const msg = err.response?.data?.message || err.message;
      summary.messages.push(`❌ ${item.materialCode || ''} ${item.name || ''} -> ${msg}`);
      if (err.response && err.response.status === 401) resetToken();
    }
  }

  return summary;
}

// ========== 2.3 从 ERP BOM Excel 批量导入产品 + 物料 + BOM ==========
const bomAliases = {
  productCode: ['成品编码', '产品编码', '成品编号', '产品编号', '父件编码', '父项编码', '父项料号', '主件编码'],
  productName: ['成品名称', '产品名称', '父件名称', '父项名称'],
  materialCode: ['物料编码', '子件编码', '原料编码', '原料编号', '子项编码', '子件料号', '子件代码'],
  materialName: ['物料名称', '子件名称', '原料名称', '子项名称'],
  quantity: ['用量', '数量', '基本用量', '需求数量', '总数量', '数 量', '标准用量'],
  unit: ['单位', '基本单位', '库存单位', '子件单位'],
};

function findColumnIndex(headers, keys) {
  const hs = headers.map((h) => String(h || '').trim());
  for (let i = 0; i < hs.length; i++) {
    for (const k of keys) {
      if (hs[i].includes(k)) return i;
    }
  }
  return -1;
}

function parseBomSheet(sheet, filename = '', sheetName = '') {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) return [];

  // 找到包含“子件代码/物料编码”等关键列名的表头行
  const keyHeaders = [...bomAliases.materialCode, '子件代码', '物料编码'];
  let headerRowIdx = 0;
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r].map((v) => String(v || '').trim());
    if (line.some((cell) => keyHeaders.some((k) => cell.includes(k)))) {
      headerRowIdx = r;
      break;
    }
  }

  const headers = rows[headerRowIdx].map((h) => String(h || '').trim());
  const dataRows = rows.slice(headerRowIdx + 1);

  let idxProductCode = findColumnIndex(headers, bomAliases.productCode);
  let idxProductName = findColumnIndex(headers, bomAliases.productName);
  let idxMaterialCode = findColumnIndex(headers, bomAliases.materialCode);
  let idxMaterialName = findColumnIndex(headers, bomAliases.materialName);
  let idxQty = findColumnIndex(headers, bomAliases.quantity);
  let idxUnit = findColumnIndex(headers, bomAliases.unit);
  let idxSpec = headers.indexOf('规格');
  let idxLevel = headers.indexOf('层级');
  let idxMaterialSpec = idxSpec;

  // ERP 表头兜底：子件代码/子件名称/标准用量/子件单位
  if (idxMaterialCode === -1 && headers.includes('子件代码')) idxMaterialCode = headers.indexOf('子件代码');
  if (idxMaterialName === -1 && headers.includes('子件名称')) idxMaterialName = headers.indexOf('子件名称');
  if (idxQty === -1 && headers.includes('标准用量')) idxQty = headers.indexOf('标准用量');
  if (idxUnit === -1 && headers.includes('子件单位')) idxUnit = headers.indexOf('子件单位');
  if (idxProductCode === -1 && headers.includes('产品编码')) idxProductCode = headers.indexOf('产品编码');
  if (idxProductName === -1 && headers.includes('产品名称')) idxProductName = headers.indexOf('产品名称');
  if (idxSpec === -1 && headers.includes('规格')) idxSpec = headers.indexOf('规格');

  if (idxMaterialCode === -1 || idxQty === -1) {
    throw new Error('无法识别关键列（物料编码/数量），请检查表头');
  }

  const fileCode = filename ? filename.split('.')[0].split(' ')[0] : '';
  const sheetCode = sheetName ? sheetName.split(' ')[0] : '';
  const productDefaults = {
    code: cleanCode(fileCode || sheetCode || 'BOM-PRODUCT'),
    name: sheetName || fileCode || 'BOM产品',
  };

  const getLevel = (row) => {
    if (idxLevel !== -1) {
      const v = String(row[idxLevel] || '').trim();
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) return n;
    }
    // 兼容层级值写在前几列（含“-”）
    for (let i = 0; i < Math.min(6, row.length); i++) {
      const v = String(row[i] || '').trim();
      if (!v || v === '-') continue;
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  };

  // 预先探测首个层级=1 的行，锁定产品编码/名称
  const detectedProduct = { ...productDefaults };
  for (const row of dataRows) {
    const levelNum = getLevel(row);
    if (!Number.isNaN(levelNum) && levelNum === 1) {
      const pc1 = cleanCode(idxMaterialCode !== -1 ? row[idxMaterialCode] : '');
      const pn1 = idxMaterialName !== -1 ? cleanText(row[idxMaterialName]) : '';
      const pc2 = idxProductCode !== -1 ? cleanCode(row[idxProductCode]) : '';
      const pn2 = idxProductName !== -1 ? cleanText(row[idxProductName]) : '';
      if (pc1) detectedProduct.code = pc1;
      if (pn1) detectedProduct.name = pn1;
      if (pc2) detectedProduct.code = pc2;
      if (pn2) detectedProduct.name = pn2;
      break;
    }
  }

  let currentProduct = { ...detectedProduct };
  const levelTotals = { 1: 1 }; // 相对整机累计用量
  const data = [];

  for (const row of dataRows) {
    let levelNum = getLevel(row);
    if (levelNum === null) levelNum = 2; // 未标层级按子件

    const materialCode = cleanCode(idxMaterialCode !== -1 ? row[idxMaterialCode] : '');

    // 层级=1：父件，只更新当前产品
    if (!Number.isNaN(levelNum) && levelNum === 1) {
      if (materialCode) currentProduct.code = cleanCode(materialCode);
      const mName = idxMaterialName !== -1 ? cleanText(row[idxMaterialName]) : '';
      if (mName) currentProduct.name = mName;
      const pc2 = idxProductCode !== -1 ? cleanCode(row[idxProductCode]) : '';
      const pn2 = idxProductName !== -1 ? cleanText(row[idxProductName]) : '';
      if (pc2) currentProduct.code = pc2;
      if (pn2) currentProduct.name = pn2;
      Object.keys(levelTotals).forEach((k) => delete levelTotals[k]);
      levelTotals[1] = 1;
      continue;
    }

    const qtyPerParent = Number(row[idxQty]) || 0;
    if (!materialCode || qtyPerParent === 0) continue;

    const parentLevel = levelNum > 1 ? levelNum - 1 : 1;
    const parentTotal = levelTotals[parentLevel] || 1;
    const qty = qtyPerParent * parentTotal;

    // 更新累计用量
    Object.keys(levelTotals)
      .map((k) => parseInt(k, 10))
      .filter((k) => k >= levelNum)
      .forEach((k) => delete levelTotals[k]);
    levelTotals[levelNum] = qty;

    data.push({
      productCode: currentProduct.code || productDefaults.code,
      productName: currentProduct.name || productDefaults.name,
      materialCode,
      materialName: idxMaterialName !== -1 ? cleanText(row[idxMaterialName]) : materialCode,
      spec: idxMaterialSpec !== -1 ? cleanText(row[idxMaterialSpec]) : '',
      qty,
      unit: idxUnit !== -1 ? cleanText(row[idxUnit]) || 'PCS' : 'PCS',
    });
  }
  return data;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const res = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(item);
  }
  return res;
}

async function importProductsAndMaterialsFromBom(attachmentUrl, filename = '') {
  const apiBase = resolveApiBase();
  if (!apiBase) throw new Error('无法推断后端 API 基础地址，请配置 SUPPLY_BASE_URL 或 SUPPLY_API_URL');

  const fileRes = await axios.get(attachmentUrl, { responseType: 'arraybuffer' });
  const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 文件没有工作表');
  const sheet = workbook.Sheets[sheetName];
  const bomRows = parseBomSheet(sheet, filename, sheetName);
  if (!bomRows.length) throw new Error('未解析到有效的 BOM 数据行');

  const products = uniqBy(
    bomRows.map((d) => ({
      productCode: cleanCode(d.productCode),
      name: d.productName || d.productCode,
      unit: 'PCS',
      price: null,
      category: 'BOM导入',
      status: 'active',
    })),
    (p) => p.productCode
  );

  const materials = uniqBy(
    bomRows.map((d) => ({
      materialCode: cleanCode(d.materialCode),
      name: d.materialName || d.materialCode,
      spec: d.spec || '',
      unit: d.unit || 'PCS',
      price: null,
      safeStock: null,
      leadTime: null,
      category: 'BOM物料',
      status: 'active',
    })),
    (m) => m.materialCode
  );

  const authHeader = await getAuthHeader();
  const summary = {
    products: { total: products.length, success: 0, failed: 0, messages: [] },
    materials: { total: materials.length, success: 0, failed: 0, messages: [] },
  };

  const productIdMap = new Map();
  const materialIdMap = new Map();

  // 导入产品
  for (const p of products) {
    try {
      const id = await getOrCreateByCode(apiBase, 'products', p.productCode, {
        productCode: p.productCode,
        name: p.name,
        unit: p.unit,
        price: p.price,
        category: p.category,
        status: p.status,
      });
      productIdMap.set(p.productCode, id);
      summary.products.success += 1;
      summary.products.messages.push(`✅ 产品 ${p.productCode} ${p.name}`);
    } catch (err) {
      summary.products.failed += 1;
      const msg = err.response?.data?.message || err.message;
      summary.products.messages.push(`❌ 产品 ${p.productCode} ${p.name} -> ${msg}`);
      if (err.response?.status === 401) resetToken();
    }
  }

  // 导入物料
  for (const m of materials) {
    try {
      const id = await getOrCreateByCode(apiBase, 'materials', m.materialCode, {
        materialCode: m.materialCode,
        name: m.name,
        spec: m.spec,
        unit: m.unit,
        price: m.price,
        safeStock: m.safeStock,
        leadTime: m.leadTime,
        category: m.category,
        status: m.status,
      });
      materialIdMap.set(m.materialCode, id);
      summary.materials.success += 1;
      summary.materials.messages.push(`✅ 物料 ${m.materialCode} ${m.name}`);
    } catch (err) {
      summary.materials.failed += 1;
      const msg = err.response?.data?.message || err.message;
      summary.materials.messages.push(`❌ 物料 ${m.materialCode} ${m.name} -> ${msg}`);
      if (err.response?.status === 401) resetToken();
    }
  }

  // 兜底：刷新一次物料列表，补全 code → id
  try {
    const resAll = await axios.get(`${apiBase}/materials?page=1&pageSize=2000`, { headers: { ...authHeader } });
    const list = resAll?.data?.data?.list || resAll?.data?.list || [];
    if (Array.isArray(list)) {
      for (const m of list) {
        const code = cleanCode(m.materialCode || m.material_code);
        if (code && m.id) materialIdMap.set(code, m.id);
      }
    }
  } catch (e) {
    console.warn('拉取全量物料列表兜底失败：', e.message);
  }

  // 写入 BOM
  for (const p of products) {
    const pid = productIdMap.get(p.productCode);
    if (!pid) continue;
    const bomMap = new Map();
    const missingCodes = new Set();
    for (const r of bomRows.filter((r) => cleanCode(r.productCode) === p.productCode)) {
      const codeKey = cleanCode(r.materialCode);
      let mid = materialIdMap.get(codeKey);
      if (!mid) {
        const matInfo = materials.find((m) => cleanCode(m.materialCode) === codeKey);
        const payload = matInfo ? {
          materialCode: matInfo.materialCode,
          name: matInfo.name,
          spec: matInfo.spec,
          unit: matInfo.unit,
          price: matInfo.price,
          safeStock: matInfo.safeStock,
          leadTime: matInfo.leadTime,
          category: matInfo.category,
          status: matInfo.status,
        } : {
          materialCode: codeKey,
          name: r.materialName || r.materialCode,
          spec: r.spec || '',
          unit: r.unit || 'PCS',
          category: 'BOM物料',
          status: 'active',
        };
        try {
          mid = await getOrCreateByCode(apiBase, 'materials', codeKey, payload);
          materialIdMap.set(codeKey, mid);
        } catch (e) {
          // 再尝试直接查询接口精确匹配编码
          try {
            const resFind = await axios.get(`${apiBase}/materials?keyword=${encodeURIComponent(codeKey)}&page=1&pageSize=5`, { headers: { ...authHeader } });
            const list = resFind?.data?.data?.list || resFind?.data?.list || [];
            const exact = list.find((m) => cleanCode(m.materialCode || m.material_code) === codeKey);
            if (exact && exact.id) {
              mid = exact.id;
              materialIdMap.set(codeKey, mid);
            } else {
              missingCodes.add(codeKey || r.materialCode || '');
              continue;
            }
          } catch (e2) {
            missingCodes.add(codeKey || r.materialCode || '');
            continue;
          }
        }
      }
      if (!mid) {
        missingCodes.add(codeKey || r.materialCode || '');
        continue;
      }
      const prev = bomMap.get(mid) || 0;
      bomMap.set(mid, prev + (Number(r.qty) || 0));
    }

    const bomItems = Array.from(bomMap.entries())
      .map(([materialId, quantity]) => ({ materialId, quantity }))
      .filter((b) => b.materialId && b.quantity > 0);

    if (!bomItems.length) continue;

    try {
      await axios.put(
        `${apiBase}/products/${pid}/bom`,
        { bomItems },
        { headers: { ...authHeader } }
      );
      summary.products.messages.push(`✅ BOM 更新 ${p.productCode} (${bomItems.length} 条)`);
      if (missingCodes.size) {
        summary.products.messages.push(`⚠️ 未匹配物料: ${Array.from(missingCodes).join(', ')}`);
      }
    } catch (err) {
      summary.products.messages.push(`❌ BOM 更新 ${p.productCode} -> ${err.response?.data?.message || err.message}`);
      if (err.response?.status === 401) resetToken();
    }
  }

  return summary;
}

// ========== 3. Bot 上线时 ==========
client.once('ready', () => {
  console.log(`已登录为 ${client.user.tag}`);

  // 临时：在“表单格式”频道发送导入说明与模板（发送一次后可置顶并删除此块）
  (async () => {
    const FORM_CHANNEL_NAME = '导入表单格式'; // 目标频道名称
    const FORM_CHANNEL_ID = process.env.FORM_CHANNEL_ID; // 可选，指定频道 ID 更稳
    const materialTemplatePath = 'sample-materials.xlsx';
    const supplierTemplatePath = 'sample-suppliers.xlsx';

    try {
      let targetChannel = null;

      // 1) 优先用 env 指定的频道 ID
      if (FORM_CHANNEL_ID) {
        try {
          const ch = await client.channels.fetch(FORM_CHANNEL_ID);
          if (ch && ch.isTextBased && ch.isTextBased()) {
            targetChannel = ch;
          }
        } catch (e) {
          console.warn('按 FORM_CHANNEL_ID 获取频道失败：', e.message);
        }
      }

      // 2) 否则遍历缓存按名称查找
      if (!targetChannel) {
        client.channels.cache.forEach((ch) => {
          if (ch && ch.name === FORM_CHANNEL_NAME && ch.isTextBased && ch.isTextBased()) {
            targetChannel = ch;
          }
        });
      }

      if (!targetChannel) {
        console.warn(`未找到名为「${FORM_CHANNEL_NAME}」的频道，跳过发送模板消息`);
        return;
      }

      const content =
        'Excel 导入说明：/import-materials /import-suppliers /import-bom\n\n' +
        '物料：必填 物料编码、物料名称；可选 规格、单位、单价、安全库存、交期、采购员、类目、状态。\n' +
        '供应商：必填 供应商编码、供应商名称；可选 类目、付款方式、联系人、电话、邮箱、地址、状态。\n' +
        'BOM：直接上传 ERP 导出的某个产品的 BOM（一个产品一张表），包含父件/子件编码、用量、单位等列，AI 会自动识别并导入产品、物料和 BOM。\n' +
        '文件需为 xlsx，数据在首个工作表，表头包含必填列。';

      await targetChannel.send({
        content,
        files: [materialTemplatePath, supplierTemplatePath],
      });

      console.log(`已在「${FORM_CHANNEL_NAME}」频道发送导入格式与模板`);
    } catch (e) {
      console.error('发送导入模板消息失败：', e.message);
    }
  })();

  // 每周一早上 9 点（服务器时间）发送频道消息 + 邮件
  cron.schedule('0 0 9 * * 1', async () => {
    try {
      const report = await generateSupplyReport();

      if (process.env.DISCORD_CHANNEL_ID) {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const embed = buildSupplyEmbed(report);
        await channel.send({ embeds: [embed] });
        console.log('已在频道发送每周供应链深度报告（Embed）');
      } else {
        console.log('未配置 DISCORD_CHANNEL_ID，无法在频道发送每周报告');
      }

      await sendEmailReport('每周供应链深度报告', report);
    } catch (err) {
      console.error('发送定时报告失败：', err.message);
    }
  });
});

// ========== 4. 处理 Slash 指令：/ping 和 /report ==========
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('pong! 🏓');
    return;
  }

  if (interaction.commandName === 'report') {
    try {
      await interaction.deferReply(); // 告诉 Discord 正在处理，避免超时
      const report = await generateSupplyReport();
      const embed = buildSupplyEmbed(report);
      await interaction.editReply({ embeds: [embed] });
      console.log('已通过 /report 返回供应链深度报告（Embed）');
    } catch (err) {
      console.error('处理 /report 失败：', err.message);
      if (interaction.deferred) {
        await interaction.editReply('生成报告时出错了，请稍后再试。');
      } else {
        await interaction.reply('生成报告时出错了，请稍后再试。');
      }
    }
  }

  if (interaction.commandName === 'import-suppliers') {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
      await interaction.reply({ content: '请上传 Excel 文件（包含供应商编码与名称）', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const summary = await importSuppliersFromExcel(attachment.url);
      const lines = [
        `导入完成：成功 ${summary.success} 条，失败 ${summary.failed} 条，合计 ${summary.total} 条。`,
      ];
      for (const msg of summary.messages.slice(0, 20)) {
        lines.push(msg);
      }
      if (summary.messages.length > 20) {
        lines.push(`… 其余 ${summary.messages.length - 20} 条已省略`);
      }
      await interaction.editReply(lines.join('\n'));
      console.log('已完成 Excel 批量导入供应商');
    } catch (err) {
      console.error('处理 /import-suppliers 失败：', err.message);
      const content = `导入失败：${err.message || '未知错误'}`;
      if (interaction.deferred) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  if (interaction.commandName === 'import-materials') {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
      await interaction.reply({ content: '请上传 Excel 文件（包含物料编码与名称）', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const summary = await importMaterialsFromExcel(attachment.url);
      const lines = [
        `导入完成：成功 ${summary.success} 条，失败 ${summary.failed} 条，合计 ${summary.total} 条。`,
      ];
      for (const msg of summary.messages.slice(0, 20)) lines.push(msg);
      if (summary.messages.length > 20) {
        lines.push(`… 其余 ${summary.messages.length - 20} 条已省略`);
      }
      await interaction.editReply(lines.join('\n'));
      console.log('已完成 Excel 批量导入物料');
    } catch (err) {
      console.error('处理 /import-materials 失败：', err.message);
      const content = `导入失败：${err.message || '未知错误'}`;
      if (interaction.deferred) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  if (interaction.commandName === 'import-products') {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
      await interaction.reply({ content: '请上传 Excel 文件（包含产品编码与名称）', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const summary = await importProductsFromExcel(attachment.url);
      const lines = [
        `导入完成：成功 ${summary.success} 条，失败 ${summary.failed} 条，合计 ${summary.total} 条。`,
      ];
      for (const msg of summary.messages.slice(0, 20)) lines.push(msg);
      if (summary.messages.length > 20) {
        lines.push(`… 其余 ${summary.messages.length - 20} 条已省略`);
      }
      await interaction.editReply(lines.join('\n'));
      console.log('已完成 Excel 批量导入产品');
    } catch (err) {
      console.error('处理 /import-products 失败：', err.message);
      const content = `导入失败：${err.message || '未知错误'}`;
      if (interaction.deferred) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  if (interaction.commandName === 'import-bom') {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
      await interaction.reply({ content: '请上传 ERP 导出的 BOM Excel（包含产品/物料编码、数量）', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const summary = await importProductsAndMaterialsFromBom(attachment.url, attachment.name);
      const lines = [
        `产品导入：成功 ${summary.products.success}，失败 ${summary.products.failed}，总计 ${summary.products.total}`,
        `物料导入：成功 ${summary.materials.success}，失败 ${summary.materials.failed}，总计 ${summary.materials.total}`,
      ];
      for (const msg of summary.products.messages.slice(0, 12)) lines.push(msg);
      for (const msg of summary.materials.messages.slice(0, 12)) lines.push(msg);
      const more =
        (summary.products.messages.length > 12 ? summary.products.messages.length - 12 : 0) +
        (summary.materials.messages.length > 12 ? summary.materials.messages.length - 12 : 0);
      if (more > 0) lines.push(`… 其余 ${more} 条已省略`);
      await interaction.editReply(lines.join('\n'));
      console.log('已完成 BOM 批量导入产品与物料');
    } catch (err) {
      console.error('处理 /import-bom 失败：', err.message);
      const content = `导入失败：${err.message || '未知错误'}`;
      if (interaction.deferred) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
});

// ========== 5. 登录 ==========
client.login(process.env.DISCORD_TOKEN);
