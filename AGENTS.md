# Vibe AStock — 给 Agent 的部署与开发指南

你是来帮使用者部署、使用或改造本仓库的 Agent(Claude Code、Codex、WorkBuddy / CodeBuddy、Muse 一类个人云端 Agent……)。动手前先读完这一页。

> 研究方法论不在这里。研究线程的最高纪律是 [`methodology/constitution.md`](methodology/constitution.md)(研究宪法),
> 研究 SOP 在 [`.agents/skills/`](.agents/skills/),计算函数契约在 [`calc/SPEC.md`](calc/SPEC.md)。产品在每个研究阶段把它们放进提示词,对所有大脑一视同仁;
> 它们约束的是研究线程里的大脑,不是你在本仓库里的工作方式。

## 1. 这是什么

本地运行的 A 股短线复盘与跟踪工作台:浏览器页面 + 本机服务 + 六阶段研究编排器 + Python 取数层 + 确定性计算库(`calc/`)。
短线功能在三个一级栏目:盯盘(实时动态、竞价与盘中)、复盘(情绪复盘、每日复盘)、交易日志;其余栏目(个股深挖、回测、产业资讯、
产业研究、资料库、接入 AI、远程访问、免安装包)与 [Vibe Research](https://github.com/simonlin1212/Vibe-Research) 是同一套底座。
v1.x 是另一套 Python 程序,v2.0.0 起换成现在的代码;老用户在「接入 AI」页「从旧版导入」迁数据。

研究的「大脑」可以换,换了以后受控工具、方法论、校验与合规 gate 都是同一套:

| 大脑 | 接法 | 登录与凭据 |
|------|------|------------|
| Claude Code | 本机 `claude` CLI | 使用者本人在终端用 claude.ai 订阅登录(API key / Bedrock / Vertex 登录不算订阅);产品不读、不存、不复制登录文件 |
| Codex | 本机 `codex` CLI | 使用者本人在终端 `codex login` 用 ChatGPT 账号登录(Codex 里配的 API key 登录不认);同上 |
| WorkBuddy / CodeBuddy | 本机 `codebuddy` CLI(独立 CLI 或 WorkBuddy 桌面版内置) | 使用者本人登录 WorkBuddy;同上 |
| 模型 API | 任意 Chat Completions 兼容接口(模板见 `providers/`) | 页面里填的 key 只存在浏览器 `localStorage`,随请求交给本机服务,不落盘;命令行研究从模板声明的环境变量读 key |

研究线程里的大脑**没有 Shell、没有网络、没有任意文件读写**,只有 5 个受控工具:列文件、读文件、确定性计算、写阶段产物、写报告。
取数由编排器在每个阶段开始前执行完;大脑想收工时,产品先做收工检查,产物缺失或校验不过就把问题清单交回去接着修。

## 2. 帮使用者部署

环境:Node.js ≥ 22.18、Python ≥ 3.11(推荐 3.12)、git。

```bash
git clone https://github.com/simonlin1212/vibe-astock.git
cd vibe-astock
scripts/setup     # Windows:scripts\setup-windows.cmd
scripts/start     # Windows:scripts\start.cmd
```

- `scripts/setup` 创建 `.venv`、安装依赖、生成产品私有层 `.local/` 并跑体检;`scripts/doctor` 可单独再跑(`--json` 给机器读)。
- `scripts/start` 同时拉起本机 API 与页面,健康检查通过后打开 `http://127.0.0.1:5940`。
  默认端口(页面 5940、API 8770)被占用或被系统保留时自动换空闲端口并在终端说明,以终端打印的地址为准;
  换了页面端口时,浏览器里存的模型 API 设置和对话记录按地址分开,要在新地址重新设置(终端会提醒;默认端口空出来后重启就回到原来的);
  要固定端口用 `--port` / `--api-port`(Windows `-Port` / `-ApiPort`)或环境变量 `VRA_UI_PORT` / `VRA_API_PORT`,指定的端口不能用时直接报错。
  启动时提示「已经有一个 Vibe AStock 在运行」:让使用者直接打开那个地址,不要终止别的进程去抢端口。
- 页面打开后到左侧栏最下方的「接入 AI」选大脑并做一次真实对话测试,测试通过才会保存。
  本机 CLI 要先由使用者本人登录(`claude` / `codex login` / `codebuddy`);登录发生在使用者自己的终端和浏览器里,你不代填、不转存任何账号信息。
- Windows 上 WorkBuddy 装在别的盘也会从「已安装的程序」登记或正在运行的 WorkBuddy 里自动找到;
  仍显示「未安装」时:先打开 WorkBuddy 再点「重新检测」,或在「接入 AI」的 WorkBuddy 卡片里填它的安装文件夹,
  或在启动前设环境变量 `CODEBUDDY_BIN` / `CLAUDE_BIN` / `CODEX_BIN`(设了就只认它)。
- 所有私有数据(配置、运行产物、对话、台账、上传资料)都在 `.local/`,已被 git 忽略。不要把它提交、打包或发给任何第三方。
- 使用者不想装 Node / Python / git 时,让他到 Releases 下载免安装包(Windows x64 / Apple 芯片 / Intel Mac),解压后双击 `Start-VibeAStock`;
  数据在包文件夹的 `.local/`,升级 = 新版本解压到新文件夹再把 `.local/` 整个复制过去。包由 `.github/workflows/portable.yml` 构建
  (本机构建:`node scripts/portable/build.mts`;冒烟:`node scripts/portable/smoke.mts <解压出来的目录>`),
  包里 Node / Python 的版本、下载地址和 SHA256 只写在 `scripts/portable/runtimes.json`,升级运行时只改这一个文件。
- 页面每天查一次 GitHub 最新正式版本(只带版本号;没查成隔一小时再试);设环境变量 `VRA_UPDATE_CHECK=0` 完全不联网。

## 3. 在你自己的云端电脑上部署(Muse 一类个人云端 Agent)

最简单的做法:在你自己的云端电脑上装好,用**远程模式**启动,把打印出来的链接发给使用者。不需要连回使用者的电脑,也不需要 SSH。

```bash
git clone https://github.com/simonlin1212/vibe-astock.git
cd vibe-astock
scripts/setup
scripts/start --remote --no-open --public-url https://<平台给页面端口(默认 5940)分配的公网地址>
```

1. 远程模式先把页面打包(首次约半分钟),再在 5940 端口对外提供页面;本机 API(默认 8770,被占用时自动换)仍只听回环地址,不对外。
   页面端口在远程模式下不会自动换(云平台映射的是固定端口):5940 被占用就先停掉占用它的程序,或用 `--port <端口>` 换成平台开放的端口,`--public-url` 也对应那个端口。
2. 启动成功后终端打印「本机打开」和「发给使用者的链接」(`https://…/?access=<访问口令>`)两行。
   不知道公网地址就省掉 `--public-url`,按提示把平台给 5940 端口的 https 地址接上 `/?access=…`;
   知道的话尽量带上:有的平台代理不告诉后台用户走的是 https,带上它访问 cookie 才能确定加 Secure 标记。
3. 把「发给使用者的链接」交给使用者本人。第一次打开后,口令换成浏览器里的 HttpOnly cookie、地址栏里的口令被去掉;
   之后 30 天内直接打开公网地址即可,过期或换了浏览器再用一次完整链接。

- 启动器在前台常驻,Ctrl+C 关闭。要放后台跑,必须让它脱离当前终端会话:Linux 用
  `setsid scripts/start --remote --no-open … > va.log 2>&1 < /dev/null &`;macOS 没有 `setsid`,可用
  `tmux new -d -s va 'scripts/start --remote --no-open …'`(要先装 tmux,`tmux capture-pane -p -t va` 看打印的链接),
  或用平台自带的服务管理。**不要用 `nohup`**:启动器自己处理挂断信号(收到就连同页面和 API 一起退出),
  `nohup` 拦不住,终端会话一结束服务就停。**日志里有访问口令**,别外传。
- **只用 https 公网地址。** 使用者会在页面里填自己的模型 API key,明文 http 会让 key 在网上裸奔;`--public-url` 是公网 http 时启动器会警告。
- 页面只能挂在根地址(`https://xxx/`),不支持挂在子路径(如 `https://xxx/proxy/5940/`)下。
- 访问口令存在 `.local/access.token`(权限 600),重启沿用同一条链接。换新链接、让旧链接失效:先停掉正在运行的服务
  (前台按 Ctrl+C;后台运行时给启动器进程发 SIGTERM,如 `pkill -TERM -f orchestrator/src/startup.ts`,它会一起关掉页面和 API),
  再运行 `scripts/start --remote --rotate-access`;新服务起来后,旧链接和旧 cookie 立即失效。
  平台要自己管口令时,设环境变量 `VRA_ACCESS_TOKEN`(至少 32 位,只含字母、数字、`-`、`_`)。
- 拿到链接的人能用这台云端电脑上的全部功能。链接只交给使用者本人;不要写进仓库、公开频道或分享截图。
- 远程模式下页面不能修改 WorkBuddy 的位置(需要时由你用环境变量 `CODEBUDDY_BIN` 指定后重启);页面里填的模型地址只收
  https 公网域名,不能是 IP 地址、localhost 或内网名字。这只按地址字面拦,解析到内网 IP 的公网域名拦不住 ——
  不要在能访问敏感内网服务的机器上开远程模式。
- 大脑优先用模型 API(使用者在页面里填自己的 key)。云端电脑上没有使用者本人的订阅登录,就不要选本机 CLI 大脑。
- 远程模式目前只支持 macOS / Linux。

## 4. 给你读的接口与架构文档

| 想知道 | 去读 |
|--------|------|
| 短线读数怎么算(情绪、晋级率、连板天梯、封板质量、题材树、题材轮动、盘中快照) | `datasources/` 里 `cn_shortline_*` 端点,目录见 [`datasources/CATALOG.md`](datasources/CATALOG.md) |
| 盯盘、情绪复盘、交易日志的页面与服务;定时提醒(盘前提醒、收盘摘要等) | `desktop/src/verticals/finance/shortline/`、`desktop/src/verticals/finance/journal/`、`orchestrator/src/finance/`(定时任务在 `schedule.ts`) |
| 整体架构、编排器、命令行跑一次研究 | [`orchestrator/README.md`](orchestrator/README.md) |
| 让你自己的 Agent 直接调取数与研究(MCP 8 个工具、本机 HTTP API) | [`orchestrator/README.md`](orchestrator/README.md)「服务层与接口」 |
| 模型接入、provider 模板、兼容性测试 | [`docs/model-access.md`](docs/model-access.md)、[`providers/README.md`](providers/README.md) |
| 取数脚本、端点与数据源 | [`.agents/skills/data-access/SKILL.md`](.agents/skills/data-access/SKILL.md) |
| 确定性计算函数契约 | [`calc/SPEC.md`](calc/SPEC.md) |
| 研究运行的磁盘契约(manifest / evidence / calculations / report) | [`methodology/constitution.md`](methodology/constitution.md) §4 |
| 开发期验证 | [`docs/development-validation.md`](docs/development-validation.md) |

## 5. 改代码前

```bash
cd orchestrator && npm test && npm run typecheck
cd ../desktop && npm test && npm run build
cd .. && python -m pytest calc/tests backtest/tests .agents/skills/data-access/scripts/tests -q && python -m mypy
```

Python 用安装时建的虚拟环境；mypy 的安装与约定见 [`docs/development-validation.md`](docs/development-validation.md)。

- 新写的界面测试用 `desktop/test/helpers/render.ts` 把组件渲染出来，断言用户看得到的内容；不要再新增比对源码文字的断言（「绝不能出现」类规则除外）。写法见同一份文档。
- `orchestrator/src/` 里除 `src/finance/` 外是垂类无关的 Core:不许出现行业词(注释也算),纯净度测试会拦。
- 大脑只能通过受控工具做事:不要给研究线程加 Shell、网络或任意文件访问,也不要为某一种大脑单独开后门。
- 研究宪法和 SOP 改了,要连带检查 `calc/`、validator 与测试是否还对得上。
- 产品名、仓库地址、端口只写在 `orchestrator/src/brand.ts` 和 `desktop/src/verticals/finance/lib/brand.ts`(两份同值)。
  合并上游 Vibe Research(远程名 `upstream`)时保留这两份的值;不是短线专属的底座修复,同时告诉仓库主人要不要回补到 Vibe Research。

## 6. 维护约定(仓库主人定的规则)

### 6.1 对话、资料与回测

- 用户上传资料的原文件只由服务层在本机保存与解析;模型只收到服务端检索命中的正文片段。
  联网不改变资料范围:不得把无关私人资料或密钥发送给搜索服务,不以任意文件读取绕过资料检索边界。
- 使用用户资料的回答必须保留本轮真实引用,格式为 `[资料:<id> p.<页码>]`(非 PDF 可不写页码);
  漏引、错引或引用本轮未召回的资料必须拒绝,不能只靠提示词要求模型自觉引用。
- 对话取数写 `.local/mcp/`,网页留档写 `.local/chat-web/`;对话返回实际工具记录,不声称未执行的操作已完成。
- 回测页只有 Agent 对话入口,不恢复代码、日期、资金、策略参数等旧表单。Agent 先读服务端返回的真实工具目录;
  信息不足只补问,条件齐备才调用正式 `backtest` 工具;工具拒绝、缺参数或失败时不得伪装成完成;`action` 等受控入口不得由模型覆盖。
- 回测结论只能根据本轮真实工具返回生成,完整报告至少包含:回测问题、回测假设、回测逻辑、回测结果。
- 回测与多空辩论完成或部分完成后自动写入用户本地记录。多空辩论归档除各阶段正文、证据数和资料缺口外,
  必须保存每阶段数字复核摘要及全部算式错误明细;中止后重开不得让旧会话回调污染新会话。
- 用户报告正文上限按长报告设计,当前为 10 万字符;不得为通过存储校验而截断已完成报告。

### 6.2 短线与交易日志

- 短线读数、统计和对账都由程序计算,AI 只解读;AI 复盘 / 周报里的每个数字由程序分三级核对(和数据包一致 / 给出能复算的算式 / 没给来源),
  证据编号逐条核对。复盘数据包不得含复盘日之后的数据;每次生成存成新版本,不覆盖旧版本。
- 自己的成交、持仓、成本、盈亏和交易日志只留在本机,**不进 AI**(沿用旧版规矩,和 Vibe Research 不同):
  - 台账种类标 `hiddenFromAssistant: true` 的六种(清仓、交易流水、持有、交易标注、交易日志设置、模式卡),聊天助手的 `read_ledger`
    (也经 MCP 桥给本机 CLI)读不到;带金额 / 数量 / 成本字段的新种类必须标上(有测试守着)。
  - 页面上下文:交易日志各页不登记;持仓页只登记一段说明(`desktop/.../lib/brand.ts` 的 `PERSONAL_TRADES_TO_AI = false`);
    盯盘、候选池(范围是「我的持仓」时)、事件日历去掉只因持仓才出现的股票;AI 周报里的「我的本周交易」只在页面上本机计算,不进数据包。
  - 自选、笔记、论点、判据、复盘可以给 AI。新增功能不得开口子把成交、持仓、金额交给模型。
  - 唯一的例外是用户主动选的:自选 / 持仓的「从截图或表格识别」(`PositionImport`)把选中的文件交给当前 AI 识别,结果核对后手动确认才保存(README「安全与隐私」写明)。
- 隐私模式:金额、股数、自己写的价位遮成 ••••;输入框用密码样式;权益曲线不画(曲线高低就是盈亏大小)。SSR 测试拿不到 `usePrivacyMode` 的开启状态,组件要从父组件收 `hide`。
- 交易日志只算 A 股股票(费用、印花税、T+1 按 A 股股票规则;判断用 `isJournalSymbol`,旧版导入同一条规则),ETF、可转债等其他六位代码和港美股流水只计入持仓、不进交易日志。
- 明日验证从下一个交易日 09:15(开盘集合竞价开始)起不能再写或改;之后写的标「事后」,不进战绩。
- 取不到的读数写明原因,不显示成 0;未来日期和非交易日直接拒绝,不产出「0 家涨停」。
- 「从旧版导入」先预览再导入,导入前自动备份到 `ledger/旧版导入备份-<日期>/`;只读旧目录,不改、不删旧版数据。
- 不荐股:不给买卖建议、目标价或择时信号。异动、涨停样本、情绪档位都写成已经发生的市场现象或分析框架,不写成策略或预测。

### 6.3 模型接入与凭据

- 本机 CLI 大脑一律用使用者自己的登录;产品不读取、复制、软链或转存任何 CLI 的认证文件,也不代填账号密码。
- 订阅与 API 配置都必须先完成真实对话测试,成功才保存;失败不得覆盖当前已生效配置。
- 浏览器 API key 只保存在当前浏览器 `localStorage`,随请求交给本机后端;不得写入仓库、后端配置、运行账本、日志、文档或测试夹具。
- provider 模板存在不等于已接通;接入探针通过也不等于所有业务已验收 —— 只有在实际业务页面跑通的通道才能在对应范围标为已验证。
  未接入时允许浏览栏目,不自动跳转设置。
- 代码审计与发版前审计一律用 Opus 5,在干净上下文里做只读复审;先审一轮,具体发现修复后复验受影响范围。

### 6.4 公开口径

- 本仓库没有单独的官网;产品介绍以 README 为准。
- 本地工作台左下角显示品牌官网 `https://phoenixtree.ai/`(新标签页打开;折叠侧栏保留可访问图标),不扩展为其他推广入口。
- 对外定位:可接入多种 Agent 大脑的本地 A 股短线复盘与跟踪工作台。必须区分「大脑」(本机订阅 Agent 或模型 API)与产品本身,
  不能把产品说成一次 API 问答的包装。
- 不提供 Mac 原生客户端(`.app` / `.dmg`);桌面使用走源码 + 本地浏览器页面或免安装包。
- 新建 Release、删除历史安装包、改仓库简介都需要仓库主人单独授权。
- 用户要求「打开给我看」时打开可见的浏览器页;无头浏览器只用于短时自动化验证,完成后关闭。

### 6.5 公开发布前隐私检查

- 每次公开 push / tag / Release 前同时扫描当前工作树、当前 HEAD 快照和完整 Git 历史,不能只扫未提交 diff。
- 扫描命中必须人工核实,不把测试假 key、固定公开查询参数或安全用例误报成真实凭据;未经核实不得直接放行。
- 产品登录态、API key、`.env`、私钥和本机账号文件必须保持 ignored + untracked,并确认完整历史从未出现;
  旧版本遗留的 `.local/codex-home/` 只能留在本机。
- 发布前同时检查 GitHub Issues / PR / Release 正文、Actions artifacts、截图文字与图片元数据,
  避免密钥、持仓、研报名、本机路径、账号或设备信息从非代码入口泄露。
- README 公开的作者名、GitHub、X、联系邮箱和 Buy Me a Coffee 属有意公开身份;删当前页面不等于删历史。
  历史作者邮箱如需清除必须单独授权重写历史,不得顺手处理。
- GitHub Secret Scanning 与 Push Protection 应保持开启;若平台显示未启用,发布检查必须明确列为待办。

### 6.6 对外内容

- 品牌写法:公司 `Phoenix Tree AI`(有空格),产品 `Vibe AStock`、`Vibe Research`、`a-stock-data`。
- README 不放求职内容;A 股项目的公开材料不提知识星球等付费社群。
- Star 数属于实时数据:写 README、封面或社交资料前必须重新查询 GitHub;可以展示稳定的整数档(如 `2,200+ Stars`),
  不得把旧快照写成当前精确值。

### 6.7 本机下游依赖:judgment(勿破坏)

- 本机另有独立运行中的生产程序 `D:\TRAN\judgment`(A 股判断层,Windows 计划任务
  `judgment_daily` / `judgment_watch` 持续调度),它 vendored 了本仓库历史提交 `6d5812f`
  的本地包 `duanxian/`(存放在 `D:\TRAN\judgment\vendor\duanxian\`,复用本仓库 `.venv`)。
- 升级、重新镜像或"对齐上游"本仓库时,**不得以"上游没有该文件"为由删除
  `judgment/vendor/duanxian/` 或其他 judgment 侧文件**。2026-10 的 v2.1.2 升级
  曾因此把当时的本地包 `duanxian/` 删掉,导致 judgment 断粮 7 个交易日(10-15 ~ 10-23)。
- 动本仓库前若涉及 judgment,先跑:
  `D:\TRAN\vibe-astock\.venv\Scripts\python.exe -X utf8 -m pytest D:\TRAN\judgment\tests\test_duanxian_vendor.py -q`。
- 协作红线详见 `D:\TRAN\judgment\AGENTS.md` 与 `D:\TRAN\judgment\vendor\duanxian\README.md`。
