# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5173，API 默认 `http://localhost:4104`。

```bash
npm test   # 服务端领域测试（27 项）
```

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- 母版、预告、海报、音频、字幕等资产版本和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测
- 预算 / 资产 / 交付审批队列和审计事件
- React 控制台支持项目切换、预算表、风险雷达、审批操作和版权资产视图

## 有期限、可撤销的版权例外（rights exceptions）

当版权冲突无法在交付前及时消除时，**法务**可就单笔冲突发起一份「例外申请」，发行只在被批准的作用域内临时放行：

- **精确作用域，只抑制匹配范围**：冲突按 `版权标签 × 地域 × 平台 × 时间窗` 拆成原子格子；例外绑定 `项目 + 资产 ID + 资产版本 + 地域集合 + 平台集合 + 起止日期`，只覆盖匹配格子。覆盖状态分三档：
  - `open` 真实未覆盖风险（驾驶舱计为真实冲突）
  - `partial` 只有部分格子在例外内（仍计真实风险）
  - `covered` 全部格子由已批准例外抑制（明确标注「已批准例外」，**不等于无冲突**）
- **有期限**：例外必须给出截止日（单次最长 90 天），到期惰性扫描自动失效并恢复风险；窗口到达 / 届满分别记录生效与失效理由。
- **可撤销**：生效中可撤销并填写理由，风险立即恢复。
- **指定审批**：申请写明指定审批人，仅该审批人可批准 / 拒绝（他人 403）；48 小时未处理自动 `timeout`；窗口已过期的申请不能批准。
- **重叠例外**：多个生效例外可覆盖同一格子互为兜底，撤销其中一个不影响其余兜底；只有失去全部覆盖时格子才恢复开放。
- **资产换版**：换版后绑定旧版本的例外立即「版本漂移」失效且不自动迁移，需就新版本重新申请。
- **全球范围**：地域 `*` / 平台 `*` 表示全球 / 全平台覆盖（仍受日期与版本约束）。
- **重复申请**：相同作用域存在 pending/approved 申请时幂等返回原申请；支持 `clientToken` 防重放。拒绝 / 超时 / 撤销后允许重新发起。
- **撤销与生成并发**：交付生成期间若所依赖的例外被撤销（或资产换版），提交前再校验失败并中止；无关变更不影响在途生成。
- **重启恢复**：例外、资产版本覆盖、交付包与状态版本落盘（`server/data/rights-state.json`），重启后重新扫描，并对在途交付按最新版权状态终判。
- **全程留痕**：每张例外带 `history`（created / decided / effective / ineffective / revoked）并写入审计事件流，记录生效与失效理由。
- **交付预检三态**：`clear`（真实无冲突）/ `exceptions`（作用域内全部冲突均在已批准例外内，随包登记例外清单与到期日）/ `blocked`（存在未覆盖格子，禁止生成）。

### API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/rights/overview` | 版权页汇总：真实冲突 / 部分 / 全覆盖 / 待审 / 生效例外 |
| GET | `/api/projects/:id/rights/conflicts` | 逐格子评估结果（open / partial / covered） |
| POST | `/api/projects/:id/rights/exceptions` | 法务发起例外（幂等；重复申请返回 200） |
| POST | `/api/rights/exceptions/:exId/decision` | 指定审批人批准 / 拒绝 |
| POST | `/api/rights/exceptions/:exId/revoke` | 撤销生效例外（级联中止在途交付） |
| POST | `/api/assets/:assetId/bump-version` | 资产换版（旧版例外漂移失效） |
| POST | `/api/projects/:id/delivery/preflight` | 按地域 × 平台 × 日期预检（clear / exceptions / blocked） |
| POST | `/api/projects/:id/delivery/generate` | 生成交付包（OCC 状态版本 + 提交前复核，202） |
| GET | `/api/projects/:id/deliveries` | 交付包状态（generating / ready / failed + 中止理由） |
| POST | `/api/system/recover` | 手动触发重启恢复扫描 |

当前默认使用 JSON 文件落盘 + 内存领域服务，可平滑替换为 PostgreSQL、对象存储、工作流引擎和版权方台账服务。
