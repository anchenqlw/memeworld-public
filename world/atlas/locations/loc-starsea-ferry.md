---
id: loc-starsea-ferry
name: 星海渡口
genes: [gene-terrain-star-river, gene-atmo-adventurous, gene-atmo-nostalgic, gene-art-bell]
mood_tags: [勇敢, 怀旧]
min_attrs: {courage: 6}
region_id: region-lunar-starsea
map: { x: 60, y: 9, priority: 85 }
region_map: { x: 72, y: 36 }
added: 2026-07-29
added_by: backlog-070
status: active
events:
  - id: evt-starsea-ferry-light-current
    name: 星潮换向
    desc: 银蓝光流忽然逆转，守渡猫敲响小铃，旅猫必须踩准三颗亮星才能平稳越过这段天河
    attr_bonus: {courage: 1}
    active_dates: []
  - id: evt-starsea-ferry-old-ticket
    name: 旧星票
    desc: 渡口木匣里压着一张没有终点的旧票，背面褪色爪印指向一条只在深夜显形的支流
    attr_bonus: {curiosity: 1}
    active_dates: []
---

星光在月海边缘汇成一条缓慢天河，渡口便搭在最安静的一段光流上。没有船只，只有会随星潮明灭的踏石和一枚提醒换向的小铃。许多远行猫把旧票夹在铃架下，票面不写终点，只留下一句约定：越过长夜，也别忘记回家的云。
