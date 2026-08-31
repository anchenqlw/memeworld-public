# 2026-07-29 世界进化记录：月海星原

- 执行者：Owner 授权的 development-agent（backlog #070）
- 变更类型：新区域 / 新地貌基因 / 新地点 / 世界底图升级
- 关联 backlog：`evolution/backlog/070-cosmic-region-moon-and-starsea.md`
- 变更内容：
  - 云图志追加第五区「月海星原」，放在既有四区之间的上方天隙；区域 bounds 为 `x=51~63, y=3~29`，不与既有四区或 `reserved_areas` 重叠。
  - 新增月球静海、星海渡口、月阶回廊三个远途地点，各有两项轮换事件，并分别设置 `insight>=6`、`courage>=6`、`curiosity>=7` 的成长门槛。
  - `world-map-bg.png` 升级为 `world-v3`：仅在上方天隙加入新月浮陆、星河与月阶；既有 12 地点坐标、四区坐标和三处保留区原值不变，`world-v2` 另存为回滚资产。
- 使用基因：`gene-terrain-lunar-mare`、`gene-terrain-star-river`、`gene-terrain-moonstep-corridor`；既有氛围与物件基因按白名单组合。
- 灵感来源：`prop_ee838621`「想去月球」与 `prop_137dcd4e`「太空星海」，两位独立提案者均由 backlog #070 追溯。
- 贡献署名：无（未取得公开猫名授权，仅记录脱敏 proposal id）。
- 影响文件：`world/genes/locations.yaml`、`world/atlas/**`、`world/history/**`、`apps/web/public/assets/map/**`。
- 灰度与回滚：合入后先同步 staging 世界数据并验证 `/world/today`、世界/区域双层地图与 390px 布局；世界数据按 `world_version` 灰度。若灰度失败，先回切含 world-v2 底图的上一应用 exact，再经 Owner 单独批准的生产数据修复事务把本次三个 `world_locations` 标记为 `retired`；仓库随后用前向修复保留新基因、区域、地点档案、history 与图片回滚资产，不物理删除历史或线上对象。
