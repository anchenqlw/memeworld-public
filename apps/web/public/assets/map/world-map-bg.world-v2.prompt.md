# world-v2 世界底图生成留痕

- 生成日期：2026-07-23
- 用途：云图志世界总览底图
- 生成方式：Codex 内置 `image_gen`，以 `world-map-bg.world-v1.png` 为编辑目标
- 模式：`precise-object-edit`
- 原始尺寸：1536 × 1024
- 输出格式：PNG，256 色调色板，无透明通道
- 后处理：`pngquant 3.0.3 --quality=82-96 --speed 1 --strip`
- 生成结果：`world-map-bg.png`（world-v2）
- 回滚结果：`world-map-bg.world-v1.png`（world-v1，`pngquant --quality=70-92 --speed 1 --strip`）
- 随机种子：内置工具未提供显式 seed 参数

## 提示词

```text
Use case: precise-object-edit
Asset type: watercolor game world basemap, exact replacement for a 1536×1024 web map
Input images: Image 1 is the edit target and authoritative composition/style reference.
Primary request: edit only the far eastern edge of the map (approximately the rightmost 12% of the canvas, x > 88%, and vertically around 45%–70%). Naturally extend the eastern edge of the Star Lake green region into a clearly recognizable coastline and calm open sea suitable for the Sunset Tide Bay marker near normalized coordinate x=94, y=56.
Style/medium: preserve the exact soft hand-painted watercolor storybook brushwork, paper grain, pastel blue/green/gold palette, atmospheric haze, scale, and polish of Image 1.
Composition invariants: keep the entire rest of Image 1 unchanged in layout and visual meaning. Preserve all existing regions and landmarks: northern cloud sea, central sunny plains, Star Lake green region, sky-rim floating islands, mountains, villages, paths, rivers, lakes, waterfalls, bridges, cat-shaped landforms, castles, and all floating islands. Preserve the three protected landmark areas around normalized coordinates (24,16), (55,52), and (78,70). Do not move, resize, remove, restyle, or add landmarks outside the east-edge edit zone.
East-edge change: replace the ambiguous sky/cloud background in the target strip with a natural watercolor shoreline that curves from the green land into a small sunset-tinted tidal bay, pale sandy/rocky coast, shallow turquoise water near shore, and deeper soft blue open sea toward the canvas edge. Keep this coastal extension subtle and integrated, with enough calm negative water space for a map marker at x=94,y=56. The coastline must connect organically to the existing eastern green terrain and must not look pasted on.
Constraints: no labels, no letters, no UI markers, no map pins, no borders, no compass, no characters, no real people, no logos, no watermark. Keep a 3:2 landscape canvas and the same top-down oblique illustrated map viewpoint. Output a single polished basemap image.
```
