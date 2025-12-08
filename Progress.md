# Supply AI Bot — Roadmap v1.2
包含新增目标：产品图片查看（Product Image Retrieval）

作者：ZYHH（Yuhaohua Zheng）


## 1. 核心愿景（Core Vision）

Supply AI Bot 的目标是成为“供应链 AI 数字员工（AI Digital Operator）”，  
通过自然语言即可完成：

- 查询库存、交期、采购状态
- 查看产品图片
- 分析风险、预测断货
- 自动生成报告
- 自动提醒供应链风险
- 自动提供补货建议

最终实现：  
用一句话完成原本需要开 ERP、查 Excel、找采购员才能完成的任务。


## 2. 当前能力（Current Capabilities）

- 定时抓取库存 / 交期预警
- 自动生成 LLM 风险报告
- Discord Embed 美观展示
- 邮件推送报告
- Slash 指令 /report
- 自动登录 / 刷新 token
- 基础数据提取与格式化


## 3. 未来方向（Future Development Directions）

### 3.1 自然语言问答（Natural Language Query Engine）

示例：
@Bot PRD-CHAIR-001 库存是什么？
@Bot 刘洋负责哪些高风险物料？
@Bot 下周可能断货的 SKU 有哪些？

Bot 能自动解析意图、提取 SKU、调用 API、输出自然语言结果。


### 3.2 产品图片查看（Product Image Retrieval）【新增重点】

示例：
@Bot 查看 PRD-TABLE-003
@Bot 给我 PRD-CHAIR-002 的图片

Bot 返回 Embed，包含：

- 产品图片 image_url
- 产品名称与 SKU
- 当前库存 + 安全库存状态
- 风险等级（红橙黄绿）
- 供应商与采购员

意义：更直观的供应链沟通与产品确认。


### 3.3 SKU 智能查询（SKU Intelligence Panel）

查询产品时返回完整信息卡：

- 产品图
- 库存、需求、安全库存
- PO 在途量
- 预计断货日期
- 风险等级
- 供应商 & 采购员信息


### 3.4 智能分析引擎（AI Analytics Engine）

支持分析：

- 断货预测
- 库存趋势
- 供应商交期表现
- 物料风险排序
- 采购员 KPI 分析

示例：
@Bot 下周最危险的三个 SKU？
@Bot 分析供应商稳定性。


### 3.5 智能预警中心（Alert Center）

Bot 自动推送：

- 库存异常（暴降）
- PO 延误
- 需求暴增
- 入库/出库异常

示例：
🔴 MAT-STEEL-001 库存下降 43%
原因：生产领料 12000 件



### 3.6 AI 采购助手（AI Purchasing Agent）

示例：
@Bot 给 MAT-FABRIC-002 一个采购建议

Bot 自动计算：

- 建议采购量
- 断货时间
- 行动建议

并支持：

是否生成采购申请？（PR）


### 3.7 自动化报告（Auto Reporting Suite）

自动生成：

- 日库存报告
- 周供应链预警报告
- 月度供应商表现报告
- 趋势图与总结


### 3.8 SKU 视觉画像（Visual SKU Profile）

未来支持展示：

- 产品图
- 库存趋势图
- 风险趋势
- 历史出入库行为


### 3.9 多渠道协同（Multi-channel Integration）

未来扩展：

- Discord（现已支持）
- WhatsApp（Meta Cloud API）
- Email
- Slack
- Web Dashboard


## 4. 开发顺序（Recommended Development Order）

Phase 1（当前）  
- 自然语言 SKU 查询  
- SKU 自动识别  
- 产品图片查看（新增重点）  
- SKU 基础资料查询  

Phase 2（近期）  
- SKU 全信息卡片  
- 自动风险分析  
- 多 SKU 风险比较  

Phase 3（中期）  
- AI 补货计算器  
- 自动生成 PR/PO  
- 自动预警系统  

Phase 4（长期）  
- 图表化趋势分析  
- KPI 报表  
- 自学习预测模型  
- 企业级 AI 数字员工  


## 5. 最终目标（Ultimate Vision）

Supply AI Bot 将成为：

- 可查库存的助手  
- 可看产品图的视觉机器人  
- 会分析风险的预测模型  
- 会提醒危险的预警系统  
- 会建议采购的智能 Agent  

真正实现：  
从“查表工作” → 变成“AI 自动处理”，  
从“供应链被动应对” → “供应链主动预测”。