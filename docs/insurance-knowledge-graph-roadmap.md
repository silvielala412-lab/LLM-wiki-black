# 保险知识图谱迭代记录

本文档记录 7777 演示服务中“保险七大域知识图谱”的已落地能力和后续待办，避免业务演示过程中遗漏需求。

## 已落地

- 图谱保留原有两种展示能力：
  - 类型视图：按 entity、concept、source 等知识类型着色。
  - 社群视图：按图算法识别出的自然社区着色。
- 新增业务域视图：
  - 按 Product、Customer、Method、Content、Activity、Cases、Compliance、General 着色。
  - 图例展示每个业务域的节点数量。
  - 点击图例中的某个业务域，可筛选只看该域节点；再次点击或点“全部”恢复全图。
- 图谱节点读取 frontmatter 中的 `knowledge_domain`，缺失时 fallback 到 `domain`，再缺失时归为 `general`。

## 后续待办

- 核心三域视图：
  - 一键只看 Product + Customer + Method。
  - 适合演示“产品条款、客户画像、销售方法”三域联动。
- 跨域关系统计：
  - Product -> Customer 数量。
  - Product -> Method 数量。
  - Customer -> Method 数量。
  - 缺失关联数量，例如产品没有客户画像、话术没有产品证据。
- 跨域边样式：
  - 同域边使用普通灰线。
  - 跨域边使用更明显颜色或更粗线。
  - 高价值边，例如 Product -> Method、Customer -> Method，可单独高亮。
- 子域层级：
  - 支持 `taxonomy_path` 展示二级、三级子域。
  - 示例：product/service_benefit/access_list。
- 多域归属：
  - 支持主域 `knowledge_domain` + 次域 `secondary_domains`。
  - 适用于“产品宣传素材”这类同时属于 Product 与 Content 的知识。
- 业务链条过滤：
  - 按获客、触客、邀约、促成、签单、服务、转介绍过滤图谱。
  - 依赖 `business_phase` 字段质量。
- Source 节点治理：
  - 演示时可默认弱化 source 节点，突出业务实体。
  - RAG 调试时保留 source 节点，用于证据追溯。
- 上传解析性能：
  - 当前高质量 OCR + 知识编译链路偏重，业务反馈文档上传后等待时间较长。
  - 暂不作为当前最高优先级；后续可拆成“先入库 source / OCR 明细，后台异步编译实体关系”的两阶段体验。
  - 可继续优化 PDF 分页并发、OCR 缓存、表格规则抽取和队列状态展示。

## 风险提示

- 业务域视图依赖抽取结果中的 `knowledge_domain/domain` 字段。字段标错时，图谱颜色会误导判断。
- 当前多数历史页面可能没有完整业务域字段，需要重新抽取或批量补齐 frontmatter。
- 单主域模型无法表达所有业务材料，后续多域归属是必要增强。
- 当前更高优先级风险是抽取颗粒度偏粗：OCR 原文虽然保留下来了，但实体、属性、claims、关系和知识缺口可能没有覆盖源文档中的关键条目。
