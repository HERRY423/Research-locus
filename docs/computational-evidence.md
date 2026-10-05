# 计算回执与 DOI 分层核验

本地共审现在可以接收 BioNexus 多供体差异表达 bundle，以及绑定代码、输入、输出摘要的 CSV／notebook 计算回执。它核对导入材料并保留来源与失败；不会启动科学计算，也不会把文件完整性当作科学验证。

## 在页面中使用

选中论断，打开「证据文件」下的「计算回执与引用核验」，或从当前审查页点击「导入／查看核验」。每项操作立即显示处理中，成功后保存为该论断的独立证据记录，失败会显示原因。刷新后可以重新查看记录。

### CSV、notebook 与普通计算输出

1. 展开「把 CSV／notebook 输出登记为计算回执」。填写实际工具及版本、运行结果；版本不明时写 `unknown`，状态不明时保留未知。
2. 分别选择代码文件、输入文件与输出文件。代码一个，输入及输出各最多 32 个；整包最多 64 个文件，原始字节合计最多 10 MiB。
3. 写明运行摘要及纳入理由；失败或部分完成时补充实际失败记录。声明已完成必须提供输出，失败可以没有输出。
4. 点击「校验并导入计算回执」。页面从选中的原始字节计算 SHA-256；保留 BOM、换行与其他原始字节，不先转成文本再计算摘要。

代码、输入、输出在包内分别使用 `code/`、`inputs/`、`outputs/` 路径。相同类别的重复文件名与大小写歧义会被拒绝。所有文件仅来自显式选择；服务器不按 manifest 中的路径读取本机文件。

输出 CSV／TSV 仅显示截取的 UTF-8 纯文本。notebook 只读取 v4 notebook 已保存的 `text/plain`、文本流及错误输出；HTML、JavaScript、图像与代码不执行。完整原始字节保存在回执包中，预览不是完整内容。

### BioNexus 多供体差异表达

展开「导入 BioNexus 多供体差异表达 bundle」，选择含 `manifest.json` 的 bundle 文件夹，或选择已经封装的回执 JSON；不能同时选择两种来源。

支持原生 `bionexus.de-shadow-bundle.v1`。适配器读取工具版本、数据来源声明、`audit.json`、审查结果及原始 `findings`／`checks`，保留执行回执与失败记录。支持的来源为 `SYNTHETIC_DEMO` 与 `USER_SUPPLIED_UNVERIFIED`，它们在页面中可见。

- 基础 manifest 必须正确绑定 `audit.json`。带 `bionexus.de-shadow-integrity.v1` 的 bundle 还必须核对 `audit.json`、`audit-full.md`、`REVIEW.md` 三份报告摘要；旧版缺少这组绑定时明确显示 `LEGACY_LIMITED`。
- 原生 manifest 的 `inputs` 可绑定样本表、设计信息、`analysis_code`、`de_table` 和 `execution_record` 等材料。选择这些原始文件才能核对其字节；未提供的字节保持 `NOT_PROVIDED`。
- 原始 bundle 引用 `execution_record` 时，适配器使用其路径和摘要。额外选择执行回执时填写包内相对路径；它与 manifest 已声明的路径不一致会被拒绝。
- manifest 已绑定的执行回执显示 `MANIFEST_BOUND`；仅由上传者追加的回执显示 `UPLOADER_ASSOCIATED`。二者均不是经过认证的执行证明。
- 从执行回执的 `fit_status` 读取完成、失败或部分完成状态；保留 `failures`、`errors` 和 `error`。失败但没有详细记录时明确说明细节未提供，不能悄悄变成成功。

`ROBUST_PASS` 是 BioNexus 原始审查结果。它不代表 Research Locus 重新运行了差异表达，也不能替代收敛、供体独立性、模型设计或科学结论的独立核验。只上传审查 bundle 而没有执行回执时，执行状态保持未知。

BioNexus 版本是审查工具版本；实际拟合方法和版本分别读取执行回执中的 `method` 与 `method_version`。缺少时显示 `NOT_PROVIDED`，不能用 BioNexus 的版本代替 DESeq2／PyDESeq2 等分析方法的版本。

## 绑定关系与证据边界

| 页面／字段 | 已完成的核对 | 没有证明的事 |
| --- | --- | --- |
| `artifactByteIntegrity=CHECKED` | 已上传文件的原始字节摘要 | 文件来源可信、计算正确 |
| `binding.status=COMPLETE_BYTES` | 声明的代码、至少一个输入及至少一个输出均有匹配字节；三者关系另有摘要 | 该代码确实生成这些输出 |
| `binding.status=INCOMPLETE` | 缺失项和已提供项分别记录 | 不能用部分文件冒充完整绑定 |
| `execution=NOT_VERIFIED` | 保存运行状态及失败声明 | 没有独立重跑或认证运行日志 |
| `producer=NOT_VERIFIED` | 保存生产者／工具版本声明 | 没有认证生产者身份 |
| `scientific=NOT_ASSESSED` | 保留待评估边界 | 没有验证生物学结论或外推有效性 |

哈希绑定只能核对提供的材料及其声明关系；文件与 manifest 同时被替换时，没有独立锚点就不能识别协调替换。工具版本、成功状态和失败记录均标注为生产者声明。

计算回执导入属于新增论断证据，会触发本论断和明确依赖下游的局部重审；无关论断保留有效记录。补证清单同时显示未完整绑定、未独立验证执行等缺口。即使字节绑定完整，证据上限仍为 `NOT_ASSESSED`。

## DOI：分别回答三层问题

填写 DOI，可选填预期标题、发表年及完整有序作者名单。选择「查询公开注册元数据」后，服务端只把规范化 DOI 发送至固定的 Crossref／DataCite 公共接口；预期元数据与会话材料留在本地比对。「仅检查格式」完全不联网。

| 层级 | 结果 | 解释 |
| --- | --- | --- |
| 格式 `syntax` | `valid` / `invalid` | 仅判断是否符合支持的 DOI 写法 |
| 存在性 `existence` | `found` / `not_found` / `unknown` / `not_checked` | 只覆盖本次实际查询的公共注册库 |
| 元数据 `metadata`、`fieldChecks` | `match` / `mismatch` / `incomplete` / `not_checked` | 标题、年份、作者逐字段比对；没有预期字段就不能宣称该字段一致 |
| 内容支持 `contentSupport` | `not_checked` | 不读取正文判断引用是否支持论断 |
| 科学有效性 `scientificValidity` | `not_checked` | 不评价论文方法、可重复性或结论正确性 |

`not_found` 不表示 DOI 在全球不存在。网络失败、超时、非预期响应或无法解析记录均保留未知；格式正确绝不补成“引用已核验”。标题仅作 Unicode、大小写与空白归一化后的精确比较；作者按完整姓名与顺序比较，缩写、姓氏或 `et al.` 不能冒充匹配；多个出版年份可能需要人工核对。

结果保留实际执行的 `actualLayers`、检查时间、各来源 URL、HTTP 状态、响应 SHA-256、检索到的元数据以及失败原因。Agent 必须按这些字段报告核验到了哪一层，不能把尝试请求写成已成功核验。

DOI 记录不自动成为“论文正文支持论断”的证据。补证清单保留引用内容支持的缺口；研究者仍需提供可定位的原文与相关数据。

## 接口与本地包格式

普通模型状态（包括历史快照）只返回回执摘要，不带输出预览、原始审查正文或执行记录。显式读取选定回执 URI 时保留完整原件，并提供 `evidenceText.chunks`：每段包含文件定位、原始字节 hash、文本及截断标记。设计候选须使用该段的完整 `locator`（如 `artifact:audit.json`）和逐字摘录。视图限制为每文件 16,384 字符、合计 65,536 字符；省略或截断不代表材料没有相关证据，原件没有被改写。

计算导入使用研究者 UI 操作 `import_computational_receipt`，携带 `claimId`、`receipt`、`rationale` 和当前版本。模型不能冒充研究者提交此操作；本版没有开放 Agent 计算回执导入工具。

普通封装的 `receipt` 结构：

```text
format: generic
files: [{ path: 包内相对路径, contentBase64: 原始字节的标准 base64 }]
manifest:
  schema: locus.computational-receipt.v1
  tool: { name, version }
  status: succeeded | failed | partial | unknown
  code: { path?, sha256? }
  inputs: [{ path?, sha256? }]
  outputs: [{ path?, sha256? }]
  failures: [{ stage, message }]
  summary: 可选摘要
```

BioNexus 封装使用 `format: bionexus-de`、同样的 `files` 和可选 `executionReceiptPath`；必须保留原始 `manifest.json` 字节，不另传普通 manifest。解析器拒绝路径穿越、大小写冲突、摘要不符及不支持的 schema。材料和标准化结果都持久保存在独立 Resource；回放保留导入事件和相关重审变化。

### 本地封装辅助脚本

`scripts/package-computational-receipt.mjs` 只封装明确选择的文件，不运行分析、不查询网络，也不按 manifest 路径自动读取其他文件。下例中的路径需要替换为研究者自己的材料：

```powershell
node scripts/package-computational-receipt.mjs --bundle "C:\Research\de-bundle" --out "C:\Research\locus-receipt.json" --file "sample-sheet.csv=C:\Research\sample-sheet.csv" --file "analysis.R=C:\Research\analysis.R" --file "de-results.csv=C:\Research\de-results.csv" --file "execution.json=C:\Research\execution.json" --execution-receipt "execution.json"
```

`--bundle` 只默认选择 `manifest.json`、`audit.json`，以及存在的 `audit-full.md`、`REVIEW.md`。额外材料必须逐项 `--file "包内名称=本地文件"`；包内名称需与原始 manifest 的名称一致。`--execution-receipt` 只指定已经通过 `--file` 加入的执行回执，不会自动读取文件。

普通计算回执使用已经填写实际摘要的 manifest：

```powershell
node scripts/package-computational-receipt.mjs --generic-manifest "C:\Research\receipt-manifest.json" --out "C:\Research\locus-generic.json" --file "code/analysis.R=C:\Research\analysis.R" --file "inputs/counts.csv=C:\Research\counts.csv" --file "outputs/results.csv=C:\Research\results.csv"
```

需要交互计算原始字节摘要时优先使用页面普通回执表单。脚本拒绝覆盖已有输出、符号链接重定向、路径歧义和超过 64 文件／10 MiB 的选择；生成 `PACKAGED_NOT_EXECUTED` 仅表示封装完成。导入时还会重新检查 schema、摘要与绑定关系。

`locus.verify_doi` 接受 `sessionId`、`claimId`、`expectedRevision`、`doi`、可选 `mode: syntax_only | registry` 及 `expected: { title?, year?, authors? }`。服务端实际查询后才记录结果，不接受 Agent 自报核验状态。读取当前版本，避免把已过期任务的结果写入新材料；超时后先刷新查找已保存记录，不盲目重复提交。

## 验收范围

本轮具体结果见 [计算证据接入验收记录](computational-evidence-acceptance.md)。

自动测试覆盖字节绑定、结构与失败记录、注册查询分层、异常降级、持久化及界面安全呈现；本地浏览器和隔离打包验证以实际验收记录为准。合成 fixture、成功导入和哈希相符均不能被称为真实科研数据复现。实际 ChatGPT 宿主、生产者执行真实性、真实多供体统计结果和科学有效性需要分别验收。
