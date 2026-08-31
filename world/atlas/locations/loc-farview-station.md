---
id: loc-farview-station
name: 望远驿站
genes: [gene-terrain-cloudpeak, gene-atmo-adventurous, gene-art-telescope]
mood_tags: [刺激, 勇敢]
min_attrs: {courage: 5}
region_id: region-heartlands
map: { x: 48, y: 66, priority: 60 }
region_map: { x: 46, y: 75 }
added: 2026-07-13
added_by: world.daily-evolution-v3
status: active
events:
  - id: evt-farview-star-trail
    name: 星迹过境
    desc: 长长的星迹从黄铜望远镜里横穿而过，坚持看完的猫会发现远方云峰正在缓慢移动
    attr_bonus: {insight: 1}
    active_dates: []
  - id: evt-farview-narrow-ledge
    name: 峭壁窄径
    desc: 驿站后的山路只容一只猫侧身通过，走到尽头便能敲响为勇敢旅人准备的小铃
    attr_bonus: {courage: 1}
    active_dates: []
---

中央晴原南缘的一座高崖驿站，屋顶的黄铜望远镜永远朝着云海缺口。驿站没有马，只有几辆能顺风滑行的小云车。墙上钉满远行猫留下的路线纸条，其中最远的一张只画了一颗星和一条长长的箭头。
