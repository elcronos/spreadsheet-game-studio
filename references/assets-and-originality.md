# Assets and originality

- Generate assets from code: canvas-painted textures, extruded low-poly
  models, string sprites. Gridlock City and Fieldbook use no image, model,
  audio or font files; everything is produced at load time by code in this
  repository (MIT).
- Record every asset family in `assets/MANIFEST.json` with origin, generator
  file and licence. Third-party code (three.js, MIT) is listed there too.
- Do not use ROMs, extracted assets, or anything from a commercial game. Do not
  reproduce a franchise's characters, map layout, missions, dialogue, logos,
  HUD layout, radio stations or vehicle names. "Inspired by an era" means
  technique and mood (low-poly, fog, neon, chase cameras), not content.
- Names in the city (Meridian Bay, Coral Point, Neon Mile, The Meridian,
  Porter Logistics, BayGas, Velocity Motors) were invented for this project.
  Check new names with a web search before shipping if they could collide with
  a real brand.
- Sign text, shop names and liveries are drawn into canvas atlases at runtime
  (`render/textures.ts`, `SignAtlas`).
- Fonts: system font stacks only.
