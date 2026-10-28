# 宿主侧扩展接线

此目录是宿主拥有的适配代码，UI 包仍在独立 `open-ai-canvas-expand` 仓库。它可以导入宿主组件、服务和 store；扩展 npm 包只能收到视图数据、组件槽和回调。

- `generation-workbench-adapter.tsx`：图片/视频原路由的接入、包 CSS、关闭开关和渲染失败回退。
- `generation-workbench-surface.tsx`：把原控制器投影为扩展视图，复用宿主组件；局部编辑通过同一 runtime 提交，不另建轮询器。
- `generation-api.ts`：注入宿主 http 的 expand-openapi 客户端、冻结提交与会话取消。
- `workbench-session.ts`：账号作用域内的草稿、冻结请求、锁与异步失效。
- `director-canvas-handoff.ts` / `use-director-canvas-handoff.ts`：通过原素材、真实画布和 Agent 交接，不新增 Agent 执行链路。
- `session-cleanup.ts`：宿主切换账号时的统一清理入口。
- `workbench-prompt-tools.tsx`：原富文本工具引用、风格接口薄呈现与失效校验；原后端仍负责 Prompt 展开。
- `director-skills.ts` / `workbench-director-skills.tsx`：真实场景与技能身份映射、原技能库入口；技能在首轮请求持久化前完整冻结。

扩展图片、视频工作台按用户要求移除麦克风与录音/转写入口；不修改原生共享录音组件或其他页面，视频编导音频素材上传继续按宿主能力提供。

`pages/workbench/image-workbench-page.tsx` 继续是唯一共享生成控制器，原视图与扩展视图共用它。不要复制整份上游页面到此目录；上游生成、鉴权和计费修复必须继续落在同一个控制器中。

构建时设置 `VITE_OPEN_AI_CANVAS_EXPAND_ENABLED=false` 可回到宿主原视图与原 API；原后台图片/视频功能开关仍决定路由可用性。运行期间仅发生扩展渲染异常时，保留当前控制器与 expand-openapi runtime，避免丢失待确认提交。后端仍处理已受理扩展任务的后台素材登记。

更新上游后检查两个页面入口、画布交接 hook、用户会话清理及共享控制器的调用合同，并运行 `test/open-ai-canvas-expand/` 与原任务/素材同步回归。前后端公共合同不能仅因 UI 回退而撤销。

控制器恢复保留原身份、逐项核验素材，列表失败可重试，报价清除过期金额，迟到恢复不覆盖新编辑。v1.7.2 上游删除旧蒙版弹窗后，扩展复用 `canvas-node-region-edit-dialog.tsx`，通过 `buildRegionEditPrompt` 编译编号区域，沿用原图加透明蒙版的提交协议。可选忙碌、关闭确认和待确认恢复接口迁移到新弹窗；扩展提交期间不卸载，失败保留框选区域、正文和设置，宿主默认调用行为保留。

Agent 的 `skillIds` 未提供时沿用普通会话选择及上游失效技能清理；空数组表示明确通用编导。编导指定的技能集合在当前账号、画布目录未就绪或技能缺失时暂停，不能缩减集合后发送。已有交接回到原画布，已消费的首轮不重发。验收记录按宿主规则另记于 `pending-test.mdx`。
