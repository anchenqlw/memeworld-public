# world-v3 世界底图生成留痕

- 生成日期：2026-07-29
- 用途：云图志世界总览底图，第五区「月海星原」
- 生成方式：Codex 内置 `image_gen`，以 `world-map-bg.png`（world-v2）为编辑目标
- 模式：`precise-object-edit`
- 原始与输出尺寸：1536 × 1024
- 输出格式：PNG，256 色调色板，无透明通道
- 后处理：`pngquant 3.0.3 --quality=82-96 --speed 1 --strip`
- 生成结果：`world-map-bg.png`（world-v3，918KB）
- 回滚结果：`world-map-bg.world-v2.png`（world-v2，917KB）
- 随机种子：内置工具未提供显式 seed 参数

## 提示词

```text
Use case: precise-object-edit
Asset type: watercolor game world basemap, exact replacement for a 1536×1024 web map
Input images: Image 1 is the edit target and authoritative composition/style reference.
Primary request: edit only the upper central sky gap, approximately normalized x=51%–63% and y=3%–29%, to add a compact fifth celestial region named conceptually “lunar sea and starfield” (do not render this or any text). It must read as a natural extension of a cloud-borne cat world: a small pearly crescent-moon floating landform near x=54,y=8, a luminous indigo star-river crossing around x=60,y=12, and a tiny moon-dust stepping-stone corridor descending toward x=57,y=25. Connect them with a delicate trail of silver-blue stardust and thin clouds so the region feels reachable from the world below, not outer-space science fiction.
Style/medium: preserve the exact soft hand-painted watercolor storybook brushwork, paper grain, pastel blue/green/gold palette, atmospheric haze, top-down oblique map viewpoint, scale, and polish of Image 1. Add gentle twilight indigo, lavender, pearl silver, and muted gold only inside the edit zone.
Composition invariants: keep the entire rest of Image 1 unchanged in layout and visual meaning. Preserve every existing region and landmark, especially the lavender cat tree island at upper left, hot-air balloon left of the edit zone, central mountains below, green floating island and castle to the right, eastern snowy land, southern coast and forest, all paths, rivers, bridges, waterfalls, villages, cat-shaped forms, and the coastline. Do not move, resize, remove, restyle, or duplicate existing landmarks. Preserve protected areas around normalized (24,16), (55,52), and (78,70). Keep clear visual anchor space at normalized coordinates (54,8), (60,12), and (57,25) for HTML location pins.
Constraints: no labels, no letters, no numbers, no UI markers, no map pins, no borders, no compass, no realistic people, no characters, no spacecraft, no rockets, no astronaut suits, no logos, no watermark. Keep a 3:2 landscape canvas. Output one polished basemap image.
```
