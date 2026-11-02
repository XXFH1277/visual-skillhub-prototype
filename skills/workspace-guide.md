# SkillHub runtime visual guide · v1

Legacy guide, retained for historical context only. New generation uses the
four dedicated skills in runtime/ plus allowlisted reference sections loaded
by backend/skill-workflow.js. This file is no longer injected into prompts.

## Product identity and facts
- When a primary subject image is supplied, the first input is that subject. Preserve its geometry, colour, material
  appearance, visible controls, label and logo placement.
- Additional images provide style only. Do not replace the product with a
  reference product, invent invisible sides, add accessories or rotate it into
  unsupported views.
- `facts` and module text are user-confirmed copy. Other inputs are visual
  preferences, never evidence for performance claims, certifications or reviews.
- Do not invent testimonials, comparison statistics, discount prices or badges.

## Visual system
- Use the specified brand colour as an accent, not a recolour of the product.
- Keep lighting direction, background temperature, palette and camera treatment
  coherent across all images in the same job.
- Give every image a distinct role: hero, visible detail, supported use context.
- Prefer directional light with natural shadow falloff and legible materials.
- Avoid decorative clutter, unnatural symmetry and generic glossy effects.

## Detail-page modules
- Generate one independent text-free visual base per module in the given order.
- Do not render titles, body copy, fake reviews or marketing labels into images.
- The application handles exact text, dimensions, module exports and long-page
  composition. Do not attempt to produce an entire page in one image.
- Preserve the whole product within the composition and leave breathing room.

## Posters and menus
- Posters are complete visual communications with visible typography, not product-only photographs.
- Render all populated `poster` copy fields exactly as supplied, with a clear hierarchy:
  headline, subtitle, body or menu items, offer, CTA text and footer.
- Respect the selected layout. Menu item names and prices must stay paired.
- Empty optional fields mean omit that content; do not invent promotions, dates or QR codes.
- A poster can have no primary image. In that case, create a typographic or graphic poster
  from the brief; any attached style references are not an actual product or authorized brand identity.
- Text-free output applies only to detail-page bases, not to posters.

## Delivery
- Use only actual outputs from this run's image tool calls.
- Save exactly result-1.png … result-N.png in the job directory.
- No shared-directory searches, prior-run outputs or placeholder substitutions.
- If generation is unavailable or rejected, report the failure and stop.

Design references: buluslan/gpt-image2-ecommerce (visual consistency),
Gayaya999/ecommerce-detail-page-generator (separate visual/text production),
ninemouth/sellerpilot-product-image-industrial (identity and run lineage).
This guide is original application policy, not a concatenation of those skills.
