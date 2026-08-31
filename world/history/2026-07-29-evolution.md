# 2026-07-29 世界进化记录

- 执行者：Owner 授权的发布会话（backlog #056a/b，PR #57，production exact 1061100）
- 变更类型：世界体验升级（旅行意愿与猫舍形态）
- 关联 backlog：`evolution/backlog/` 下 056
- 变更内容（来自玩家反馈，提案者获 50 贡献点）：
  - **许愿目的地（056a）**：云图志每个地点的弹窗多了「许个愿：下次让它去这里」——主人可以为小猫许下一个目的地心愿，下次出门时它会优先往那里去（天性还不够的远方会温柔地说"它还不敢去那么远的地方"）。愿望是一次性的：命中即实现，绕道则保留到实现为止，随时可撤销换一个。
  - **流浪模式（056b）**：设置里多了「流浪模式」开关。打开后首页猫舍化作流浪卡片——有愿望时"正往 X 的方向流浪"，没有愿望时"在云海深处流浪"，今日已有旅行则引导去看明信片。这只是心境的切换：旅行节奏、聊天、面板一切照旧，关闭即回家。
- 使用基因：无（未新增/改动任何世界基因、地点、事件；旅行派发规则新增"主人许愿优先于性格偏好"一条，仍受既有 min_attrs 约束）
- 灵感来源：玩家提案 prop_dc063be1（"别让我的猫在家无所事事了 让它多去旅行和流浪吧"）
- 贡献署名：无（未取得公开署名授权）
- 影响文件：apps/server（schema v34：cats +travel_wish_location_id/+wandering_mode、travel-wish/wandering API、travelService/catService）、tasks/cat/daily-travel.yaml、apps/web（MapPanel 许愿按钮、GameStage 流浪卡片、SettingsPanel 开关）
- 流程备注：056c（流浪时的轻量事件/偶遇/来信）预留后续单独立项。staging 阶段曾因 #066 手工收账账本错位触发 fail-closed 拦截，经 Owner 逐步授权带外收敛后恢复标准流水线（详见 state/DEPLOYMENTS.md 2026-07-29 条目与 ISSUES #65 出口）。
