/**
 * 从采购进度表（含多供应商列的 Excel）提取供应商，生成 Bot 可导入的模板文件。
 * 使用：node scripts/build-suppliers-from-progress.js
 * 需：已安装 xlsx（package.json 已包含），确保文件路径正确。
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// 在这里配置你的采购进度表路径（可多个）
const FILES = [
  'C:\\Users\\Howard\\OneDrive - Northeastern University\\Desktop\\7203-20 BOM.xls',
  'C:\\Users\\Howard\\OneDrive - Northeastern University\\Desktop\\7442-02 PI 0526.xlsx',
  'C:\\Users\\Howard\\OneDrive - Northeastern University\\Desktop\\物料采购进度表俞海燕12.4.xlsx',
  'C:\\Users\\Howard\\OneDrive - Northeastern University\\Desktop\\物料采购进度表汪美华12.4.xlsx',
];

// 输出文件
const OUT_FILE = path.resolve(__dirname, '../generated-suppliers.xlsx');

// 解析“x天”获取数字天数
function extractLeadDays(header = '') {
  const m = String(header).match(/(\d+)(?:-\d+)?\s*天/);
  return m ? Number(m[1]) : null;
}

function cleanName(h = '') {
  return String(h).trim().replace(/\s+/g, '');
}

function findHeaderRow(sheet) {
  // 查找包含“客户订单号”表头的行
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && String(cell.v).includes('客户订单号')) {
        return r;
      }
    }
  }
  return range.s.r;
}

function collectSuppliersFromSheet(sheet) {
  const headerRow = findHeaderRow(sheet);
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })];
    headers.push(cell ? cell.v : '');
  }

  // 找到计划完成时间列，之后的列视为供应商列
  const planIdx = headers.findIndex((h) => String(h).includes('计划完成时间'));
  const supplierHeaders = headers.slice(planIdx + 1);

  const suppliers = [];
  supplierHeaders.forEach((h) => {
    const name = cleanName(h);
    if (!name) return;
    const lead = extractLeadDays(h);
    suppliers.push({ name, lead });
  });

  return suppliers;
}

function uniqByName(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

function buildWorkbook(suppliers) {
  const wsData = [
    [
      '供应商编码',
      '供应商名称',
      '类目',
      '付款方式',
      '联系人',
      '电话',
      '邮箱',
      '地址',
      '准时率',
      '质量率',
      '备注',
      '状态',
    ],
  ];

  let idx = 1;
  suppliers.forEach((s) => {
    const code = `SUP-AUTO-${String(idx).padStart(4, '0')}`;
    const remark = s.lead ? `预计交期约${s.lead}天` : '';
    wsData.push([
      code,
      s.name,
      '自动导入',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      remark,
      'active',
    ]);
    idx += 1;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Suppliers');
  return wb;
}

async function main() {
  const all = [];
  FILES.forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      console.warn('文件不存在，跳过：', filePath);
      return;
    }
    const wb = XLSX.readFile(filePath);
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const sups = collectSuppliersFromSheet(sheet);
    all.push(...sups);
  });

  const uniqueSuppliers = uniqByName(all);
  console.log(`共提取供应商 ${uniqueSuppliers.length} 条`);

  const wbOut = buildWorkbook(uniqueSuppliers);
  XLSX.writeFile(wbOut, OUT_FILE);
  console.log('已生成：', OUT_FILE);
}

main().catch((e) => {
  console.error('执行失败：', e);
});
