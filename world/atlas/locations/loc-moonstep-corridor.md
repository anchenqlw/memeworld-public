---
id: loc-moonstep-corridor
name: 月阶回廊
genes: [gene-terrain-moonstep-corridor, gene-atmo-mysterious, gene-atmo-adventurous, gene-art-postbox]
mood_tags: [神秘, 刺激]
min_attrs: {curiosity: 7}
region_id: region-lunar-starsea
map: { x: 57, y: 24, priority: 75 }
region_map: { x: 48, y: 56 }
added: 2026-07-29
added_by: backlog-070
status: active
events:
  - id: evt-moonstep-corridor-hidden-step
    name: 隐去的月阶
    desc: 前方浮石随云影一块块隐去，好奇的小猫循着星尘余光摸索，终于找到会在脚下亮起的下一阶
    attr_bonus: {curiosity: 1}
    active_dates: []
  - id: evt-moonstep-corridor-letter
    name: 寄往月亮
    desc: 回廊尽头的云间邮筒只在满月开启，把明信片投入其中，小猫会收到来自下一段星路的银色回邮
    attr_bonus: {insight: 1}
    active_dates: []
---

一串沾着月尘的浮石从云海尽头向上延伸，像有人把通往星原的路折成了长长回廊。每一级月阶只在前一枚爪印落稳后亮起，回头时又悄悄藏进薄云。最远处立着一只银色邮筒，专收那些还没想好寄给谁、却很想让月亮读到的信。
